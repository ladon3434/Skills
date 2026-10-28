// ue-run-editor-headless — starts this project's editor WITHOUT a window (UnrealEditor-Cmd -RenderOffScreen),
// for work that needs a live editor and no person: an MCP server inside the editor, live log reading.
// A capability, not a habit: a one-shot test run is ue-test.cmd, a one-shot Python sweep is a commandlet.
//
// Usage: ue-run-editor-headless.cmd [--project p] [--wait s] [--dry-run] [-- extra editor args]
//
// Guards (each one a real failure):
//   - a GUI editor of this project is open -> REFUSED. The headless one would load the same packages and the
//     person's next save fails with `MoveFile ... (Error Code 32)` — measured, it cost a map once.
//   - a headless editor of this project already runs -> reused, never a second one (one instance at a time).
//   - ownership (ue-owner canLaunch): no editor of another project that this session did not start (one editor
//     per machine), and no build that is not ours — an editor booting now loads half-written DLLs. Waits up
//     to --wait seconds for what is not ours. The launched editor gets its marker in Saved/AgentEditors, so
//     this session (and only it) may stop it later.
//   - C++ sources newer than the binaries -> REFUSED: it would run old code. Compile first.
// Flags: -RenderOffScreen keeps the editor fully alive without a window (-nullrhi breaks editor/Slate init);
// -unattended -nopause -nosplash: no dialogs; -SCCProvider=None: no background source control; -nosound;
// own -ABSLOG=Saved/Logs/<Name>-Headless.log. It gets its own minimized console, so ue-stop-editor can
// close it with a console Ctrl+C.
// Stop it with ue-stop-editor.cmd the moment the work stops needing it: an idle editor burns ~3 cores and
// drags a person's GUI editor down with it.

import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { gate, gatePlan, renderCommand, winQuote } from './ue-gate.mjs';
import { claim, MarkerDirName, snapshot, whoAmI } from './ue-owner.mjs';
import { editorsOfProject } from './ue-proc.mjs';
import { binariesStale, parseArgs, resolveTools } from './ue-tools.mjs';

const args = parseArgs(process.argv.slice(2), { project: {}, wait: { default: '120' }, 'dry-run': { type: 'bool' }, help: { type: 'bool' } });
if (args.help) {
	console.log('usage: ue-run-editor-headless.cmd [--project p] [--wait s] [--dry-run] [-- extra editor args]');
	console.log('  then: ue-wait-editor.cmd; when done: ue-stop-editor.cmd');
	process.exit(0);
}
const tools = resolveTools({ project: args.project });
if (!tools.ok) {
	console.log(tools.error);
	process.exit(1);
}
const logPath = join(tools.logsDir, `${tools.name}-Headless.log`);
const editorArgs = [tools.project, '-unattended', '-nopause', '-nosplash', '-RenderOffScreen', '-SCCProvider=None', '-nosound', `-ABSLOG=${logPath}`, ...args.rest];
const title = `${tools.name} headless editor`;
const startLine = `start ${winQuote(title)} /min ${[tools.unrealEditorCli, ...editorArgs].map(winQuote).join(' ')}`;

const refuse = (why) => {
	console.log(`REFUSED: ${why}`);
	process.exit(2);
};

const e = editorsOfProject(tools.projectDir);
const problems = [];
if (e.gui.length) problems.push(`a GUI editor of this project is open (pid ${e.gui.join(', ')}): a headless editor next to it makes that editor's save fail with "MoveFile ... Error Code 32". Use that editor, or wait until it is closed.`);
if (/\s/.test(logPath)) problems.push(`the log path has a space ("${logPath}"): the editor would ignore -ABSLOG=.`);
if (binariesStale(tools).stale) problems.push('C++ sources are newer than the module binaries - it would run old code. Run ue-compile.cmd first.');

if (args['dry-run']) {
	if (e.headless.length) console.log(`WOULD REUSE: headless editor pid ${e.headless.join(', ')} already runs.`);
	for (const p of problems) console.log(`WOULD REFUSE: ${p}`);
	for (const l of gatePlan('launch', { wait: Number(args.wait) || 0 })) console.log(`Gate    : ${l}`);
	console.log(`Log     : ${logPath}`);
	console.log('Command :');
	console.log(`  cmd.exe /d /s /c "${startLine}"`);
	console.log(`  (the editor itself: ${renderCommand(tools.unrealEditorCli, editorArgs)})`);
	process.exit(0);
}

if (e.headless.length) {
	console.log(`A headless editor of this project already runs (pid ${e.headless.join(', ')}) - reusing it. Log: ${logPath}`);
	process.exit(0);
}
if (problems.length) refuse(problems.join('\n         '));
if (!e.precise || e.opaque) console.log('WARNING: some editor processes cannot be attributed to a project.');

const owner = gate('launch', tools.projectDir, { wait: Number(args.wait) || 0 });
if (!owner.ok) refuse(`${owner.reason}\n         An editor or a build this session did not start is not ours: wait or ask, never stop it.`);
const since = Date.now();

const r =
	process.platform === 'win32'
		? spawnSync('cmd.exe', ['/d', '/s', '/c', `"${startLine}"`], { stdio: 'inherit', windowsHide: true, windowsVerbatimArguments: true })
		: (spawn(tools.unrealEditorCli, editorArgs, { detached: true, stdio: 'ignore' }).unref(), { status: 0 });
if (r.status !== 0) {
	console.log('ERROR: the launch failed.');
	process.exit(1);
}
console.log(`Launched: ${title}. Log: ${logPath}`);
claimLaunched();
console.log('Next: ue-wait-editor.cmd (ready = "Engine is initialized" in that log). Stop: ue-stop-editor.cmd - before the final report at the latest.');

/** Writes the ownership marker for the editor just started (its launcher exits at once, so it is found by start time). */
function claimLaunched() {
	const want = tools.project.toLowerCase().replace(/\//g, '\\');
	for (let i = 0; i < 20; i++) {
		const snap = snapshot();
		const me = snap && whoAmI(snap);
		const fresh = snap?.filter((p) => p.name.startsWith('unrealeditor') && p.start != null && p.start >= since - 2000 && (p.cmd ?? '').toLowerCase().replace(/\//g, '\\').includes(want));
		if (snap && me && fresh?.length) {
			for (const p of fresh) {
				const c = claim(snap, me, p.pid, { projectRoot: tools.projectDir, since });
				console.log(c.ok ? `Marker: ${join(tools.projectDir, MarkerDirName, `${p.pid}.json`)} (pid ${p.pid} belongs to this session)` : `WARNING: no marker for pid ${p.pid} - ${c.reason}`);
			}
			return;
		}
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
	}
	console.log('WARNING: the new editor process was not found within 10 s - no ownership marker written; ue-stop-editor will treat it as not ours.');
}
