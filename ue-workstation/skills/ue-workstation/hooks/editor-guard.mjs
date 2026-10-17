// editor-guard.mjs — the machine rule «an agent touches only what it started» as a Claude Code hook.
//
// PreToolUse  Bash|PowerShell     refuses before the command runs:
//   - stopping Unreal editors by image name (taskkill /im, Stop-Process -Name, Get-Process UnrealEditor | ...):
//     it hits every project's editor and every person's; stop by pid, through ue-stop-editor;
//   - stopping an editor by pid that this session did not start (ue-owner canStop), or that is in the foreground
//     window right now (a person is looking at it);
//   - starting an editor while one of this project runs, or while another project's editor that is not ours runs
//     (one editor per machine unless the person allowed --alongside / UE_ALONGSIDE=1);
//   - building while this project's editor holds the DLLs, or while a build that is not ours runs.
// PreToolUse  mcp__<server>__*    refuses a call whose port is answered by another project's editor, and asks the
//                                 person before the first python call into an editor this session did not start
//                                 (VibeUE saves every dirty package before it runs python); PostToolUse remembers the OK.
// PostToolUse Bash|PowerShell     an editor that appeared during this call, launched from this session, gets its
//                                 ownership marker — whatever started it (a script, Start-Process, python).
//
// Commands are judged by their text, which a determined script can hide from; the skills' own scripts check the
// same rules themselves (ue-owner.mjs), so the hook is the second line, not the only one.
// Fails open when the payload is unreadable or the process query fails — except for a stop: an editor that
// cannot be attributed is not stopped.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { addContext, block, readPayload } from './hook-io.mjs';
import {
	canBuild, canLaunch, canStop, checkPort, claim, describeEditor, editors, findProjectRoot, foregroundPid,
	portOwner, pruneMarkers, snapshot, uprojectOfCmd, whoAmI,
} from '../scripts/mjs/ue-owner.mjs';

const StateDir = join(tmpdir(), 'ue-editor-guard');
/**
 * PURE: does the command stop editors selected by image name? A verb counts only at the start of a statement or
 * a pipeline stage, so file names and quoted prose that merely mention both words are not a kill.
 */
