// ue-gate.mjs — what every build/test entry point shares: the verdict line, spawning .bat files correctly,
// streaming a child while keeping its output for diagnosis, the dry-run renderer, and the ownership gate
// (ue-owner.mjs: an agent touches only what its session started, and waits for everything else).

import { spawn, spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canBuild, canLaunch, snapshot, whoAmI } from './ue-owner.mjs';

const IsWindows = process.platform === 'win32';
const MjsDir = dirname(fileURLToPath(import.meta.url));

/**
 * The closed set of endings. DEFERRED is contention (an editor is open, the lock is held) — nothing was
 * built or tested, and the report must say «not compiled», never «done». DRY-RUN ran nothing.
 */
export const Verdict = { Ok: 'OK', Failed: 'FAILED', Deferred: 'DEFERRED', DryRun: 'DRY-RUN' };

/** The verdict line. Pure, so the self-test pins its format. */
export const verdictLine = (kind, outcome, code) => `RESULT: ${kind} ${outcome} (exit ${code})`;

/**
 * The ONLY exit of a verdict script: prints the verdict as the LAST line, then exits. The exit code does not
 * survive a pipe (`ue-compile.cmd | tail` reports tail's status), the last line does.
 */
export function exitWith(kind, outcome, code) {
	console.log(verdictLine(kind, outcome, code));
	process.exit(code);
}

// --- quoting -------------------------------------------------------------------------------------------
// `cmd /c` with a quoted script path (C:\Program Files\...) AND a quoted argument strips the outer quote pair
// off the middle of the line: the batch never runs, the exit code is not a build failure, and the caller
// reports «build done» over nothing. One pre-quoted line + windowsVerbatimArguments is the shape cmd
// documents. Node also refuses to spawn a .bat/.cmd directly (EINVAL), so cmd.exe is mandatory.
export function winQuote(s) {
	return '"' + String(s).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1') + '"';
}
export function winCommandLine(file, args = []) {
	return '"' + [file, ...args].map(winQuote).join(' ') + '"';
}

/** How Node (libuv) quotes an argument for an .exe it spawns directly — for printing the exact line. */
export function quoteIfNeeded(s) {
	const str = String(s);
	if (str === '') return '""';
	if (!/[\s"]/.test(str)) return str;
	return winQuote(str);
}

/** The exact command line a spawn will run, for --dry-run. `bat` = goes through cmd.exe. */
export function renderCommand(file, args, { bat = false } = {}) {
	if (bat && IsWindows) return `cmd.exe /d /s /c ${winCommandLine(file, args)}`;
	return [file, ...args].map(quoteIfNeeded).join(' ');
}

/** Runs a .bat (Windows) / .sh synchronously with inherited stdio. */
export function runBat(batPath, args = [], options = {}) {
	if (!IsWindows) return spawnSync(batPath, args, { stdio: 'inherit', windowsHide: true, ...options });
	return spawnSync('cmd.exe', ['/d', '/s', '/c', winCommandLine(batPath, args)], {
		stdio: 'inherit',
		windowsHide: true,
		windowsVerbatimArguments: true,
		...options,
	});
}

/**
 * Runs a .bat or an .exe, echoing its output live AND keeping it for diagnosis.
 * @returns {Promise<{status: number, output: string}>}
 */
export function runStreaming(file, args = [], { bat = false, env } = {}) {
	return new Promise((resolvePromise) => {
		const child =
			bat && IsWindows
				? spawn('cmd.exe', ['/d', '/s', '/c', winCommandLine(file, args)], { windowsHide: true, windowsVerbatimArguments: true, env })
				: spawn(file, args, { windowsHide: true, env });
		const chunks = [];
		const take = (stream, sink) =>
			stream.on('data', (d) => {
				chunks.push(d);
				sink.write(d);
			});
		take(child.stdout, process.stdout);
		take(child.stderr, process.stderr);
		child.on('error', (e) => {
			chunks.push(Buffer.from(`\nspawn error: ${e.message}\n`));
		});
		child.on('close', (code) => resolvePromise({ status: code ?? 1, output: Buffer.concat(chunks).toString('utf8') }));
	});
}

// --- build output diagnosis ----------------------------------------------------------------------------

/** Compiler / linker / UHT error lines out of a build log, deduplicated, at most `max`. Pure. */
export function errorLines(output, max = 12) {
	const re = /(\berror [A-Z]{1,3}\d{3,5}\b|\bfatal error\b|\): error\b|: error:|: Error: |^ERROR: |\bUnable to build while Live Coding is active)/;
	const seen = new Set();
	const out = [];
	for (const raw of String(output).split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || !re.test(line) || seen.has(line)) continue;
		seen.add(line);
		out.push(line);
		if (out.length >= max) break;
	}
	return out;
}

