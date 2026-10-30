// ue-owner.mjs — who owns an Unreal editor, a build or a port on this machine, without a broker.
//
// MASTER COPY: ue-workstation/skills/ue-workstation/scripts/mjs/ue-owner.mjs. Identical copies live in ue-build-test,
// unreal-editor, ue-content-gates and ue-blender-bridge (that one is kept in another marketplace; each plugin installs on its own);
// `--selftest` of every copy checks that it still matches the siblings found next to it in its repository.
//
// The rule it implements is one line: an agent touches only what it started itself. Everything else on the
// machine — a person's editor, another session's editor, another project's editor, a build somebody else runs —
// is not ours: never stopped, and while it runs we wait instead of starting a second one next to it.
//
// "Who am I" is the Claude Code process (claude.exe) above the caller: every tool command, every hook and every
// stdio MCP server it starts descends from it, so its pid + start time identify the agent session without any
// session id plumbing, and its death ends the ownership by itself (no lease to renew, nothing to release).
//
// "Who started this editor" cannot come from the process tree: the editor is launched detached and its parent
// exits at once. So whoever launches an editor writes an ownership marker into the editor's own project:
//   <project>/Saved/AgentEditors/<editor pid>.json   {pid, start, image, gui, project, owner: {pid, start}, at}
// A marker is valid only while the editor pid AND its start time match (a reused pid is not ours); the owner is
// alive only while that claude.exe pid AND its start time match. The states of an editor process:
//   mine     marker, owner = me
//   agent    marker, owner = another live agent session            -> not ours: wait
//   orphan   marker, owner gone                                    -> a headless orphan may be adopted and stopped;
//                                                                     a GUI orphan counts as a person's (someone may
//                                                                     have started to work in it)
//   human    no valid marker                                       -> a person's: never touched, ask
//   opaque   command line unreadable (elevated, another user)      -> treated as a person's
//
// Builds need no marker: a build runs inside the tool call that started it, so its process chain still reaches
// the claude.exe that owns it. A UnrealBuildTool process whose ancestors do not include me is somebody else's.
//
// CLI (node ue-owner.mjs ...; exit 0 = allowed / found, 1 = refused, 2 = usage or the query failed):
//   status [--project DIR]                 every editor and build on the machine with its state
//   can-launch [--project DIR] [--alongside]
//   can-stop <pid>
//   can-build [--project DIR] [--game]     --game: a non-editor target (does not need the editor closed)
//   claim <pid> [--project DIR]            write the marker for an editor this session just started
//   port-owner <port> [--project DIR]      may this project talk to the editor on that port?
//   whoami
//   --selftest
// Tests: UE_OWNER_FIXTURE=<file.json> replaces the live process table ({processes: [{p,q,n,c,s}], listeners:
// {port: pid}, foreground: pid}); `s` is a Windows FILETIME like the live query returns.

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const IsWindows = process.platform === 'win32';
export const GuiEditor = 'unrealeditor.exe';
export const HeadlessEditor = 'unrealeditor-cmd.exe';
const EditorImages = new Set([GuiEditor, HeadlessEditor, 'unrealeditor', 'unrealeditor-cmd']);
const AgentImages = new Set(['claude.exe', 'claude']);
export const MarkerDirName = join('Saved', 'AgentEditors');
const StartSlackMs = 2000;

// --- the process table ------------------------------------------------------------------------------------------

const filetimeToMs = (ft) => (ft ? Math.round(Number(ft) / 10000 - 11644473600000) : null);

function readFixture(env) {
	try {
		return JSON.parse(readFileSync(env.UE_OWNER_FIXTURE, 'utf8'));
	} catch {
		return null;
	}
}

/**
 * Every process on the machine: {pid, ppid, name (lower case), cmd|null, start (ms epoch)|null}. One CIM query
 * (about half a second). Null when the query failed — callers must not attribute anything then.
 */
