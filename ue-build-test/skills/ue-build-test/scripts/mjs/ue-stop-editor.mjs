// ue-stop-editor — closes THIS project's editor gracefully and waits until its module DLLs are released.
//
// Usage: ue-stop-editor.cmd [--project p] [--pid N[,M]] [--gui] [--force] [--timeout s] [--dry-run]
//   default   this project's HEADLESS editors that this session may stop
//   --gui     also this project's GUI editor — only when this session started it
//   --pid     exactly these editors (any project), still only when this session may stop them; this is how a
//             headless editor left by an ended session (an orphan) is stopped
//   --force   LAST RESORT, after the graceful close timed out: hard kill. Unsaved work is lost, and the next
//             GUI start shows the «restore packages?» modal that only a person can dismiss.
//   --timeout seconds to wait for the graceful close (default 240: closing writes caches for minutes)
//
// Ownership (ue-owner canStop): an editor is stopped only when this session started it (its marker in
// <project>/Saved/AgentEditors names this Claude Code process), or when it is a headless editor of an ended
// session, which is adopted. A person's editor, another live session's, a GUI editor of an ended session — never.
// Before closing MY GUI editor: refused while it is the foreground window (a person is looking at it), and
// refused while the editor's MCP server reports dirty packages (VibeUE's execute_python_code) — closing a
// dirty editor shows «save changes?» and waits forever.
//
// Graceful, in order: CloseMainWindow (what clicking X does) -> for a console editor without a window,
// a console Ctrl+Break (UE's own console handler: it broadcasts ApplicationWillTerminate, flushes the log
// and terminates; nothing is saved, so this is for agent editors with nothing unsaved).
//
// Exit: 0 stopped (or nothing ran), 1 still running after the timeout, 2 refused, 3 only editors that are
// not ours run.

import { execFileSync, spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { closeSync, existsSync, openSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canStop, claim, describeEditor, editors as ownedEditors, foregroundPid, portOwner, pruneMarkers, sameProject, snapshot, whoAmI } from './ue-owner.mjs';
import { pidsOf, GuiEditor, HeadlessEditor } from './ue-proc.mjs';
import { HostPlatform, locateProject, parseArgs } from './ue-tools.mjs';

const IsWindows = process.platform === 'win32';

/** PowerShell that asks a process to close its main window; prints closed|refused|nowindow|gone. */
export function closeWindowScript(pid) {
	return `$p = Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue; if (-not $p) { 'gone' } elseif ($p.MainWindowHandle -eq 0) { 'nowindow' } elseif ($p.CloseMainWindow()) { 'closed' } else { 'refused' }`;
}

/**
 * PowerShell that raises a console Ctrl+Break in the console the process owns (and only that console):
 * detach from ours, attach to its, survive the event ourselves (a handler that returns true), raise it.
 * Ctrl+BREAK, not Ctrl+C: a process can inherit «ignore Ctrl+C» from its launcher (tool runners do), and then
 * Ctrl+C never arrives; Break cannot be ignored that way. UE treats both the same for an -unattended editor
 * (WindowsPlatformMisc ConsoleCtrlHandler: request exit, broadcast ApplicationWillTerminate, flush the log,
 * terminate). Prints sent|failed|noattach.
 */
export function ctrlBreakScript(pid) {
	const cs = [
		'using System; using System.Runtime.InteropServices; using System.Threading;',
		'public static class UeStopBreak {',
		' public delegate bool Handler(uint t);',
		' [DllImport("kernel32.dll")] static extern bool FreeConsole();',
		' [DllImport("kernel32.dll")] static extern bool AttachConsole(uint p);',
		' [DllImport("kernel32.dll")] static extern bool SetConsoleCtrlHandler(Handler h, bool add);',
		' [DllImport("kernel32.dll")] static extern bool GenerateConsoleCtrlEvent(uint e, uint g);',
		' static Handler keep = t => true;',
		' public static string Send(uint pid) {',
		'  FreeConsole(); if (!AttachConsole(pid)) return "noattach";',
		'  SetConsoleCtrlHandler(keep, true); bool ok = GenerateConsoleCtrlEvent(1, 0);',
		'  Thread.Sleep(700); FreeConsole(); return ok ? "sent" : "failed"; } }',
	].join(' ');
	return `Add-Type -TypeDefinition '${cs}'; [UeStopBreak]::Send(${Number(pid)})`;
}

function ps(script) {
	try {
		return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
			windowsHide: true,
		}).trim();
	} catch {
		return 'error';
	}
}