/** Known build failure causes with the action each needs. Pure. */
export function buildHints(output) {
	const text = String(output);
	const hints = [];
	if (/Unable to build while Live Coding is active/i.test(text)) {
		hints.push('Live Coding is active in an open editor of this project: UBT refuses to build (and compiled nothing). Either press Ctrl+Alt+F11 in that editor (only .cpp body changes) or have the editor closed, then build again.');
	}
	if (/LNK1104|cannot open (output )?file .*\.(dll|exe|lib)|being used by another process/i.test(text)) {
		hints.push('A module binary is locked: an editor (or a game) of this project still holds the DLLs. Close it (ue-stop-editor.cmd for an agent editor), wait, build again.');
	}
	if (/Low on memory|Killed process/i.test(text)) {
		hints.push('UBA killed actions for low memory: lower UE_MAX_PARALLEL_ACTIONS (e.g. 6); a clangd background index (compile_commands.json) is a common memory hog.');
	}
	return hints;
}

/** Prints the summary block that precedes a FAILED verdict. */
export function printBuildFailure(output) {
	const errors = errorLines(output);
	console.log('');
	console.log('---- build failure summary ----');
	if (errors.length) for (const l of errors) console.log(`  ${l}`);
	else console.log('  (no compiler/linker error line found - read the output above)');
	for (const h of buildHints(output)) console.log(`HINT: ${h}`);
}

// --- ownership ------------------------------------------------------------------------------------------------
// No broker: ue-owner.mjs reads the machine itself. This session stops only what it started (the marker in
// <project>/Saved/AgentEditors); everything else - a person's editor, another session's, a build that is not
// ours - is waited for, never touched.

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));

/**
 * Asks ue-owner whether this session may build (`kind` 'build') or start an editor (`kind` 'launch') for the
 * project, re-asking for up to `wait` seconds while the answer is «not ours: wait». An answer that names a step
 * of our own (close my editor first, reuse my editor) or a failed process query returns at once.
 * @returns {{ok: boolean, reason?: string, closeFirst?: number[], reuse?: number, snap?: object[], me?: object|null}}
 */
export function gate(kind, projectRoot, { wait = 0, editorTarget = true, alongside = false } = {}) {
	const deadline = Date.now() + Math.max(0, Number(wait) || 0) * 1000;
	let told = false;
	for (;;) {
		const snap = snapshot();
		if (!snap) return { ok: false, reason: 'the process query failed - nothing on the machine can be attributed, so nothing is started blind' };
		const me = whoAmI(snap);
		const v = kind === 'build' ? canBuild(snap, me, projectRoot, { editorTarget }) : canLaunch(snap, me, projectRoot, { alongside });
		if (v.ok || v.closeFirst || v.reuse || Date.now() >= deadline) return { ...v, snap, me };
		if (!told) {
			console.log(`waiting up to ${wait}s: ${v.reason}`);
			told = true;
		}
		sleepSync(Math.min(15000, deadline - Date.now()));
	}
}

/** What a gate would check — for --dry-run. */
export function gatePlan(kind, { wait = 0 } = {}) {
	const what = kind === 'build'
		? 'no editor of this project holds the DLLs (mine: close it first; not mine: wait), no build that is not ours runs'
		: 'no editor of this project runs, no editor of another project that is not ours runs, no build that is not ours runs';
	return [`ue-owner ${kind === 'build' ? 'can-build' : 'can-launch'}: ${what}`, `waits up to ${wait}s for what is not ours, then DEFERRED`];
}

// --- self-test -------------------------------------------------------------------------------------------