export function snapshot(env = process.env) {
	let raw;
	if (env.UE_OWNER_FIXTURE) {
		raw = readFixture(env)?.processes ?? null;
	} else if (IsWindows) {
		try {
			const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
				'Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{p=$_.ProcessId;q=$_.ParentProcessId;n=$_.Name;c=$_.CommandLine;s=if($_.CreationDate){$_.CreationDate.ToFileTimeUtc()}else{0}} } | ConvertTo-Json -Compress'],
			{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 30000, maxBuffer: 64 << 20 });
			raw = JSON.parse(out.trim() || '[]');
		} catch {
			return null;
		}
	} else {
		try {
			const out = execFileSync('ps', ['-axo', 'pid=,ppid=,lstart=,comm=,args='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 });
			raw = [];
			for (const line of out.split('\n')) {
				const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\w{3} \w{3}\s+\d+ [\d:]+ \d{4})\s+(\S+)\s+(.*)$/);
				if (m) raw.push({ p: Number(m[1]), q: Number(m[2]), n: basename(m[4]), c: m[5], s: (Date.parse(m[3]) + 11644473600000) * 10000 });
			}
		} catch {
			return null;
		}
	}
	if (!Array.isArray(raw)) raw = raw ? [raw] : null;
	if (!raw) return null;
	return raw.map((r) => ({
		pid: Number(r.p),
		ppid: Number(r.q),
		name: String(r.n ?? '').toLowerCase(),
		cmd: typeof r.c === 'string' && r.c ? r.c : null,
		start: filetimeToMs(r.s),
	}));
}

const byPid = (snap) => new Map(snap.map((p) => [p.pid, p]));

/** The chain from `pid` up to the root, each a process row; stops at a parent that started after its child (reused pid). */
export function ancestry(snap, pid) {
	const map = byPid(snap);
	const chain = [];
	let cur = map.get(pid);
	const seen = new Set();
	while (cur && !seen.has(cur.pid)) {
		chain.push(cur);
		seen.add(cur.pid);
		const parent = map.get(cur.ppid);
		if (!parent || (parent.start && cur.start && parent.start > cur.start + StartSlackMs)) break;
		cur = parent;
	}
	return chain;
}

/**
 * The agent session the process `pid` runs under: the nearest claude.exe above it, as {pid, start}; null if none.
 * A launcher that forks and execs breaks the chain of parents: Git Bash `timeout` runs as timeout.exe under a bash
 * fork that has already exited, so the walk up stops there. Claude Code passes its own pid down to every child in
 * CLAUDE_PID, and the variable survives such a launcher; it is taken only when it names a live claude.exe.
 */
export function whoAmI(snap, pid = process.pid, env = process.env) {
	if (!snap) return null;
	const hit = ancestry(snap, pid).find((p) => AgentImages.has(p.name));
	if (hit) return { pid: hit.pid, start: hit.start };
	const claimed = byPid(snap).get(Number(env?.CLAUDE_PID));
	return claimed && AgentImages.has(claimed.name) ? { pid: claimed.pid, start: claimed.start } : null;
}

const sameStart = (a, b) => a != null && b != null && Math.abs(a - b) <= StartSlackMs;

/** Is the agent {pid, start} still running? */
export function agentAlive(snap, owner) {
	if (!owner) return false;
	const p = byPid(snap).get(Number(owner.pid));
	return !!p && AgentImages.has(p.name) && sameStart(p.start, owner.start);
}

/** Does `pid` descend from the agent {pid, start}? */
export function descendsFrom(snap, pid, owner) {
	if (!owner) return false;
	return ancestry(snap, pid).some((p) => p.pid === Number(owner.pid) && sameStart(p.start, owner.start));
}

// --- projects ---------------------------------------------------------------------------------------------------

const norm = (p) => String(p ?? '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();

/** The .uproject named in a command line, or null. */
export function uprojectOfCmd(cmd) {
	if (!cmd) return null;
	const m = String(cmd).match(/"([^"]+?\.uproject)"/i) ?? String(cmd).match(/(?:^|\s)([^\s"]+?\.uproject)(?=\s|$)/i);
	return m ? m[1] : null;
}

/** The project folder (the .uproject's folder) named in a command line, or null. */
export const projectOfCmd = (cmd) => {
	const u = uprojectOfCmd(cmd);
	return u ? dirname(resolve(u)) : null;
};

