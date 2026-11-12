// ue-launch-editor — starts this project's editor the way an agent may: only when the machine rule allows it, with
// the MCP server on, Python Remote Execution on (the -ini switch: ue-pyremote.mjs runs python through it; no project
// file changes), with the ownership marker written, and waits until the server answers.
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
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { findProjectUproject, resolveEngine } from './ue-engine.mjs';
import { preflight, projectInfo } from './ue-project.mjs';
import { canLaunch, claim, portOwner, snapshot, whoAmI } from './ue-owner.mjs';
import { LaunchSwitch } from './ue-pyremote.mjs';

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
	const head = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).slice(0, 18);
	console.log(head.map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
	process.exit(0);
}

const projectArg = opt('--project');
const uproject = projectArg ? (projectArg.toLowerCase().endsWith('.uproject') ? resolve(projectArg) : findProjectUproject(resolve(projectArg))) : findProjectUproject();
if (!uproject) verdict('FAILED', 'no .uproject here or above - pass --project DIR', 1);
if (!existsSync(uproject)) verdict('FAILED', `${uproject} does not exist`, 1);
const info = projectInfo(uproject);
if (info.engine?.error) verdict('FAILED', info.engine.error, 1);
const headless = flag('--headless');
const timeoutMs = (Number(opt('--timeout')) > 0 ? Number(opt('--timeout')) : 240) * 1000;

const exe = join(info.engine.unrealHome, 'Engine', 'Binaries', 'Win64', headless ? 'UnrealEditor-Cmd.exe' : 'UnrealEditor.exe');
const args = [uproject];
if (headless) args.push('-unattended', '-nopause', '-nosplash', '-RenderOffScreen', '-nosound');
if (info.serverKind !== 'none' && !info.autoStart.value) args.push('-ModelContextProtocolStartServer');
if (info.portFrom === 'UE_MCP_PORT') args.push(`-ModelContextProtocolPort=${info.port}`);
args.push(LaunchSwitch);
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
if (info.serverKind === 'none') console.log('WARNING: the ModelContextProtocol plugin is not on in this project - the editor starts without an MCP server (Python Remote Execution still works)');

if (flag('--dry-run')) verdict('DRY-RUN', 'nothing started', 0);
if (panel) verdict('REFUSED', 'the restore panel is pending: the editor would stop on "restore unsaved assets?" which only a person can close. Tell the person before launching.', 1);
if (!rule.ok && rule.reuse) verdict('REUSED', `this session's editor pid ${rule.reuse} already runs - use it (scripts/editor-ready.sh waits for its server)`, 0);
if (!rule.ok) verdict('REFUSED', rule.reason, 1);
if (!existsSync(exe)) verdict('FAILED', `${exe} does not exist`, 1);
// A port somebody already answers on cannot be bound by the editor started now: its MCP server would never come up,
// and the answer on the port would be read as this editor's.
const holder = info.serverKind !== 'none' ? portOwner(info.port) : null;
if (holder) verdict('REFUSED', `port ${info.port} is already answered by pid ${holder} - an editor started now could not open its MCP server there. Give this project its own port (UE_MCP_PORT) or wait for that process to end.`, 1);

// One launch of a project at a time. Two sessions that both pass canLaunch in the same second would both spawn; the
// MCP bridge takes the same file (Saved/mcp-bridge/editor-launch.lock) for its own launches. The file names its
// holder, so a lock whose holder is gone is stale at once; released when this script exits.
const lockFile = join(info.project, 'Saved', 'mcp-bridge', 'editor-launch.lock');
const takeLock = () => {
	mkdirSync(join(info.project, 'Saved', 'mcp-bridge'), { recursive: true });
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fd = openSync(lockFile, 'wx');
			try {
				writeFileSync(fd, String(process.pid));
			} finally {
				closeSync(fd);
			}
			process.on('exit', () => {
				try {
					unlinkSync(lockFile);
				} catch {
					/* gone */
				}
			});
			return null;
		} catch (e) {
			if (e.code !== 'EEXIST') return null; // the lock cannot be taken at all (a read-only Saved): launch unlocked
			let holderPid = 0;
			let age = 0;
			try {
				holderPid = Number(readFileSync(lockFile, 'utf8').trim());
				age = Date.now() - statSync(lockFile).mtimeMs;
			} catch {
				continue; // vanished between the two calls: take it
			}
			// The bridge holds the lock while it runs a --launch command: launched by it, this script is that launch.
			if (holderPid > 0 && String(holderPid) === process.env.UE_LAUNCH_LOCK_HOLDER) return null;
			let gone = false;
			if (holderPid > 0) {
				try {
					process.kill(holderPid, 0);
				} catch (err) {
					gone = err.code === 'ESRCH';
				}
			}
			if (gone || age > 270000) {
				try {
					unlinkSync(lockFile);
				} catch {
					/* somebody else removed it */
				}
				continue;
			}
			return holderPid || 'another process';
		}
	}
	return 'another process';
};
const busy = takeLock();
if (busy) verdict('REFUSED', `another launch of this project's editor is in progress (pid ${busy}) - wait for it; scripts/editor-ready.sh waits for the server`, 1);

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
	const r = claim(s, whoAmI(s), pid, { projectRoot: info.project, since, spawnedBy: process.pid });
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
		const answering = portOwner(info.port);
		if (answering && answering !== pid) verdict('FAILED', `${info.url} answers, but from pid ${answering}, not from the editor started here (pid ${pid}) - this editor has no MCP server. Read ${info.log}.`, 1);
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
