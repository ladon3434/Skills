// ue-test — one-shot headless automation run for the nearest project. Ends with
//   RESULT: tests <OK|FAILED|DEFERRED|DRY-RUN> (exit N)
//
// Usage: ue-test.cmd [filter] [--project p] [--wait s] [--timeout min] [--attempts n] [--quarantine file]
//                    [--verbose] [--dry-run] [-- extra editor args]
//   filter   RunTests filter, '+'-joined prefixes. Default: every suite the project's source declares
//            (ue-test-suites.mjs) - never an empty filter, which would run Epic's own suites.
//
// Rules it enforces (each one a real failure mode):
//   - refuses while a GUI editor of this project is open: a headless editor loads the same packages and the
//     person's next save fails with `MoveFile ... (Error Code 32)`;
//   - refuses while a headless editor of this project runs: it holds the module DLLs (and may be stale);
//   - writes its OWN log (-ABSLOG): with a GUI editor open, Saved/Logs/<Name>.log is the GUI's;
//   - every filter token must have run >= 1 test (cold-boot discovery race), retried once warm;
//   - quarantined (flaky) tests run but never decide the verdict;
//   - a run that never reached TEST COMPLETE fails, even with exit 0.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { exitWith, gate, gatePlan, renderCommand, Verdict } from './ue-gate.mjs';
import { editorsOfProject } from './ue-proc.mjs';
import { fullPassFilter } from './ue-test-suites.mjs';
import { failureReport, judgeRun, loadQuarantine, parseRunLog } from './ue-test-log.mjs';
import { binariesStale, parseArgs, resolveTools } from './ue-tools.mjs';

const Kind = 'tests';
const args = parseArgs(process.argv.slice(2), {
	project: {},
	wait: { default: '600' },
	timeout: { default: '30' },
	attempts: { default: '2' },
	quarantine: {},
	verbose: { type: 'bool' },
	'dry-run': { type: 'bool' },
	help: { type: 'bool' },
});
if (args.help) {
	console.log('usage: ue-test.cmd [filter] [--project p] [--wait s] [--timeout min] [--attempts n] [--quarantine file] [--verbose] [--dry-run] [-- extra editor args]');
	console.log('  default filter: all suites declared in Source/ and Plugins/ (IMPLEMENT_*_AUTOMATION_TEST, DEFINE_SPEC)');
	console.log('  quarantine: --quarantine, else UE_TEST_QUARANTINE, else <project>/.claude/ue-test-quarantine.json');
	console.log('  log: <project>/Saved/Logs/<Name>-Tests.log (UE_TEST_LOG_DIR overrides the folder)');
	process.exit(0); // verdict-exempt: help
}
const dry = Boolean(args['dry-run']);
const wait = Number(args.wait);
const timeoutMin = Number(args.timeout);
const attempts = Math.max(1, Number(args.attempts) || 1);
if (!Number.isFinite(wait) || !Number.isFinite(timeoutMin) || timeoutMin <= 0) exitWith(Kind, Verdict.Failed, 2);

const tools = resolveTools({ project: args.project });
if (!tools.ok) {
	console.log(tools.error);
	exitWith(Kind, Verdict.Failed, 1);
}

const explicit = args._[0];
const filter = explicit || fullPassFilter(tools.projectDir);
if (!filter) {
	console.log('No automation suite is declared in this project (no IMPLEMENT_*_AUTOMATION_TEST / DEFINE_SPEC under Source/ or Plugins/).');
	console.log('A full pass that selects nothing verified nothing. Name a filter explicitly to run something else.');
	exitWith(Kind, Verdict.Failed, 2);
}

const quarantineFile = args.quarantine ?? process.env.UE_TEST_QUARANTINE ?? join(tools.projectDir, '.claude', 'ue-test-quarantine.json');
const quarantine = loadQuarantine(quarantineFile);
for (const p of quarantine.problems) console.log(`WARNING: quarantine: ${p}`);

const logDir = process.env.UE_TEST_LOG_DIR || tools.logsDir;
const logPath = join(logDir, `${tools.name}-Tests.log`);
// A space in an -ABSLOG= (or -script=) path makes the editor ignore it silently: the log would land elsewhere
// and the coverage check would read nothing. Refuse rather than report on a log that is not this run's.
if (/\s/.test(logPath)) {
	console.log(`ERROR: the test log path has a space: "${logPath}" - the editor ignores -ABSLOG= then. Set UE_TEST_LOG_DIR to a folder without spaces.`);
	exitWith(Kind, Verdict.Failed, 2);
}

const editorArgs = [
	tools.project,
	`-ExecCmds=Automation RunTests ${filter}; Quit`,
	'-unattended',
	'-nopause',
	'-nosplash',
	'-RenderOffScreen', // the editor stays fully alive without a window; -nullrhi breaks editor/Slate init
	...(args.verbose ? ['-stdout', '-FullStdOutLogOutput'] : []),
	'-NoLogTimes',
	`-ABSLOG=${logPath}`,
	'-SCCProvider=None', // no background source control against the checkout
	'-nosound', // a test that plays a sound would play it aloud
	'-TestExit=Automation Test Queue Empty',
	...args.rest,
];

