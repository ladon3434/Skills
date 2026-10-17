// ue-launch-editor — starts this project's editor the way an agent may: only when the machine rule allows it, with
// the MCP server on, with the ownership marker written, and waits until the server answers.
//
//   ue-launch-editor.cmd [--project DIR] [--headless] [--no-throttle] [--alongside] [--timeout S] [--no-wait]
//                        [--dry-run]
//   --headless     UnrealEditor-Cmd with -RenderOffScreen (Slate and the viewport stay alive) instead of the GUI
//   --no-throttle  the editor keeps full frame rate in the background (time-dependent PIE checks: a background
//                  editor otherwise runs at ~3 fps and short windows such as combo input slip by)
//   --alongside    start even though another project's editor that is not ours runs - ONLY when the person said so
//   --timeout S    how long to wait for the server (default 240: a cold boot on a file DDC takes 3-4 minutes)
//   --no-wait      start, record the marker, return
//   --dry-run      print the verdicts and the exact command, start nothing
//
// Refuses (exit 1) while: an editor of this project runs (this session's -> REUSED, exit 0), an editor of another
// project runs that is not ours, a build that is not ours runs, the restore panel is pending
// (Saved/Autosaves/PackageRestoreData.json - only a person can close it), or the process query fails.
// Exit 0 OK / REUSED / DRY-RUN, 1 REFUSED or FAILED, 3 TIMEOUT. The last line is the verdict.

import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { findProjectUproject, resolveEngine } from './ue-engine.mjs';
import { preflight, projectInfo } from './ue-project.mjs';
import { canLaunch, claim, snapshot, whoAmI } from './ue-owner.mjs';