/** Graceful close request for one pid. Returns a word describing what happened. */
export function askToClose(pid, { headless }) {
	if (!IsWindows) {
		try {
			process.kill(pid, headless ? 'SIGINT' : 'SIGTERM');
			return 'signalled';
		} catch {
			return 'gone';
		}
	}
	const w = ps(closeWindowScript(pid));
	if (w === 'closed' || w === 'gone') return w;
	if (w === 'nowindow' && headless) return `ctrl-break ${ps(ctrlBreakScript(pid))}`;
	return w;
}

function alive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return e.code === 'EPERM';
	}
}

/** The module binaries an editor of this project maps: Binaries/<Platform>/*.dll of the project and its source plugins. */
export function moduleBinaries(projectDir) {
	const ext = IsWindows ? /\.dll$/i : /\.(so|dylib)$/i;
	const dirs = [join(projectDir, 'Binaries', HostPlatform)];
	const plugins = join(projectDir, 'Plugins');
	if (existsSync(plugins)) {
		let entries = [];
		try {
			entries = readdirSync(plugins, { recursive: true, encoding: 'utf8' });
		} catch {
			entries = [];
		}
		for (const rel of entries) if (/\.uplugin$/i.test(rel)) dirs.push(join(plugins, dirname(rel), 'Binaries', HostPlatform));
	}
	const out = [];
	for (const d of dirs) {
		let files = [];
		try {
			files = readdirSync(d);
		} catch {
			continue;
		}
		for (const f of files) if (ext.test(f)) out.push(join(d, f));
	}
	return out;
}