console.log(`Project : ${tools.project}`);
console.log(`Filter  : ${filter}${explicit ? '' : '   (all declared suites)'}`);
if (quarantine.entries.length) console.log(`Quarantine (${quarantineFile}): ${quarantine.entries.map((e) => e.token).join(', ')}`);

const editors = editorsOfProject(tools.projectDir);
const blockers = [];
if (editors.gui.length) {
	blockers.push(
		`a GUI editor of this project is open (pid ${editors.gui.join(', ')}). A headless run next to it holds the same packages and the person's save then fails with "MoveFile ... Error Code 32". ` +
			'If this session did not start it, ask the person to close it or to run the tests in it (Tools > Test Automation); never kill it.',
	);
}
if (editors.headless.length) {
	blockers.push(`a headless editor of this project runs (pid ${editors.headless.join(', ')}); it holds the module DLLs and may carry stale code. If this session started it, stop it with ue-stop-editor.cmd (separate tool call), then rerun; otherwise wait for its owner.`);
}
if (!editors.precise || editors.opaque) console.log('WARNING: some editor processes cannot be attributed to a project - one may be this project\'s.');
const stale = binariesStale(tools);
if (stale.stale) {
	console.log('WARNING: C++ sources are newer than the newest module binary - the run would test OLD code, and tests added since');
	console.log('         the last compile silently do not exist. Run ue-compile.cmd first.');
}

if (dry) {
	for (const b of blockers) console.log(`WOULD DEFER: ${b}`);
	console.log('Gate    :');
	for (const l of gatePlan('launch', { wait })) console.log(`  ${l}`);
	console.log(`Log     : ${logPath}`);
	console.log('Command :');
	console.log(`  ${renderCommand(tools.unrealEditorCli, editorArgs)}`);
	exitWith(Kind, Verdict.DryRun, 0);
}

if (blockers.length) {
	for (const b of blockers) console.log(`DEFERRED: ${b}`);
	console.log('No test ran.');
	exitWith(Kind, Verdict.Deferred, 1);
}

const owner = gate('launch', tools.projectDir, { wait });
if (!owner.ok) {
	console.log(`DEFERRED: ${owner.reason}`);
	console.log('No test ran. An editor or a build this session did not start is not ours: wait or ask, never stop it.');
	exitWith(Kind, Verdict.Deferred, 1);
}

/** Runs the editor once; resolves its exit code (null on timeout, after killing OUR child). */
function runOnce() {
	return new Promise((done) => {
		const child = spawn(tools.unrealEditorCli, editorArgs, { stdio: args.verbose ? 'inherit' : 'ignore', windowsHide: true });
		const timer = setTimeout(() => {
			console.log(`ERROR: no exit after ${timeoutMin} min - killing this run's own headless editor (pid ${child.pid}).`);
			child.kill();
			done(null);
		}, timeoutMin * 60 * 1000);
		child.on('error', (e) => {
			clearTimeout(timer);
			console.log(`ERROR: could not start ${tools.unrealEditorCli}: ${e.message}`);
			done(1);
		});
		child.on('close', (code) => {
			clearTimeout(timer);
			done(code ?? 1);
		});
	});
}

mkdirSync(logDir, { recursive: true });
let verdict = null;
let run = null;
for (let attempt = 1; attempt <= attempts; attempt++) {
	console.log(`Running automation tests, attempt ${attempt}/${attempts} (one-shot headless, minutes)... log: ${logPath}`);
	rmSync(logPath, { force: true }); // an earlier run's log must not be counted as this one's
	const code = await runOnce();
	run = existsSync(logPath) ? parseRunLog(readFileSync(logPath, 'utf8')) : parseRunLog('');
	verdict = judgeRun({ exitCode: code ?? 1, run, filter, entries: quarantine.entries });
	if (code === null) verdict.reasons.unshift(`the run hung past ${timeoutMin} min`);
	if (!existsSync(logPath)) verdict.reasons.unshift('no log was written - the editor did not start or ignored -ABSLOG');
	if (verdict.ok || !verdict.retryable || code === null || attempt === attempts) break;
	console.log(`WARNING: coverage under-run (${verdict.missing.join(', ')} ran 0 tests) - likely the cold-boot discovery race; retrying warm...`);
}

const c = verdict.cls;
console.log('');
console.log(`passed ${c.passed}, failed ${c.failed.length}, incomplete ${c.incomplete.length}, quarantined ${c.quarantined.length}, skipped/not run ${c.skipped}`);
for (const l of failureReport(run, [...c.failed, ...c.incomplete])) console.log(l);
for (const p of c.quarantined) {
	const e = quarantine.entries.find((q) => p.toLowerCase().startsWith(q.token.toLowerCase()));
	console.log(`QUARANTINED ${p}: FAIL (not gating; ${e?.reason || 'no reason'}, since ${e?.since || '?'})`);
}
const ok = verdict.ok && verdict.reasons.length === 0;
if (ok) {
	console.log(`Tests PASSED (filter: ${filter}).`);
	exitWith(Kind, Verdict.Ok, 0);
}
for (const r of verdict.reasons) console.log(`- ${r}`);
console.log(`Tests FAILED. Full log: ${logPath}`);
exitWith(Kind, Verdict.Failed, 1);