/** The project folder at or above `start` (the folder holding a .uproject), or null. */
export function findProjectRoot(start = process.cwd(), env = process.env) {
	const tryDir = (d) => {
		try {
			return readdirSync(d).some((f) => f.toLowerCase().endsWith('.uproject'));
		} catch {
			return false;
		}
	};
	let dir = resolve(start);
	for (let i = 0; i < 6; i++) {
		if (tryDir(dir)) return dir;
		const up = dirname(dir);
		if (up === dir) break;
		dir = up;
	}
	if (env.CLAUDE_PROJECT_DIR && tryDir(env.CLAUDE_PROJECT_DIR)) return resolve(env.CLAUDE_PROJECT_DIR);
	return null;
}

export const sameProject = (a, b) => !!a && !!b && norm(a) === norm(b);

// --- markers ----------------------------------------------------------------------------------------------------

const markerPath = (projectRoot, pid) => join(projectRoot, MarkerDirName, `${pid}.json`);

export function readMarker(projectRoot, pid) {
	try {
		return JSON.parse(readFileSync(markerPath(projectRoot, pid), 'utf8'));
	} catch {
		return null;
	}
}

/** Writes the marker atomically. */
export function writeMarker(projectRoot, marker) {
	const dir = join(projectRoot, MarkerDirName);
	mkdirSync(dir, { recursive: true });
	const tmp = join(dir, `.${marker.pid}.${process.pid}.tmp`);
	writeFileSync(tmp, JSON.stringify(marker, null, 1));
	renameSync(tmp, markerPath(projectRoot, marker.pid));
}

/** Deletes markers whose editor is gone (or whose pid now belongs to another process). */
export function pruneMarkers(projectRoot, snap) {
	const dir = join(projectRoot, MarkerDirName);
	let files;
	try {
		files = readdirSync(dir).filter((f) => /^\d+\.json$/.test(f));
	} catch {
		return;
	}
	const map = byPid(snap);
	for (const f of files) {
		const m = readMarker(projectRoot, Number(f.slice(0, -5)));
		const p = m && map.get(Number(m.pid));
		if (!p || !EditorImages.has(p.name) || !sameStart(p.start, m.start)) rmSync(join(dir, f), { force: true });
	}
}

// --- editors ----------------------------------------------------------------------------------------------------

/**
 * Every editor process with its state relative to `me`.
 * @returns {{pid, gui, image, project: string|null, start, state: 'mine'|'agent'|'orphan'|'human'|'opaque', marker}[]}
 */
export function editors(snap, me) {
	const out = [];
	for (const p of snap) {
		if (!EditorImages.has(p.name)) continue;
		const gui = !p.name.includes('-cmd');
		const project = projectOfCmd(p.cmd);
		const base = { pid: p.pid, gui, image: p.name, project, start: p.start, marker: null };
		if (!p.cmd) { out.push({ ...base, state: 'opaque' }); continue; }
		const marker = project ? readMarker(project, p.pid) : null;
		if (!marker || !sameStart(marker.start, p.start)) { out.push({ ...base, state: 'human' }); continue; }
		const ownerAlive = agentAlive(snap, marker.owner);
		const mine = ownerAlive && me && Number(marker.owner.pid) === me.pid && sameStart(marker.owner.start, me.start);
		out.push({ ...base, marker, state: mine ? 'mine' : ownerAlive ? 'agent' : 'orphan' });
	}
	return out;
}

/** May this session stop the editor? A headless orphan is adopted; a GUI orphan is left to people. */
export function stoppable(e) {
	return e.state === 'mine' || (e.state === 'orphan' && !e.gui);
}

/**
 * Did this session start the unmarked editor `p`? Yes while its launcher still runs under me; or when its
 * launcher has already exited (a detached start) and it started after `since` (ms epoch) — the start of the tool
 * call or script that launched it. An editor whose parent is alive and not mine (Explorer, the Epic launcher,
 * an IDE) is a person's.
 */
export function startedByMe(snap, me, p, since) {
	if (descendsFrom(snap, p.pid, me)) return true;
	const parent = byPid(snap).get(p.ppid);
	const parentGone = !parent || (parent.start && p.start && parent.start > p.start + StartSlackMs);
	return parentGone && since != null && p.start != null && p.start >= since - StartSlackMs;
}