/** Binaries that cannot be opened for writing right now (still mapped by some process). */
export function lockedBinaries(files) {
	const locked = [];
	for (const f of files) {
		try {
			closeSync(openSync(f, 'r+'));
		} catch (e) {
			if (e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES') locked.push(f);
		}
	}
	return locked;
}

/** Size of the newest log in Saved/Logs — grows while the engine works, freezes on a modal dialog. */
function newestLogSize(projectDir) {
	const dir = join(projectDir, 'Saved', 'Logs');
	let best = { m: 0, size: 0 };
	try {
		for (const f of readdirSync(dir)) {
			if (!f.endsWith('.log')) continue;
			const s = statSync(join(dir, f));
			if (s.mtimeMs > best.m) best = { m: s.mtimeMs, size: s.size };
		}
	} catch {
		/* no logs */
	}
	return best.size;
}

/** UTF-16LE without BOM: the restore list the next GUI start turns into a modal. Null when unreadable. */
export function pendingRestore(projectDir) {
	const f = join(projectDir, 'Saved', 'Autosaves', 'PackageRestoreData.json');
	if (!existsSync(f)) return null;
	try {
		let text = readFileSync(f).toString('utf16le');
		if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
		const d = JSON.parse(text);
		return { enabled: Boolean(d.RestoreEnabled), packages: Array.isArray(d.Packages) ? d.Packages.length : Object.keys(d.Packages ?? {}).length };
	} catch {
		return null;
	}
}

/** The MCP port of a project: UE_MCP_PORT, else ServerPortNumber from the per-user then the default settings, else 8000. */
export function mcpPort(projectDir, env = process.env) {
	if (/^\d+$/.test(env.UE_MCP_PORT ?? '')) return Number(env.UE_MCP_PORT);
	const files = [
		join(projectDir, 'Saved', 'Config', 'WindowsEditor', 'EditorPerProjectUserSettings.ini'),
		join(projectDir, 'Config', 'DefaultEditorPerProjectUserSettings.ini'),
	];
	for (const f of files) {
		let text;
		try {
			text = readFileSync(f, 'utf8');
		} catch {
			continue;
		}
		let inSection = false;
		for (const raw of text.split(/\r?\n/)) {
			const line = raw.trim();
			if (line.startsWith('[')) inSection = line === '[/Script/ModelContextProtocolEngine.ModelContextProtocolSettings]';
			else if (inSection) {
				const m = line.match(/^ServerPortNumber\s*=\s*(\d+)/i);
				if (m) return Number(m[1]);
			}
		}
	}
	return 8000;
}

/** The body of an MCP HTTP answer (plain JSON or the last `data:` line of an event stream). */
export function mcpBody(text) {
	const t = String(text ?? '').trim();
	if (t.startsWith('{')) return JSON.parse(t);
	const data = t.split(/\r?\n/).filter((l) => l.startsWith('data:')).pop();
	return data ? JSON.parse(data.slice(5)) : null;
}

/** The text of a tools/call result; a JSON text is parsed. */
function resultValue(body) {
	const text = (body?.result?.content ?? []).map((c) => c.text ?? '').join('');
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

/**
 * Dirty packages of the editor `pid`: {maps, content, checked} | {skipped: reason}. Asked through Epic's toolsets
 * (AssetTools.is_dirty over the open asset editors and the current level), NOT through execute_python_code: VibeUE
 * saves every dirty package before it runs any python, so a python probe would save the person's work and then
 * report «clean». Packages dirty without an open editor (a Blueprint left dirty by a graph read) are not seen.
 */
export async function dirtyPackages(projectDir, pid) {
	const s = await mcpSession(projectDir, pid);
	if (s.skipped) return s;
	try {
		const open = resultValue(await s.tool('EditorToolset.EditorAppToolset', 'GetOpenAssets', {}))?.returnValue ?? [];
		const level = resultValue(await s.tool('editor_toolset.toolsets.scene.SceneTools', 'get_current_level', {}))?.returnValue ?? null;
		const paths = [...new Set((Array.isArray(open) ? open : []).map((a) => (typeof a === 'string' ? a : a?.path ?? a?.asset_path ?? a?.object_path)).filter((p) => p && !/^\/(Engine|Temp|Script)\//i.test(p)))];
		const out = { maps: [], content: [], unknown: [], checked: paths.length + (level ? 1 : 0) };
		const dirty = async (p) => {
			const body = await s.tool('editor_toolset.toolsets.asset.AssetTools', 'is_dirty', { asset_path: p });
			const v = body?.error || body?.result?.isError ? undefined : resultValue(body)?.returnValue;
			if (v === undefined) out.unknown.push(p);
			return v === true;
		};
		for (const p of paths) if (await dirty(p)) out.content.push(p);
		if (level && (await dirty(level))) out.maps.push(level);
		return out;
	} catch (e) {
		return { skipped: `the toolset calls failed (${e?.message ?? e})` };
	}
}

/**
 * Asks the editor `pid` to quit through its own MCP server (quit_editor). The graceful way for an editor without a
 * window or a console to signal — a detached start (Node `detached`, the MCP bridge) leaves it with neither.
 * VibeUE saves every dirty package before it runs any python, so quitting through python would write the dirty state to
 * disk — a map that loaded with LoadErrors would lose its references for good. Dirty packages are asked with toolsets
 * first, and the quit is not sent while any are found or the check fails.
 */
export async function quitThroughMcp(projectDir, pid) {
	const d = await dirtyPackages(projectDir, pid);
	if (d.skipped) return `mcp quit not done - the dirty-package check failed (${d.skipped}); python would save whatever is dirty`;
	const dirty = [...d.maps, ...d.content];
	if (dirty.length) return `mcp quit not done - unsaved packages: ${dirty.join(', ')}. Python would save them first; decide what to keep, then stop again`;

	const s = await mcpSession(projectDir, pid);
	if (s.skipped) return `mcp quit not possible - ${s.skipped}`;
	try {
		const body = await s.raw('execute_python_code', { code: "import unreal\nunreal.SystemLibrary.quit_editor()\nprint('QUIT')" });
		if (body?.error) return `mcp quit not possible - no python tool (${body.error.message ?? 'error'})`;
	} catch {
		/* the connection may drop while the editor quits */
	}
	return 'mcp quit requested';
}

/** An MCP session with the editor `pid` on the project's port: {tool, raw} | {skipped: reason}. Only that very editor. */
async function mcpSession(projectDir, pid) {
	const port = mcpPort(projectDir);
	const listener = portOwner(port);
	if (listener !== pid) return { skipped: listener ? `port ${port} is answered by pid ${listener}, not by this editor` : `nothing listens on port ${port}` };
	const url = `http://127.0.0.1:${port}/mcp`;
	const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Connection: 'close' };
	let sid;
	try {
		const init = await fetch(url, { method: 'POST', headers, signal: AbortSignal.timeout(15000), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'ue-stop-editor', version: '1' } } }) });
		sid = init.headers.get('mcp-session-id');
		await init.text();
		if (!sid) return { skipped: 'the MCP server gave no session id' };
		await fetch(url, { method: 'POST', headers: { ...headers, 'Mcp-Session-Id': sid }, signal: AbortSignal.timeout(15000), body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) }).then((r) => r.text());
	} catch (e) {
		return { skipped: `the MCP server did not answer (${e?.message ?? e})` };
	}
	let id = 1;
	const raw = async (name, args) => {
		const r = await fetch(url, { method: 'POST', headers: { ...headers, 'Mcp-Session-Id': sid }, signal: AbortSignal.timeout(60000), body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }) });
		return mcpBody(await r.text());
	};
	const tool = async (toolset, name, args) => {
		const viaSearch = await raw('call_tool', { toolset_name: toolset, tool_name: name, arguments: args });
		if (!/unknown tool|not found|-32601/i.test(JSON.stringify(viaSearch?.error ?? ''))) return viaSearch;
		return raw(`${toolset}.${name}`, args);
	};
	return { tool, raw };
}

