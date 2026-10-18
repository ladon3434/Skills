// ue-build-flow.mjs — the one build sequence behind ue-compile, ue-rebuild and ue-game-build.
//
//   resolve project + engine -> editor guard (per project) -> ownership gate (ue-owner) -> UBT -> verdict line
//
// The guard never stops an editor itself. Closing an editor and building are separate steps (and separate
// tool calls: the editor-guard PreToolUse hook judges a command line before it runs, so «close && build» in one
// line is seen with the editor still alive). An editor this session did not start is never closed by a build:
// it is waited for.

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { exitWith, gate, gatePlan, printBuildFailure, renderCommand, runStreaming, Verdict } from './ue-gate.mjs';
import { describeEditors, editorsOfProject } from './ue-proc.mjs';
import { parseArgs, resolveTools } from './ue-tools.mjs';

const Modes = {
	compile: { kind: 'compile', targetType: 'Editor', config: 'Development', editorBlocks: true, destructive: false },
	rebuild: { kind: 'rebuild', targetType: 'Editor', config: 'Development', editorBlocks: true, destructive: true },
	game: { kind: 'game-build', targetType: 'Game', config: 'Shipping', editorBlocks: false, destructive: false },
};

const Spec = {
	project: {},
	target: {},
	config: {},
	wait: { default: '600' },
	'dry-run': { type: 'bool' },
	help: { type: 'bool' },
};

/**
 * What stands in the way of building an editor target, per project. Pure over the probe result.
 * @returns {{blockers: string[], warnings: string[]}}
 */
export function editorVerdict(editors, { editorBlocks, destructive }) {
	const blockers = [];
	const warnings = [];
	if (!editorBlocks) {
		const line = describeEditors(editors);
		if (line) warnings.push(`editor(s) running (${line}) - fine for a non-editor target, which builds separate binaries.`);
		return { blockers, warnings };
	}
	if (editors.gui.length) {
		blockers.push(
			`a GUI editor of this project is open (pid ${editors.gui.join(', ')}) and locks the module DLLs. ` +
				'For a change inside .cpp function bodies use Live Coding in that editor (Ctrl+Alt+F11). Close it first only if this session started it; otherwise ask the person.',
		);
	}
	if (editors.headless.length) {
		blockers.push(
			`a headless editor of this project runs (pid ${editors.headless.join(', ')}) and locks the module DLLs. ` +
				'If this session started it, stop it with ue-stop-editor.cmd in a SEPARATE tool call, then build again; otherwise wait for its owner.',
		);
	}
	if (!editors.precise) {
		(destructive ? blockers : warnings).push('process command lines cannot be read, so an editor of this project may be running unseen.');
	}
	if (editors.opaque > 0) {
		(destructive ? blockers : warnings).push(`${editors.opaque} editor process(es) do not report a command line - one may be this project's and hold its DLLs.`);
	}
	return { blockers, warnings };
}

/**
 * UBT arguments that compile only the given source files: object files, no link. A header also recompiles every
 * .cpp that includes it. Each file is compiled on its own, without the module's shared PCH, so a missing #include
 * that a full build forgives shows up here. Pure.
 */
export function singleFileArgs(files) {
	const args = files.map((f) => `-SingleFile=${f}`);
	if (files.some((f) => /^\.(h|hpp|inl)$/i.test(extname(f)))) args.push('-SingleFileBuildDependents');
	return args;
}

/** The UBT invocations a mode runs, in order. Pure over `tools`. */
export function buildSteps(mode, tools, { target, config, extra = [], files = [] }) {
	const base = [target, tools.hostPlatform, config, `-Project=${tools.project}`];
	const build = [...base, '-WaitMutex', ...tools.parallelArgs, ...singleFileArgs(files)];
	if (mode.kind === 'rebuild') {
		const clean = tools.unrealClean ? { file: tools.unrealClean, args: base } : { file: tools.unrealBuild, args: [...base, '-Clean'] };
		return [
			{ label: 'clean', ...clean },
			{ label: 'build -DisableUnity', file: tools.unrealBuild, args: [...build, '-DisableUnity', ...extra] },
		];
	}
	return [{ label: 'build', file: tools.unrealBuild, args: [...build, ...extra] }];
}

function usage(mode) {
	const name = { compile: 'ue-compile', rebuild: 'ue-rebuild', 'game-build': 'ue-game-build' }[mode.kind];
	const files = mode.kind === 'compile' ? ' [<file.cpp|file.h> ...]' : '';
	console.log(`usage: ${name}.cmd${files} [--project <file.uproject|dir>] [--target <Name>] [--config <Cfg>] [--wait <s>] [--dry-run] [-- <extra UBT args>]`);
	if (files) console.log('  files    compile only these (no link); a header also recompiles the .cpp files that include it');
	console.log(`  target default: the project's ${mode.targetType} target (Source/*.Target.cs); config default: ${mode.config}`);
	console.log('  --wait   seconds to wait for a build or an editor that is not ours (default 600)');
	console.log('  --dry-run prints the exact command lines and what would block, runs nothing');
	console.log(`  Ends with: RESULT: ${mode.kind} <OK|FAILED|DEFERRED|DRY-RUN> (exit N)`);
}

/** Saved/ue-build-test/: the game-build logs and status, inside the project's own ignored Saved tree. */
function gameLogDir(tools) {
	return join(tools.projectDir, 'Saved', 'ue-build-test');
}