/**
 * Writes the marker for an editor this session started, or adopts a headless orphan. An unmarked editor is
 * claimed only when startedByMe(since) holds — a person's editor is never claimed by accident.
 */
export function claim(snap, me, pid, { projectRoot = null, since = Date.now() - 120000 } = {}) {
	const p = byPid(snap).get(Number(pid));
	if (!p || !EditorImages.has(p.name)) return { ok: false, reason: `pid ${pid} is not an Unreal Editor process` };
	if (!me) return { ok: false, reason: 'no Claude Code process above this one - cannot tell whose session this is' };
	const project = projectOfCmd(p.cmd) ?? projectRoot;
	if (!project) return { ok: false, reason: `pid ${pid}: no .uproject in its command line` };
	const prev = readMarker(project, p.pid);
	const prevValid = prev && sameStart(prev.start, p.start);
	if (prevValid && agentAlive(snap, prev.owner) && Number(prev.owner.pid) !== me.pid) {
		return { ok: false, reason: `pid ${pid} belongs to another live agent session (claude pid ${prev.owner.pid})` };
	}
	if (prevValid && !agentAlive(snap, prev.owner) && !p.name.includes('-cmd')) {
		return { ok: false, reason: `pid ${pid} is an ended session's GUI editor - a person may be working in it; not adopted` };
	}
	if (!prevValid && !startedByMe(snap, me, p, since)) {
		return { ok: false, reason: `pid ${pid} was not started by this session (its launcher is ${byPid(snap).get(p.ppid)?.name ?? 'unknown'}) - a person's editor is never claimed` };
	}
	writeMarker(project, {
		pid: p.pid, start: p.start, image: p.name, gui: !p.name.includes('-cmd'), project,
		owner: me, at: new Date().toISOString(), adopted: prevValid ? true : undefined,
	});
	return { ok: true, project };
}

const describeEditor = (e) =>
	`${e.gui ? 'GUI' : 'headless'} editor pid ${e.pid}${e.project ? ` of ${basename(e.project)}` : ''} (${{
		mine: 'started by this session',
		agent: `another agent session's, claude pid ${e.marker?.owner?.pid}`,
		orphan: e.gui ? "an ended agent session's GUI editor - a person may be working in it" : "an ended agent session's headless editor",
		human: 'not started by an agent - a person\'s',
		opaque: 'command line unreadable - treated as a person\'s',
	}[e.state]})`;
export { describeEditor };

// --- builds -----------------------------------------------------------------------------------------------------

/** UnrealBuildTool processes (dotnet-hosted or native), each with mine = descends from `me`. */
export function builds(snap, me) {
	return snap
		.filter((p) => p.name === 'unrealbuildtool.exe' || p.name === 'unrealbuildtool' || ((p.name === 'dotnet.exe' || p.name === 'dotnet') && /unrealbuildtool/i.test(p.cmd ?? '')))
		.map((p) => ({ pid: p.pid, cmd: p.cmd, mine: descendsFrom(snap, p.pid, me), project: projectOfCmd(p.cmd) }));
}

// --- verdicts ---------------------------------------------------------------------------------------------------

/**
 * May this session start an editor of `projectRoot`?
 * Refused while any editor of this project runs (mine: reuse it), and while an editor of another project runs that
 * is not mine — the machine keeps one editor at a time unless the person allowed `alongside`. A headless orphan
 * elsewhere is not a person's: the answer says to stop it first.
 */
export function canLaunch(snap, me, projectRoot, { alongside = false } = {}) {
	const all = editors(snap, me);
	const here = all.filter((e) => sameProject(e.project, projectRoot));
	const mineHere = here.find((e) => e.state === 'mine');
	if (mineHere) return { ok: false, reuse: mineHere.pid, reason: `this session already runs ${describeEditor(mineHere)} - use it, do not start a second one` };
	if (here.length) return { ok: false, reason: `${here.map(describeEditor).join('; ')} - a second editor of the same project gets no MCP port and fights over the same files. Wait, or ask the person.` };
	const elsewhere = all.filter((e) => e.state !== 'mine');
	if (elsewhere.length && !alongside) {
		const orphans = elsewhere.filter((e) => e.state === 'orphan' && !e.gui);
		const blockers = elsewhere.filter((e) => !(e.state === 'orphan' && !e.gui));
		const hint = blockers.length
			? 'Not ours: wait until it closes, or start alongside only when the person said so (ue-launch-editor --alongside, or UE_ALONGSIDE=1 before a hand-typed command).'
			: `Only ended agent sessions' headless editors: stop them first (ue-stop-editor --pid ${orphans.map((e) => e.pid).join(',')}).`;
		return { ok: false, reason: `${elsewhere.map(describeEditor).join('; ')}. ${hint}` };
	}
	const foreignBuild = builds(snap, me).find((b) => !b.mine);
	if (foreignBuild) return { ok: false, reason: `a build that is not ours is running (UnrealBuildTool pid ${foreignBuild.pid}) - wait for it` };
	return { ok: true };
}