export function killsByImage(text) {
	const Ed = 'unrealeditor';
	if (new RegExp(`(?:get-process|gps)\\s[^;\\n]*${Ed}[\\s\\S]*?\\.\\s*(?:kill|closemainwindow)\\s*\\(`, 'i').test(text)) return true;
	for (const stmt of String(text).split(/[;\n]|&&|\|\|/)) {
		const stages = stmt.split('|').map((s) => s.trim().replace(/^[&(\s]+/, '').replace(/^\$\w+\s*=\s*/, ''));
		for (let i = 0; i < stages.length; i++) {
			const s = stages[i];
			if (new RegExp(`^taskkill\\b.*\\/im\\s+["']?${Ed}`, 'i').test(s)) return true;
			if (new RegExp(`^(?:stop-process|spps|kill)\\b.*-name\\s+["']?${Ed}`, 'i').test(s)) return true;
			if (new RegExp(`^(?:pkill|killall)\\b.*${Ed}`, 'i').test(s)) return true;
			if (new RegExp(`^wmic\\b.*${Ed}.*\\b(?:delete|terminate)\\b`, 'i').test(s)) return true;
			if (i > 0 && new RegExp(`^(?:get-process|gps|ps|get-ciminstance|gcim|get-wmiobject|gwmi)\\b.*${Ed}`, 'i').test(stages[0])
				&& /^(?:stop-process|spps|kill\b|remove-ciminstance|invoke-cimmethod|foreach-object|%)/i.test(s)
				&& /stop-process|spps|kill|closemainwindow|terminate|remove-ciminstance/i.test(s)) return true;
		}
	}
	return false;
}

/** PURE: the command without heredoc and PowerShell here-string bodies — data fed to a program, not commands. */
export function stripHeredocs(command) {
	return String(command ?? '')
		.replace(/<<-?\s*(['"]?)(\w+)\1([^\n]*)\n[\s\S]*?\n\s*\2[ \t]*(?=\n|$)/g, '<<$2$3')
		.replace(/@(['"])\r?\n[\s\S]*?\r?\n\1@/g, '@$1$1@');
}

/** PURE: what a command line would do to editors and builds. */
export function classify(command) {
	const text = stripHeredocs(command);
	const out = { killByImage: false, killPids: [], launch: null, build: null, alongside: /--alongside\b|UE_ALONGSIDE=1/i.test(text) };

	const pids = new Set();
	for (const m of text.matchAll(/taskkill\b[^;&|\n]*/gi)) for (const p of m[0].matchAll(/\/pid\s+(\d+)/gi)) pids.add(Number(p[1]));
	for (const m of text.matchAll(/\b(?:stop-process|spps)\b[^;&|\n]*?-id\s+([\d,\s]+)/gi)) for (const p of m[1].split(/[,\s]+/)) if (p) pids.add(Number(p));
	for (const m of text.matchAll(/\b(?:stop-process|spps)\s+(\d+)/gi)) pids.add(Number(m[1]));
	for (const m of text.matchAll(/(?:get-process|gps)\s+-id\s+(\d+)[^;\n]*?(?:closemainwindow|kill|stop-process|spps)/gi)) pids.add(Number(m[1]));
	for (const m of text.matchAll(/getprocessbyid\(\s*(\d+)\s*\)[^;\n]*?(?:kill|closemainwindow)/gi)) pids.add(Number(m[1]));
	for (const m of text.matchAll(/(?:^|[;&|\n(]\s*)kill\s+(?:-\d+\s+|-s\s+\w+\s+|-id\s+)?(\d+)/gim)) pids.add(Number(m[1]));
	out.killPids = [...pids];

	if (!pids.size) out.killByImage = killsByImage(text);

	const launchRe = /(?:^|[;&|\n(]\s*)(?:&\s*|start-process\s+(?:-filepath\s+)?|start\s+(?:""\s+)?|call\s+)?(?:"(?:[^"]*[\\/])?unrealeditor(?:-cmd)?(?:\.exe)?"|'(?:[^']*[\\/])?unrealeditor(?:-cmd)?(?:\.exe)?'|[^\s"';&|]*?unrealeditor(?:-cmd)?(?:\.exe)?)(?=\s|$)/i;
	if (!out.killByImage && !out.killPids.length && launchRe.test(text)) out.launch = { uproject: uprojectOfCmd(text) };

	if (/build\.(?:bat|sh)\b|unrealbuildtool|\brunuat\b|\b[\w-]*compile[\w-]*\.(?:cmd|bat)\b/i.test(text)) {
		const target = text.match(/build\.(?:bat|sh)["']?\s+["']?(\w+)/i)?.[1];
		const game = /\brunuat\b[^\n]*buildcookrun/i.test(text) || (!!target && !/editor$/i.test(target));
		out.build = { editorTarget: !game };
	}
	return out;
}

const Relevant = /unrealeditor|taskkill|stop-process|spps|\bkill\b|closemainwindow|build\.(?:bat|sh)|unrealbuildtool|runuat|compile[\w-]*\.(?:cmd|bat)/i;

function callFile(id) {
	return join(StateDir, `call-${String(id ?? 'none').replace(/[^\w.-]/g, '_')}.json`);
}

function editorImagesRunning() {
	try {
		const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq UnrealEditor*', '/NH', '/FO', 'CSV'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 10000 });
		return /^"UnrealEditor/im.test(out);
	} catch {
		return true;
	}
}

function preBash(payload) {
	const command = payload.tool_input?.command ?? '';
	try {
		mkdirSync(StateDir, { recursive: true });
		writeFileSync(callFile(payload.tool_use_id), JSON.stringify({ t: Date.now(), cwd: payload.cwd }));
	} catch { /* adoption is best effort */ }
	if (!Relevant.test(command)) return;
	const c = classify(command);
	if (c.killByImage) {
		block('editor-guard: this stops Unreal editors by image name - that hits every project\'s editor, a person\'s included. Stop one editor by pid, only one this session started: ue-stop-editor (ue-build-test) or `node ue-owner.mjs can-stop <pid>` first.');
	}
	if (!c.killPids.length && !c.launch && !c.build) return;
	const snap = snapshot();
	if (!snap) {
		if (c.killPids.length) block('editor-guard: the process query failed, so this pid cannot be attributed - no editor is stopped blind. Retry.');
		return;
	}
	const me = whoAmI(snap);
	const root = findProjectRoot(payload.cwd ?? process.cwd());
	for (const pid of c.killPids) {
		const v = canStop(snap, me, pid);
		if (!v.ok) block(`editor-guard: ${v.reason}`);
		if (v.editor?.gui && foregroundPid() === pid) {
			block(`editor-guard: ${describeEditor(v.editor)} is the foreground window - a person is looking at it. Ask before closing.`);
		}
	}
	if (c.launch) {
		const proj = c.launch.uproject ? resolve(c.launch.uproject, '..') : root;
		if (proj) {
			const v = canLaunch(snap, me, proj, { alongside: c.alongside });
			if (!v.ok) block(`editor-guard: not starting an editor - ${v.reason}`);
		}
	}
	if (c.build && root) {
		const v = canBuild(snap, me, root, { editorTarget: c.build.editorTarget });
		if (!v.ok) block(`editor-guard: not building - ${v.reason}`);
	}
}

function postBash(payload) {
	const file = callFile(payload.tool_use_id);
	let since = null;
	try {
		since = JSON.parse(readFileSync(file, 'utf8')).t;
	} catch { /* no PreToolUse record */ }
	rmSync(file, { force: true });
	sweepStateDir();
	if (since == null || !editorImagesRunning()) return;
	const snap = snapshot();
	if (!snap) return;
	const me = whoAmI(snap);
	if (!me) return;
	const claimed = [];
	for (const e of editors(snap, me)) {
		if (e.state !== 'human' || !e.project || e.start == null || e.start < since - 2000) continue;
		const r = claim(snap, me, e.pid, { since });
		if (r.ok) {
			claimed.push(`${e.gui ? 'GUI' : 'headless'} editor pid ${e.pid}`);
			pruneMarkers(e.project, snap);
		}
	}
	if (claimed.length) {
		addContext('PostToolUse', `editor-guard: ${claimed.join(', ')} recorded as started by this session (Saved/AgentEditors). This session may stop it; nobody else's editor may be stopped.`);
	}
}

function preMcp(payload) {
	const server = String(payload.tool_name ?? '').match(/^mcp__(.+?)__/)?.[1];
	const root = findProjectRoot(payload.cwd ?? process.cwd());
	if (!server || !root) return;
	let cfg;
	try {
		cfg = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8'))?.mcpServers?.[server];
	} catch {
		return;
	}
	const port = Number(String(cfg?.url ?? '').match(/:(\d+)(?:\/|$)/)?.[1]);
	if (!port) return;
	const listener = portOwner(port);
	if (!listener) return;
	const cache = join(StateDir, `port-${port}.json`);
	let v = null;
	try {
		const c = JSON.parse(readFileSync(cache, 'utf8'));
		if (c.pid === listener && c.root === root && Date.now() - c.t < 600000) v = c;
	} catch { /* no usable cache */ }
	if (!v) {
		const snap = snapshot();
		if (!snap) return;
		const me = whoAmI(snap);
		const r = checkPort(snap, me, root, port);
		v = { ok: r.ok, reason: r.reason, state: r.state, pid: listener, root, me: me?.pid ?? null, t: Date.now() };
		try {
			mkdirSync(StateDir, { recursive: true });
			writeFileSync(cache, JSON.stringify(v));
		} catch { /* cache only */ }
	}
	if (!v.ok) block(`editor-guard: ${v.reason}`);
	if (isPythonTool(payload.tool_name) && v.state !== 'mine' && !existsSync(ackFile(v))) {
		process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask',
			permissionDecisionReason: `editor-guard: python into editor pid ${v.pid}, which this session did not start (${v.state}). VibeUE saves EVERY dirty package of that editor before running python - the person's unsaved edits get saved. Allow only if the person agrees; asked once per editor.` } }));
		process.exit(0);
	}
}

const isPythonTool = (name) => /__execute_python_code$/.test(String(name ?? ''));
const ackFile = (v) => join(StateDir, `python-ok-${v.pid}-${v.me ?? 'none'}.json`);

/** The person allowed python into an editor that is not ours: remember it for that editor and this session. */
function postMcp(payload) {
	if (!isPythonTool(payload.tool_name)) return;
	const port = (() => {
		try {
			const root = findProjectRoot(payload.cwd ?? process.cwd());
			const server = String(payload.tool_name).match(/^mcp__(.+?)__/)?.[1];
			const url = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8'))?.mcpServers?.[server]?.url;
			return Number(String(url ?? '').match(/:(\d+)(?:\/|$)/)?.[1]);
		} catch {
			return 0;
		}
	})();
	if (!port) return;
	try {
		const v = JSON.parse(readFileSync(join(StateDir, `port-${port}.json`), 'utf8'));
		if (v.ok && v.state !== 'mine') writeFileSync(ackFile(v), JSON.stringify({ t: Date.now() }));
	} catch { /* nothing to remember */ }
}

/** Drops call records older than a day (a session killed between Pre and Post leaves one behind). */
function sweepStateDir() {
	try {
		const cutoff = Date.now() - 86400000;
		for (const f of readdirSync(StateDir)) {
			if (!f.startsWith('call-')) continue;
			const p = join(StateDir, f);
			if (statSync(p).mtimeMs < cutoff) rmSync(p, { force: true });
		}
	} catch { /* best effort */ }
}

function main() {
	const payload = readPayload();
	if (!payload) return;
	const tool = String(payload.tool_name ?? '');
	const event = payload.hook_event_name;
	if (tool.startsWith('mcp__')) {
		if (event === 'PreToolUse') preMcp(payload);
		else if (event === 'PostToolUse') postMcp(payload);
		return;
	}
	if (tool !== 'Bash' && tool !== 'PowerShell') return;
	if (event === 'PreToolUse') preBash(payload);
	else if (event === 'PostToolUse') postBash(payload);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
	try {
		main();
	} catch (e) {
		process.stderr.write(`editor-guard: internal error, passing (${e?.message ?? e})\n`);
	}
	process.exit(0);
}
