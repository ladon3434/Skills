// ue-proc.mjs — "is an Unreal Editor of THIS project running, which pid, GUI or headless?", self-contained.
// ONE file, copied byte for byte into every plugin that needs it (plugins install on their own); the master is
// ue-workstation/skills/ue-workstation/scripts/mjs/ and skill-lint fails when a copy differs.
//
// Several projects share one machine and every editor runs from the same executable, so an image-name probe
// cannot tell them apart. The editor is started as `UnrealEditor[-Cmd].exe <path>\<Name>.uproject ...`, so the
// owning project is in the command line: a process is ours when its command line contains `<project root>\`.
//
// Three answers are kept apart because callers need opposite reactions to them:
//   pids    — processes whose command line names this project: ours.
//   opaque  — editor processes whose command line cannot be read (elevated, another user, exiting): never
//             claimed, but counted, so a destructive caller can refuse instead of guessing.
//   precise — false when the query itself failed (no CIM, denied); then nothing can be attributed at all.
//
// No shell pipes: tasklist / powershell / ps are spawned directly with windowsHide (a piped probe from a hidden
// console pops a visible window).
//
// Tests: UE_WS_PROC_FIXTURE=<file.json> replaces the live query with rows [{image, pid, cmd, start?}] — the hooks
// and safe-pull are tested against synthetic process lists, never against a real editor.
//
// CLI:
//   node ue-proc.mjs [--root <dir>]        prints one line per editor of the project, or "no editor ..."; exit 0
//   node ue-proc.mjs --editor-open [--root <dir>]   prints ONE line when an editor of the project runs, else nothing
//   node ue-proc.mjs --selftest            matcher tests over synthetic process lists + one live query

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const IsWindows = process.platform === 'win32';
export const GuiEditor = IsWindows ? 'UnrealEditor.exe' : 'UnrealEditor';
export const HeadlessEditor = IsWindows ? 'UnrealEditor-Cmd.exe' : 'UnrealEditor-Cmd';

/** Normalised lower-case path with backslashes and no trailing separator. */
function norm(p) {
	return String(p).replace(/[\\/]+/g, '\\').replace(/\\+$/, '').toLowerCase();
}

/**
 * PURE: which of `rows` are editors of the project at `projectRoot`.
 * @param {{image: string, pid: number, cmd: string|null, start?: number|null}[]} rows every editor process
 * @param {string} projectRoot absolute project folder (the .uproject's folder or the repository root above it)
 * @returns {{gui: number[], headless: number[], pids: number[], opaque: number, foreign: number, start: Map<number, number|null>}}
 */
export function matchProjectEditors(rows, projectRoot) {
	const needle = norm(projectRoot) + '\\';
	const gui = [];
	const headless = [];
	const start = new Map();
	let opaque = 0;
	let foreign = 0;
	for (const r of rows) {
		const image = basename(String(r.image ?? '')).toLowerCase();
		const isGui = image === GuiEditor.toLowerCase();
		const isHeadless = image === HeadlessEditor.toLowerCase();
		if (!isGui && !isHeadless) continue;
		if (typeof r.cmd !== 'string' || !r.cmd.trim()) {
			opaque++;
			continue;
		}
		// Quotes do not matter: the needle is a substring of the quoted path too.
		if (!norm(r.cmd).includes(needle)) {
			foreign++;
			continue;
		}
		const pid = Number(r.pid);
		(isGui ? gui : headless).push(pid);
		start.set(pid, typeof r.start === 'number' ? r.start : null);
	}
	return { gui, headless, pids: [...new Set([...gui, ...headless])], opaque, foreign, start };
}

/**
 * Every Unreal Editor process on this machine with its command line and start time (ms epoch, Windows only),
 * or null when the query failed.
 * @returns {{image: string, pid: number, cmd: string|null, start: number|null}[]|null}
 */
export function listEditorProcesses(env = process.env) {
	if (env.UE_WS_PROC_FIXTURE) {
		try {
			return JSON.parse(readFileSync(env.UE_WS_PROC_FIXTURE, 'utf8'));
		} catch {
			return null;
		}
	}
	if (!IsWindows) {
		let out;
		try {
			out = execFileSync('ps', ['-axo', 'pid=,comm=,args='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 << 20 });
		} catch {
			return null;
		}
		const rows = [];
		for (const line of out.split('\n')) {
			const m = line.match(/^\s*(\d+)\s+(\S+)\s+(.*)$/);
			if (!m) continue;
			const image = basename(m[2]);
			if (image !== GuiEditor && image !== HeadlessEditor) continue;
			rows.push({ image, pid: Number(m[1]), cmd: m[3].length > m[2].length ? m[3] : null, start: null });
		}
		return rows;
	}
	// Cheap first: tasklist answers in ~100 ms; the CIM query (PowerShell start) only runs when an editor exists.
	let list;
	try {
		list = execFileSync('tasklist', ['/FI', 'IMAGENAME eq UnrealEditor*', '/NH', '/FO', 'CSV'], {
			encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
		});
	} catch {
		return null;
	}
	if (!/^"UnrealEditor/im.test(list)) return [];
	let json;
	try {
		json = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
			"Get-CimInstance Win32_Process -Filter \"Name='UnrealEditor.exe' OR Name='UnrealEditor-Cmd.exe'\" | Select-Object Name,ProcessId,CommandLine,@{n='Start';e={if($_.CreationDate){$_.CreationDate.ToUniversalTime().ToString('o')}}} | ConvertTo-Json -Compress"],
		{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 20000 });
	} catch {
		return null;
	}
	try {
		const parsed = JSON.parse(json.trim() || 'null');
		const rows = parsed === null ? [] : Array.isArray(parsed) ? parsed : [parsed];
		return rows.map((r) => ({
			image: r?.Name,
			pid: Number(r?.ProcessId),
			cmd: typeof r?.CommandLine === 'string' ? r.CommandLine : null,
			start: typeof r?.Start === 'string' ? Date.parse(r.Start) : null,
		}));
	} catch {
		return null;
	}
}