async function main() {
	const args = parseArgs(process.argv.slice(2), {
		project: {},
		pid: {},
		gui: { type: 'bool' },
		force: { type: 'bool' },
		timeout: { default: '240' },
		'dry-run': { type: 'bool' },
		help: { type: 'bool' },
	});
	if (args.help) {
		console.log('usage: ue-stop-editor.cmd [--project p] [--pid N[,M]] [--gui] [--force] [--timeout s] [--dry-run]');
		console.log('  default: this project\'s headless editors this session may stop; --gui: also its GUI editor, when this session started it;');
		console.log('  --pid: exactly these editors (an ended session\'s headless editor is adopted);');
		console.log('  --force: hard kill after the graceful close timed out (last resort; loses unsaved work).');
		console.log('  An editor this session did not start is never stopped.');
		return 0;
	}
	const pidList = args.pid ? String(args.pid).split(',').map((s) => s.trim()).filter(Boolean) : [];
	if (pidList.some((p) => !/^\d+$/.test(p))) {
		console.log(`usage: --pid takes numbers, got ${args.pid}`);
		return 2;
	}
	const loc = locateProject({ project: args.project });
	if (loc.error && !pidList.length) {
		console.log(loc.error);
		return 2;
	}
	const projectDir = loc.uproject ? dirname(loc.uproject) : null;
	const timeout = Math.max(5, Number(args.timeout) || 240);

	const snap = snapshot();
	if (!snap) {
		console.log('REFUSED: the process query failed, so no editor can be attributed. Not stopping anything blind.');
		return 2;
	}
	const me = whoAmI(snap);
	const all = ownedEditors(snap, me);
	const candidates = pidList.length
		? pidList.map(Number).map((pid) => all.find((e) => e.pid === pid) ?? { pid, missing: true })
		: all.filter((e) => sameProject(e.project, projectDir) && (args.gui || !e.gui));
	const targets = [];
	let refused = 0;
	for (const e of candidates) {
		if (e.missing) {
			console.log(`pid ${e.pid}: no such editor process.`);
			continue;
		}
		const v = canStop(snap, me, e.pid);
		if (!v.ok) {
			console.log(`LEFT ALONE: ${v.reason}`);
			refused++;
			continue;
		}
		targets.push({ pid: e.pid, headless: !e.gui, editor: e, adopt: v.adopt });
	}
	if (!pidList.length) {
		const guiHere = all.filter((e) => sameProject(e.project, projectDir) && e.gui && !args.gui);
		for (const g of guiHere) console.log(`NOTE: ${describeEditor(g)} is left alone without --gui.`);
		const opaque = all.filter((e) => e.state === 'opaque').length;
		if (!targets.length && !refused && !guiHere.length) {
			if (opaque) {
				console.log(`REFUSED: ${opaque} editor process(es) do not report a command line - one may be this project's. Not reporting «nothing running».`);
				return 2;
			}
			console.log('No editor of this project is running.');
			return 0;
		}
		if (!targets.length) return refused ? 2 : 3;
	} else if (!targets.length) return refused ? 2 : 0;

	for (const t of targets.filter((x) => !x.headless)) {
		if (foregroundPid() === t.pid) {
			console.log(`REFUSED: ${describeEditor(t.editor)} is the foreground window - a person is looking at it. Ask before closing.`);
			return 2;
		}
		const proj = t.editor.project ?? projectDir;
		const d = proj ? await dirtyPackages(proj, t.pid) : { skipped: 'the editor names no project' };
		if (d.unknown?.length) console.log(`pid ${t.pid}: could not ask about ${d.unknown.join(', ')}.`);
		if (d.skipped) console.log(`pid ${t.pid}: dirty-package check skipped - ${d.skipped}. If it has unsaved packages, closing stops on «save changes?».`);
		else if (d.maps.length || d.content.length) {
			console.log(`REFUSED: pid ${t.pid} has unsaved packages - closing would stop on «save changes?» and wait forever.`);
			if (d.maps.length) console.log(`  maps   : ${d.maps.join(', ')}`);
			if (d.content.length) console.log(`  content: ${d.content.join(', ')}`);
			console.log('  Save what this session changed, leave the rest to the person and tell them; then stop again.');
			return 2;
		} else console.log(`pid ${t.pid}: no dirty packages among ${d.checked} checked (open assets and the current level; a package dirty without an open editor is not seen).`);
	}

	if (args['dry-run']) {
		console.log(`Project : ${loc.uproject ?? '(by pid)'}`);
		for (const t of targets) {
			console.log(`pid ${t.pid} (${t.headless ? HeadlessEditor : GuiEditor}, ${t.adopt ? 'adopted from an ended session' : 'started by this session'}): ${t.headless ? 'CloseMainWindow, else console Ctrl+Break, else quit_editor through its MCP server' : 'CloseMainWindow'}; wait ${timeout}s` + (args.force ? `; then taskkill /PID ${t.pid} /F` : '; then report (no --force)'));
		}
		console.log('then: wait until the module DLLs can be opened for writing (max 30s)');
		return 0;
	}

	for (const t of targets.filter((x) => x.adopt)) {
		const c = claim(snap, me, t.pid);
		console.log(c.ok ? `pid ${t.pid}: adopted from an ended session.` : `pid ${t.pid}: not adopted - ${c.reason}`);
	}
	for (const t of targets) {
		const how = askToClose(t.pid, t);
		console.log(`pid ${t.pid}: ${how}`);
		if (/noattach|failed|error|refused|nowindow/.test(how)) {
			const proj = t.editor.project ?? projectDir;
			console.log(`pid ${t.pid}: ${proj ? await quitThroughMcp(proj, t.pid) : 'mcp quit not possible - the editor names no project'}`);
		}
	}
	const projects = [...new Set(targets.map((t) => t.editor.project ?? projectDir).filter(Boolean))];
	const logDir = projects[0] ?? projectDir;

	const started = Date.now();
	let lastSize = newestLogSize(logDir);
	let quietSince = Date.now();
	while (targets.some((t) => alive(t.pid)) && Date.now() - started < timeout * 1000) {
		await sleep(2000);
		const size = newestLogSize(logDir);
		if (size !== lastSize) {
			lastSize = size;
			quietSince = Date.now();
		}
	}
	const left = targets.filter((t) => alive(t.pid));
	if (left.length) {
		const quiet = Math.round((Date.now() - quietSince) / 1000);
		console.log(`Still running after ${timeout}s: pid ${left.map((t) => t.pid).join(', ')}; the newest log has not grown for ${quiet}s.`);
		console.log(quiet >= 60 ? 'It most likely stands on a modal dialog (save changes? / a crash reporter). Tell the person which; do not relaunch.' : 'It is still working (writing caches) - give it more time.');
		if (!args.force) {
			console.log('Not killing it. --force is the last resort: unsaved work is lost and the next GUI start shows the restore modal.');
			return 1;
		}
		for (const t of left) {
			console.log(`FORCE: hard-killing pid ${t.pid}.`);
			if (IsWindows) spawnSync('taskkill', ['/PID', String(t.pid), '/F'], { stdio: 'ignore', windowsHide: true });
			else {
				try {
					process.kill(t.pid, 'SIGKILL');
				} catch {
					/* gone */
				}
			}
		}
		for (let i = 0; i < 15 && left.some((t) => alive(t.pid)); i++) await sleep(1000);
		const r = pendingRestore(logDir);
		if (r && (r.enabled || r.packages)) console.log(`WARNING: Saved/Autosaves/PackageRestoreData.json lists ${r.packages} package(s): the next GUI start will show the restore modal - tell the person.`);
	}
	if (targets.some((t) => alive(t.pid))) {
		console.log('ERROR: the editor is still alive.');
		return 1;
	}

	// The process is gone; its DLL mappings go with it, but a straggler (a crash reporter, a child) can hold them.
	const after = snapshot();
	if (after) for (const p of projects) pruneMarkers(p, after);
	const bins = projects.flatMap((p) => moduleBinaries(p));
	let locked = lockedBinaries(bins);
	for (let i = 0; i < 15 && locked.length; i++) {
		await sleep(2000);
		locked = lockedBinaries(bins);
	}
	if (locked.length) {
		console.log(`WARNING: ${locked.length} module binary(ies) still locked, e.g. ${locked[0]} - a build would fail to link.`);
		return 1;
	}
	const others = pidsOf(GuiEditor).length + pidsOf(HeadlessEditor).length;
	console.log(`Stopped. Module binaries are free (${bins.length} checked).${others ? ` (${others} other editor process(es) left alone.)` : ''}`);
	return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = await main();