/** Entry points whose every exit must carry a verdict. */
const VerdictScripts = ['ue-build-flow.mjs', 'ue-compile.mjs', 'ue-rebuild.mjs', 'ue-game-build.mjs', 'ue-test.mjs'];

export function selftest() {
	const fail = [];
	const eq = (a, b, m) => {
		if (JSON.stringify(a) !== JSON.stringify(b)) fail.push(`${m}: got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`);
	};

	eq(verdictLine('compile', Verdict.Failed, 6), 'RESULT: compile FAILED (exit 6)', 'verdict line format');

	for (const script of VerdictScripts) {
		const p = join(MjsDir, script);
		if (!existsSync(p)) {
			fail.push(`${script} missing`);
			continue;
		}
		const src = readFileSync(p, 'utf8');
		for (const line of src.split(/\r?\n/)) {
			if (line.includes('process.exit(') && !line.includes('verdict-exempt')) fail.push(`${script}: exit without a verdict -> ${line.trim()}`);
		}
		if (!src.includes('exitWith(')) fail.push(`${script}: never exits through exitWith`);
	}

	const log = [
		'Building TestEditor...',
		'C:\\p\\Source\\A.cpp(12): error C2039: \'GetDisplayNameText\': is not a member of \'UClass\'',
		'C:\\p\\Source\\A.cpp(12): error C2039: \'GetDisplayNameText\': is not a member of \'UClass\'',
		'LINK : fatal error LNK1104: cannot open file \'C:\\p\\Binaries\\Win64\\UnrealEditor-Test.dll\'',
		'C:\\p\\Source\\B.h(40): Error: Unrecognized type \'FFoo\' - type must be a UCLASS, USTRUCT, UENUM, or global delegate.',
		'0 error(s), 2 warning(s)',
		'Unable to build while Live Coding is active. Exit the editor and game, or press Ctrl+Alt+F11 if iterating on code in the editor or game',
	].join('\r\n');
	const errs = errorLines(log);
	eq(errs.length, 4, 'error lines: C2039 once (dedup), LNK1104, UHT Error, Live Coding; not "0 error(s)"');
	eq(buildHints(log).length, 2, 'hints: live coding + locked DLL');
	eq(buildHints('Building... done').length, 0, 'no hint on a clean log');

	eq(quoteIfNeeded('-ExecCmds=Automation RunTests A+B; Quit'), '"-ExecCmds=Automation RunTests A+B; Quit"', 'an arg with a space is quoted');
	eq(quoteIfNeeded('-unattended'), '-unattended', 'a plain arg is not');

	// A batch file under a path WITH A SPACE must actually run: driven against real cmd.exe, both directions —
	// the naive form must fail here, or this test proves nothing about the fixed one.
	if (IsWindows) {
		const dir = mkdtempSync(join(tmpdir(), 'ue gate space '));
		const bat = join(dir, 'probe.cmd');
		writeFileSync(bat, '@echo off\r\necho ARGS:%1 %2\r\n', 'utf8');
		const args = ['-Project="C:/a b/x.uproject"', 'Development'];
		const naive = spawnSync('cmd.exe', ['/c', bat, ...args], { encoding: 'utf8', windowsHide: true });
		if ((naive.stdout ?? '').includes('ARGS:')) fail.push('the naive spawn now works - the space test no longer proves anything');
		const fixed = spawnSync('cmd.exe', ['/d', '/s', '/c', winCommandLine(bat, args)], { encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true });
		if (!(fixed.stdout ?? '').includes('ARGS:')) fail.push(`a batch under a path with a space did not run: ${JSON.stringify(fixed.stdout)}`);
		rmSync(dir, { recursive: true, force: true });
	}

	eq(gatePlan('build', { wait: 5 }).length, 2, 'the dry-run plan names the check and the wait');
	return fail;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)) && process.argv.includes('--selftest')) {
	const fail = selftest();
	for (const f of fail) console.log(`  FAIL ${f}`);
	console.log(fail.length ? `ue-gate selftest: ${fail.length} failed` : 'ue-gate selftest: passed');
	process.exit(fail.length ? 1 : 0); // verdict-exempt: a self-test, not a build
}