/** Pids of every running editor of this image (GuiEditor or HeadlessEditor), any project; [] when the query failed. */
export function pidsOf(imageName, env = process.env) {
	const want = String(imageName).toLowerCase();
	return (listEditorProcesses(env) ?? []).filter((r) => String(r.image ?? '').toLowerCase() === want).map((r) => Number(r.pid));
}

/** Editors of one project: {gui, headless, pids, opaque, foreign, start, precise}. */
export function editorsOfProject(projectRoot, env = process.env) {
	const rows = listEditorProcesses(env);
	if (rows === null) return { gui: [], headless: [], pids: [], opaque: 0, foreign: 0, start: new Map(), precise: false };
	return { ...matchProjectEditors(rows, projectRoot), precise: true };
}

/** One human line for a non-empty answer, '' when nothing of ours runs. */
export function describe(probe) {
	const parts = [];
	if (probe.gui.length) parts.push(`GUI editor pid ${probe.gui.join(', ')}`);
	if (probe.headless.length) parts.push(`headless editor pid ${probe.headless.join(', ')}`);
	return parts.join('; ');
}

/** `describe`, plus the editors that cannot be attributed; '' when nothing of ours and nothing unreadable runs. */
export function describeEditors(probe) {
	const parts = [describe(probe)].filter(Boolean);
	if (probe.opaque) parts.push(`${probe.opaque} editor process(es) whose command line cannot be read (possibly this project's)`);
	if (!probe.precise) parts.push('process command lines could not be read at all');
	return parts.join('; ');
}

/** Self-checks; returns the failures ([] = passed). */
export function selftest() {
	const fails = [];
	const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) fails.push(`${m}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); };
	const G = GuiEditor, H = HeadlessEditor;
	const rows = [
		{ image: G, pid: 10, cmd: `"C:\\Program Files\\Epic Games\\UE_5.8\\Engine\\Binaries\\Win64\\${G}" "C:\\Projects\\Game\\Game.uproject"`, start: 1000 },
		{ image: H, pid: 11, cmd: `${H} C:/Projects/Game/Game.uproject -unattended -RenderOffScreen` },
		{ image: G, pid: 20, cmd: `${G} "C:\\Projects\\Game2\\Game2.uproject"` },
		{ image: G, pid: 30, cmd: null },
		{ image: 'node.exe', pid: 40, cmd: 'node C:\\Projects\\Game\\x.js' },
	];
	const a = matchProjectEditors(rows, 'C:\\Projects\\Game');
	eq(a.gui, [10], 'the GUI editor of the project, quoted path');
	eq(a.headless, [11], 'the headless editor, forward slashes in its command line');
	eq(a.pids, [10, 11], 'union of both');
	eq(a.opaque, 1, 'a process without a command line is counted, not claimed');
	eq(a.foreign, 1, "a neighbour's editor is counted as foreign");
	eq([a.start.get(10), a.start.get(11)], [1000, null], 'start times carried, null when unknown');
	eq(matchProjectEditors(rows, 'c:/projects/game/').pids, [10, 11], 'root spelling and case do not matter');
	eq(matchProjectEditors(rows, 'C:\\Projects\\Game2').pids, [20], 'a neighbour whose name extends ours is not ours, and vice versa');
	eq(matchProjectEditors(rows, 'C:\\Projects\\Other').pids, [], 'a project nothing runs under');
	eq(matchProjectEditors([], 'C:\\Projects\\Game').pids, [], 'no editors at all');
	eq(describe(a), 'GUI editor pid 10; headless editor pid 11', 'the one-line description');
	eq(describe(matchProjectEditors([], 'C:\\x')), '', 'silence means nothing of ours');
	eq(describeEditors({ ...a, precise: true }), "GUI editor pid 10; headless editor pid 11; 1 editor process(es) whose command line cannot be read (possibly this project's)", 'the long description names the unreadable ones');
	eq(describeEditors({ gui: [], headless: [], opaque: 0, precise: false }), 'process command lines could not be read at all', 'a failed query is said');
	eq(listEditorProcesses({}) !== null, true, 'the live process query works on this machine');
	return fails;
}

const runAsScript = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (runAsScript) {
	const argv = process.argv.slice(2);
	const argOf = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
	if (argv.includes('--selftest')) {
		const fails = selftest();
		if (fails.length) console.log(`ue-proc self-test FAILED:\n  ${fails.join('\n  ')}`);
		else console.log('ue-proc self-test: ok');
		process.exitCode = fails.length ? 1 : 0;
	} else if (argv.includes('--help') || argv.includes('-h')) {
		console.log('usage: ue-proc [--root <project dir>] [--editor-open] | --selftest');
	} else {
		const root = argOf('--root') ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
		const probe = editorsOfProject(root);
		const line = describe(probe);
		if (argv.includes('--editor-open')) {
			if (probe.precise && line) console.log(line);
		} else if (!probe.precise) {
			console.log('cannot tell: the process query failed on this machine');
		} else {
			console.log(line || `no editor of ${root} is running`);
			if (probe.opaque) console.log(`${probe.opaque} editor process(es) hide their command line - possibly ours`);
		}
	}
}