/** May this session stop editor `pid`? */
export function canStop(snap, me, pid) {
	const e = editors(snap, me).find((x) => x.pid === Number(pid));
	if (!e) return { ok: true, notEditor: true };
	if (stoppable(e)) return { ok: true, editor: e, adopt: e.state === 'orphan' };
	return { ok: false, editor: e, reason: `${describeEditor(e)} - not ours to stop. ${e.state === 'agent' ? 'Wait for that session.' : 'Ask the person.'}` };
}

/**
 * May this session build `projectRoot`? An editor target needs no editor of this project running (it holds the
 * module DLLs); a build that is not ours runs anywhere -> wait (UBT is one per machine).
 */
export function canBuild(snap, me, projectRoot, { editorTarget = true } = {}) {
	const foreign = builds(snap, me).find((b) => !b.mine);
	if (foreign) return { ok: false, reason: `a build that is not ours is running (UnrealBuildTool pid ${foreign.pid}${foreign.project ? `, ${basename(foreign.project)}` : ''}) - wait for it` };
	if (!editorTarget) return { ok: true };
	const here = editors(snap, me).filter((e) => sameProject(e.project, projectRoot));
	if (!here.length) return { ok: true };
	const mine = here.filter((e) => stoppable(e));
	const other = here.filter((e) => !stoppable(e));
	if (other.length) return { ok: false, reason: `${other.map(describeEditor).join('; ')} holds the module DLLs - not ours to close. Wait, or ask the person to close it.` };
	return { ok: false, closeFirst: mine.map((e) => e.pid), reason: `${mine.map(describeEditor).join('; ')} holds the module DLLs - close it first (ue-stop-editor), in a SEPARATE tool call, then build.` };
}

// --- ports and windows -------------------------------------------------------------------------------------------

/** The pid listening on 127.0.0.1/0.0.0.0:<port>, or null. */
export function portOwner(port, env = process.env) {
	if (env.UE_OWNER_FIXTURE) return readFixture(env)?.listeners?.[String(port)] ?? null;
	let out;
	try {
		out = IsWindows
			? execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 15000 })
			: execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
	} catch {
		return null;
	}
	if (!IsWindows) {
		const m = out.match(/^p(\d+)/m);
		return m ? Number(m[1]) : null;
	}
	for (const line of out.split(/\r?\n/)) {
		const f = line.trim().split(/\s+/);
		if (f.length >= 5 && /^LISTEN/i.test(f[3]) && new RegExp(`:${Number(port)}$`).test(f[1])) return Number(f[4]);
	}
	return null;
}

/** May this project talk to whatever listens on `port`? */
export function checkPort(snap, me, projectRoot, port, env = process.env) {
	const pid = portOwner(port, env);
	if (!pid) return { ok: true, pid: null, note: `nothing listens on ${port}` };
	const p = byPid(snap).get(pid);
	if (!p) return { ok: true, pid, note: 'the listener is gone' };
	if (!EditorImages.has(p.name)) return { ok: false, pid, reason: `port ${port} belongs to ${p.name} (pid ${pid}), not to an Unreal Editor - set this project's own ServerPortNumber` };
	const proj = projectOfCmd(p.cmd);
	if (!sameProject(proj, projectRoot)) {
		return { ok: false, pid, reason: `port ${port} is answered by the editor of ANOTHER project (${proj ? basename(proj) : 'unknown'}, pid ${pid}). Calls would change that project. Give this project its own ServerPortNumber in Config/DefaultEditorPerProjectUserSettings.ini and its .mcp.json.` };
	}
	const e = editors(snap, me).find((x) => x.pid === pid);
	return { ok: true, pid, state: e?.state ?? 'human', editor: e ?? null };
}