export async function runBuild(modeName, argv) {
	const mode = Modes[modeName];
	const kind = mode.kind;
	const args = parseArgs(argv, Spec);
	if (args.help) {
		usage(mode);
		process.exit(0); // verdict-exempt: help, nothing ran
	}
	const dry = Boolean(args['dry-run']);
	const wait = Number(args.wait);
	if (!Number.isFinite(wait) || wait < 0) {
		usage(mode);
		exitWith(kind, Verdict.Failed, 2);
	}

	const tools = resolveTools({ project: args.project });
	if (!tools.ok) {
		console.log(tools.error);
		exitWith(kind, Verdict.Failed, 1);
	}
	const target = args.target ?? (mode.targetType === 'Editor' ? tools.editorTarget : tools.gameTarget);
	if (!target) {
		console.log(`ERROR: no ${mode.targetType} target in ${join(tools.projectDir, 'Source')}\\*.Target.cs (a Blueprint-only project has nothing to compile). Pass --target <Name> if it is named unusually.`);
		exitWith(kind, Verdict.Failed, 1);
	}
	const config = args.config ?? mode.config;
	const files = args._.map((f) => resolve(f));
	if (files.length && kind !== 'compile') {
		console.log(`ERROR: single files are compiled by ue-compile only; ${kind} takes no file arguments.`);
		exitWith(kind, Verdict.Failed, 2);
	}
	for (const f of files) {
		if (!existsSync(f)) {
			console.log(`ERROR: no such file: ${f}`);
			exitWith(kind, Verdict.Failed, 2);
		}
		const rel = relative(tools.projectDir, f);
		if (rel.startsWith('..') || !/^(Source|Plugins)[\\/]/i.test(rel)) {
			// UBT drops a file that is not part of the target without a word and builds the whole target instead.
			console.log(`WARNING: ${f} is outside the project's Source/ and Plugins/ - UBT ignores files that are not in the target.`);
		}
	}
	const steps = buildSteps(mode, tools, { target, config, extra: args.rest, files });

	console.log(`Project : ${tools.project}`);
	console.log(`Engine  : ${tools.unrealHome} (UE ${tools.ueVersion})`);
	console.log(`Target  : ${target} ${tools.hostPlatform} ${config}${kind === 'rebuild' ? ' (clean + -DisableUnity)' : ''}${files.length ? ` (${files.length} file(s), compile only, no link)` : ''}`);

	const editors = editorsOfProject(tools.projectDir);
	const { blockers, warnings } = editorVerdict(editors, mode);
	for (const w of warnings) console.log(`WARNING: ${w}`);
	if (existsSync(join(tools.projectDir, 'compile_commands.json'))) {
		console.log('WARNING: compile_commands.json is present - a clangd background index can eat tens of GB and send UBA into its "Low on memory" loop.');
	}

	if (dry) {
		console.log('');
		for (const b of blockers) console.log(`WOULD DEFER: ${b}`);
		console.log('Gate    :');
		for (const l of gatePlan('build', { wait })) console.log(`  ${l}`);
		for (const s of steps) {
			console.log(`Step ${s.label}:`);
			console.log(`  ${renderCommand(s.file, s.args, { bat: true })}`);
		}
		if (kind === 'game-build') console.log(`Log     : ${gameLogDir(tools)}\\game-build-<stamp>.log (last 14 kept)`);
		exitWith(kind, Verdict.DryRun, 0);
	}

	if (blockers.length) {
		const owner = gate('build', tools.projectDir, { wait: 0, editorTarget: mode.editorBlocks });
		console.log('');
		for (const b of blockers) console.log(`DEFERRED: ${b}`);
		if (!owner.ok && owner.reason) console.log(`OWNER: ${owner.reason}`);
		console.log('Nothing was compiled.');
		exitWith(kind, Verdict.Deferred, 1);
	}

	// A non-editor target builds separate binaries: editors do not matter to it, only a build that is not ours.
	const owner = gate('build', tools.projectDir, { wait, editorTarget: mode.editorBlocks });
	if (!owner.ok) {
		console.log('');
		console.log(`DEFERRED: ${owner.reason}`);
		console.log('Nothing was compiled. Wait or do other work; never stop an editor or a build this session did not start.');
		exitWith(kind, Verdict.Deferred, 1);
	}

	const started = Date.now();
	let output = '';
	let status = 0;
	for (const s of steps) {
		console.log('');
		console.log(`---- ${s.label}: ${renderCommand(s.file, s.args, { bat: true })}`);
		const r = await runStreaming(s.file, s.args, { bat: true });
		output += r.output;
		status = r.status;
		if (status !== 0) break;
	}
	const seconds = Math.round((Date.now() - started) / 1000);

	if (kind === 'game-build') {
		const dir = gameLogDir(tools);
		mkdirSync(dir, { recursive: true });
		const stamp = new Date(started).toISOString().replace(/[:T]/g, '-').slice(0, 16);
		const logFile = join(dir, `game-build-${stamp}.log`);
		writeFileSync(logFile, output);
		for (const f of readdirSync(dir).filter((f) => /^game-build-.*\.log$/.test(f)).sort().slice(0, -14)) rmSync(join(dir, f), { force: true });
		writeFileSync(
			join(dir, 'game-build-status.json'),
			JSON.stringify({ result: status === 0 ? 'GREEN' : 'RED', target, config, when: new Date(started).toISOString(), durationSec: seconds, log: logFile }, null, '\t') + '\n',
		);
		console.log(`Log: ${logFile}`);
	}

	if (status !== 0) {
		printBuildFailure(output);
		exitWith(kind, Verdict.Failed, status);
	}
	console.log('');
	console.log(files.length ? `${files.length} file(s) of ${target} compiled in ${seconds}s (not linked: a full ue-compile is still due).` : `${target} ${tools.hostPlatform} ${config} built in ${seconds}s.`);
	exitWith(kind, Verdict.Ok, 0);
}