const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const opt = (f) => {
	const i = argv.indexOf(f);
	return i >= 0 ? argv[i + 1] : undefined;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function verdict(outcome, text, code) {
	console.log(`RESULT: launch ${outcome}${text ? ` - ${text}` : ''}`);
	process.exit(code);
}

if (flag('--help') || flag('-h')) {
	const { readFileSync } = await import('node:fs');
	const { fileURLToPath } = await import('node:url');
	const head = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).slice(0, 17);
	console.log(head.map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
	process.exit(0);
}

const projectArg = opt('--project');
const uproject = projectArg ? (projectArg.toLowerCase().endsWith('.uproject') ? resolve(projectArg) : findProjectUproject(resolve(projectArg))) : findProjectUproject();
if (!uproject) verdict('FAILED', 'no .uproject here or above - pass --project DIR', 1);
const info = projectInfo(uproject);
if (info.engine?.error) verdict('FAILED', info.engine.error, 1);
const headless = flag('--headless');
const timeoutMs = (Number(opt('--timeout')) > 0 ? Number(opt('--timeout')) : 240) * 1000;

const exe = join(info.engine.unrealHome, 'Engine', 'Binaries', 'Win64', headless ? 'UnrealEditor-Cmd.exe' : 'UnrealEditor.exe');
const args = [uproject];
if (headless) args.push('-unattended', '-nopause', '-nosplash', '-RenderOffScreen', '-nosound');
if (info.serverKind !== 'none' && !info.autoStart.value) args.push('-ModelContextProtocolStartServer');
if (info.portFrom === 'UE_MCP_PORT') args.push(`-ModelContextProtocolPort=${info.port}`);
if (flag('--no-throttle')) args.push('-ini:EditorSettings:[/Script/UnrealEd.EditorPerformanceSettings]:bThrottleCPUWhenNotForeground=False');
const shown = [exe, ...args].map((a) => (/[\s"]/.test(a) ? `"${a}"` : a)).join(' ');

const pf = await preflight(info, { probe: false });
const panel = pf.verdicts.find((v) => v.startsWith('RESTORE PANEL'));
const snap = snapshot();
const me = snap ? whoAmI(snap) : null;
const rule = snap ? canLaunch(snap, me, info.project, { alongside: flag('--alongside') }) : { ok: false, reason: 'the process query failed - nobody can tell whose editors run here; not starting one blind' };

console.log(`project : ${info.name} (${info.project})`);
console.log(`server  : ${info.serverKind}, ${info.url}, auto start ${info.autoStart.value} (${info.autoStart.from})`);
for (const w of pf.verdicts) console.log(`preflight: ${w}`);
console.log(`owner   : ${me ? `claude pid ${me.pid}` : 'no claude.exe above this process - the editor cannot be recorded as this session\'s'}`);
console.log(`rule    : ${rule.ok ? 'may launch' : rule.reason}`);
console.log(`command : ${shown}`);
if (info.serverKind === 'none') console.log('WARNING: neither VibeUE nor the ModelContextProtocol plugin is on in this project - the editor starts without an MCP server');

if (flag('--dry-run')) verdict('DRY-RUN', 'nothing started', 0);
if (panel) verdict('REFUSED', 'the restore panel is pending: the editor would stop on "restore unsaved assets?" which only a person can close. Tell the person before launching.', 1);
if (!rule.ok && rule.reuse) verdict('REUSED', `this session's editor pid ${rule.reuse} already runs - use it (scripts/editor-ready.sh waits for its server)`, 0);
if (!rule.ok) verdict('REFUSED', rule.reason, 1);
if (!existsSync(exe)) verdict('FAILED', `${exe} does not exist`, 1);

const since = Date.now();
// detached + ignored stdio: the editor outlives this script; on Windows a non-detached child would sit in Node's
// kill-on-close job and die with it.
const child = spawn(exe, args, { stdio: 'ignore', detached: true, windowsHide: false });
child.unref();
const pid = child.pid;
if (!pid) verdict('FAILED', 'the spawn returned no pid', 1);
console.log(`started : pid ${pid}`);

let recorded = false;
for (let i = 0; i < 10 && !recorded; i++) {
	await sleep(1000);
	const s = snapshot();
	if (!s) continue;
	if (!s.some((p) => p.pid === pid)) verdict('FAILED', `pid ${pid} exited at once - read ${info.log}`, 1);
	const r = claim(s, whoAmI(s), pid, { projectRoot: info.project, since });
	if (r.ok) {
		recorded = true;
		console.log(`marker  : ${join(info.project, 'Saved', 'AgentEditors', `${pid}.json`)}`);
	} else if (i === 9) console.log(`marker  : NOT written - ${r.reason}. This session will not be allowed to stop the editor; the person will.`);
}

if (flag('--no-wait')) verdict('OK', `pid ${pid} started; not waiting for the server (scripts/editor-ready.sh)`, 0);

const logSize = () => {
	try {
		return statSync(info.log).size;
	} catch {
		return 0;
	}
};
let lastSize = logSize();
let stillSince = Date.now();
while (Date.now() - since < timeoutMs) {
	try {
		await fetch(info.url, { method: 'GET', signal: AbortSignal.timeout(3000) });
		verdict('OK', `pid ${pid}, server answers at ${info.url} after ${Math.round((Date.now() - since) / 1000)}s`, 0);
	} catch {
		/* not up yet */
	}
	const s = snapshot();
	if (s && !s.some((p) => p.pid === pid)) verdict('FAILED', `pid ${pid} exited while booting - read ${info.log}`, 1);
	const size = logSize();
	if (size !== lastSize) {
		lastSize = size;
		stillSince = Date.now();
	}
	await sleep(5000);
}
const quiet = Math.round((Date.now() - stillSince) / 1000);
if (quiet >= 60) {
	verdict('TIMEOUT', `no server after ${Math.round(timeoutMs / 1000)}s and the log has not grown for ${quiet}s: a modal window (do NOT relaunch - tell the person which window), or the MCP server is off (grep the log for LogModelContextProtocol)`, 3);
}
verdict('TIMEOUT', `no server after ${Math.round(timeoutMs / 1000)}s, but the log still grows - the editor is working; wait (scripts/editor-ready.sh) and do not launch a second one`, 3);