/** The pid owning the foreground window, or null; a minimized window is not in front of anybody. */
export function foregroundPid(env = process.env) {
	if (env.UE_OWNER_FIXTURE) return readFixture(env)?.foreground ?? null;
	if (!IsWindows) return null;
	try {
		const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
			'Add-Type -Name W -Namespace U -MemberDefinition \'[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint p); [DllImport("user32.dll")] public static extern bool IsIconic(System.IntPtr h);\'; $w = [U.W]::GetForegroundWindow(); $p = 0; if (-not [U.W]::IsIconic($w)) { [void][U.W]::GetWindowThreadProcessId($w, [ref]$p) }; $p'],
		{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 15000 });
		const n = Number(out.trim());
		return n > 0 ? n : null;
	} catch {
		return null;
	}
}

// --- self-test --------------------------------------------------------------------------------------------------

const Siblings = ['ue-workstation', 'ue-build-test', 'unreal-editor', 'ue-content-gates', 'ue-blender-bridge'];

export function selftest() {
	const fails = [];
	let n = 0;
	const eq = (a, b, m) => { n++; if (JSON.stringify(a) !== JSON.stringify(b)) fails.push(`${m}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); };
	const root = join(tmpdir(), `ue-owner-selftest-${process.pid}`);
	const A = join(root, 'ProjA'), B = join(root, 'ProjB');
	for (const d of [A, B]) { mkdirSync(d, { recursive: true }); writeFileSync(join(d, `${basename(d)}.uproject`), '{}'); }
	const ft = (ms) => (ms + 11644473600000) * 10000;
	const T = Date.parse('2026-10-09T10:00:00Z');
	const ed = (pid, proj, gui = true) => ({ p: pid, q: 1, n: gui ? 'UnrealEditor.exe' : 'UnrealEditor-Cmd.exe', c: `"C:\\UE\\UnrealEditor${gui ? '' : '-Cmd'}.exe" "${join(proj, basename(proj) + '.uproject')}" -x`, s: ft(T + pid) });
	const procs = [
		{ p: 1, q: 0, n: 'explorer.exe', c: 'explorer', s: ft(T - 9e6) },
		{ p: 100, q: 1, n: 'claude.exe', c: 'claude', s: ft(T - 5e6) },        // me
		{ p: 101, q: 100, n: 'bash.exe', c: 'bash', s: ft(T - 4e6) },
		{ p: 102, q: 101, n: 'node.exe', c: 'node x', s: ft(T - 3e6) },
		{ p: 200, q: 1, n: 'claude.exe', c: 'claude', s: ft(T - 5e6) },        // another session
		ed(300, A), ed(301, A, false), ed(302, B), ed(303, B, false), ed(304, B),
		{ ...ed(305, A, false), q: 102 },                                       // launched by my script, still its child
		{ ...ed(306, A, false), q: 777 },                                       // launcher already exited
		{ p: 400, q: 102, n: 'dotnet.exe', c: 'dotnet "C:\\UE\\UnrealBuildTool.dll" ProjAEditor', s: ft(T) },
		{ p: 500, q: 888, n: 'timeout.exe', c: 'timeout 60 node x', s: ft(T - 2e6) },  // its bash fork has exited
		{ p: 501, q: 500, n: 'node.exe', c: 'node x', s: ft(T - 2e6 + 5) },
	];
	const snap = procs.map((r) => ({ pid: r.p, ppid: r.q, name: r.n.toLowerCase(), cmd: r.c, start: filetimeToMs(r.s) }));
	const me = whoAmI(snap, 102);
	eq(me?.pid, 100, 'whoAmI finds the nearest claude.exe');
	eq(whoAmI(snap, 102, { CLAUDE_PID: '200' })?.pid, 100, 'a claude.exe above wins over CLAUDE_PID');
	eq(whoAmI(snap, 501, {}), null, 'a chain broken by timeout.exe, no CLAUDE_PID: no session');
	eq(whoAmI(snap, 501, { CLAUDE_PID: '100' }), { pid: 100, start: snap[1].start }, 'a chain broken by timeout.exe: CLAUDE_PID names the session');
	eq(whoAmI(snap, 501, { CLAUDE_PID: '1' }), null, 'CLAUDE_PID that is not a claude.exe is ignored');
	eq(whoAmI(snap, 501, { CLAUDE_PID: '4242' }), null, 'CLAUDE_PID of a gone process is ignored');
	const mk = (proj, pid, owner) => writeMarker(proj, { pid, start: filetimeToMs(ft(T + pid)), image: 'x', gui: true, project: proj, owner });
	mk(A, 300, { pid: 100, start: snap[1].start });                       // mine, GUI
	mk(B, 302, { pid: 200, start: snap[4].start });                       // another live session
	mk(B, 303, { pid: 999, start: 1 });                                   // orphan headless
	mk(B, 304, { pid: 999, start: 1 });                                   // orphan GUI
	const st = Object.fromEntries(editors(snap, me).map((e) => [e.pid, e.state]));
	eq(st, { 300: 'mine', 301: 'human', 302: 'agent', 303: 'orphan', 304: 'orphan', 305: 'human', 306: 'human' }, 'editor states');
	eq(canStop(snap, me, 300).ok, true, 'stop my editor');
	eq(canStop(snap, me, 301).ok, false, 'never stop a person\'s editor');
	eq(canStop(snap, me, 302).ok, false, 'never stop another session\'s editor');
	eq(canStop(snap, me, 303).adopt, true, 'a headless orphan is adopted');
	eq(canStop(snap, me, 304).ok, false, 'a GUI orphan is left to people');
	eq(canStop(snap, me, 102).notEditor, true, 'a non-editor pid passes');
	eq(canLaunch(snap, me, A).reuse, 300, 'launch while my editor of this project runs -> reuse it');
	eq(canLaunch(snap, me, join(root, 'ProjC')).ok, false, 'launch while another project has a person\'s editor -> wait');
	eq(canLaunch(snap, me, join(root, 'ProjC'), { alongside: true }).ok, true, 'alongside when the person allowed it');
	eq(canBuild(snap, me, A).ok, false, 'editor build while an editor of the project runs');
	eq(canBuild(snap, me, B, { editorTarget: false }).ok, true, 'my own build does not block me; a game target ignores editors');
	const other = whoAmI(snap, 200);
	eq(canBuild(snap, other, B, { editorTarget: false }).ok, false, 'another session waits for my build');
	eq(claim(snap, me, 302).ok, false, 'cannot claim another live session\'s editor');
	eq(claim(snap, me, 301).ok, false, 'never claim a person\'s editor (launched from Explorer)');
	eq(claim(snap, me, 304).ok, false, 'never adopt a GUI orphan');
	eq(claim(snap, me, 305).ok, true, 'claim an editor my script launched');
	eq(editors(snap, me).find((e) => e.pid === 305).state, 'mine', 'claimed -> mine');
	eq(claim(snap, me, 306, { since: T + 306 + 60000 }).ok, false, 'never claim a detached editor started before my call');
	eq(claim(snap, me, 306, { since: T + 306 - 1000 }).ok, true, 'claim a detached editor started inside my call');
	eq(uprojectOfCmd('"C:\\a b\\X.uproject" -game'), 'C:\\a b\\X.uproject', 'quoted .uproject');
	eq(uprojectOfCmd('UnrealEditor.exe C:\\p\\Y.uproject -run=x'), 'C:\\p\\Y.uproject', 'bare .uproject');
	pruneMarkers(B, snap.filter((p) => p.pid !== 303));
	eq(existsSync(join(B, MarkerDirName, '303.json')), false, 'a marker of a gone editor is pruned');
	rmSync(root, { recursive: true, force: true });

	const here = fileURLToPath(import.meta.url);
	const repo = resolve(dirname(here), '..', '..', '..', '..', '..'); // <plugin>/skills/<skill>/scripts/mjs
	const mineText = readFileSync(here, 'utf8');
	for (const s of Siblings) {
		const p = join(repo, s, 'skills', s, 'scripts', 'mjs', 'ue-owner.mjs');
		if (existsSync(p) && readFileSync(p, 'utf8') !== mineText) fails.push(`${s}/skills/${s}/scripts/mjs/ue-owner.mjs differs from this copy - copy the master (ue-workstation) over it`);
	}
	return { n, fails };
}

// --- CLI --------------------------------------------------------------------------------------------------------

function cli(argv) {
	const flag = (f) => argv.includes(f);
	const opt = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
	const cmd = argv.find((a) => !a.startsWith('--') && a !== opt('--project'));
	if (flag('--selftest')) {
		const { n, fails } = selftest();
		for (const f of fails) console.log(`  FAIL ${f}`);
		console.log(fails.length ? `ue-owner selftest: ${fails.length} of ${n} failed` : `ue-owner selftest: ok (${n} checks)`);
		return fails.length ? 1 : 0;
	}
	const project = opt('--project') ? resolve(opt('--project')) : findProjectRoot();
	const snap = snapshot();
	if (!snap) { console.log('the process query failed - nothing can be attributed; do not stop or start an editor blind'); return 2; }
	const me = whoAmI(snap);
	const arg = argv[argv.indexOf(cmd) + 1];
	const say = (v) => { console.log(v.ok ? `ALLOWED${v.note ? `: ${v.note}` : ''}` : `REFUSED: ${v.reason}`); return v.ok ? 0 : 1; };
	switch (cmd) {
		case 'whoami':
			console.log(me ? `claude pid ${me.pid}` : 'no claude.exe above this process');
			return me ? 0 : 1;
		case 'status': {
			if (project) pruneMarkers(project, snap);
			const es = editors(snap, me);
			const bs = builds(snap, me);
			console.log(`me      : ${me ? `claude pid ${me.pid}` : 'no claude.exe above this process'}`);
			console.log(`project : ${project ?? '(none found)'}`);
			if (!es.length) console.log('editors : none');
			for (const e of es) console.log(`editor  : ${describeEditor(e)}${sameProject(e.project, project) ? '  <- this project' : ''}`);
			for (const b of bs) console.log(`build   : UnrealBuildTool pid ${b.pid} (${b.mine ? 'ours' : 'not ours'})`);
			return 0;
		}
		case 'can-launch':
			if (!project) { console.log('no project found (--project DIR)'); return 2; }
			return say(canLaunch(snap, me, project, { alongside: flag('--alongside') }));
		case 'can-stop':
			if (!/^\d+$/.test(arg ?? '')) { console.log('usage: can-stop <pid>'); return 2; }
			return say(canStop(snap, me, Number(arg)));
		case 'can-build':
			if (!project) { console.log('no project found (--project DIR)'); return 2; }
			return say(canBuild(snap, me, project, { editorTarget: !flag('--game') }));
		case 'claim': {
			if (!/^\d+$/.test(arg ?? '')) { console.log('usage: claim <pid>'); return 2; }
			const r = claim(snap, me, Number(arg), { projectRoot: project });
			console.log(r.ok ? `claimed editor pid ${arg} for claude pid ${me.pid}` : `REFUSED: ${r.reason}`);
			return r.ok ? 0 : 1;
		}
		case 'port-owner': {
			if (!/^\d+$/.test(arg ?? '') || !project) { console.log('usage: port-owner <port> [--project DIR]'); return 2; }
			const v = checkPort(snap, me, project, Number(arg));
			if (v.ok && v.pid) console.log(`ALLOWED: editor pid ${v.pid} (${v.state}${v.editor ? `: ${describeEditor(v.editor)}` : ''})`);
			else return say(v);
			return 0;
		}
		default:
			console.log('usage: ue-owner.mjs status|can-launch|can-stop <pid>|can-build|claim <pid>|port-owner <port>|whoami [--project DIR] | --selftest');
			return 2;
	}
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
	process.exit(cli(process.argv.slice(2)));
}
