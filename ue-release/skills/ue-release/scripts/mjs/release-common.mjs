// release-common.mjs — what the ue-release scripts share: arguments, the project, the engine, a tiny .ini reader
// and the one way a commandlet is started (dry-run first, never next to an editor of the same project).

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { projectInfo, resolveEngine } from './ue-engine.mjs';
import { describe, editorsOfProject } from './ue-proc.mjs';

/** argv -> { flags:Set, opts:Map, rest:[] } for `--flag`, `--opt value` / `--opt=value`. */
export function parseArgs(argv, valued = []) {
	const flags = new Set();
	const opts = new Map();
	const rest = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (!a.startsWith('--')) { rest.push(a); continue; }
		const eq = a.indexOf('=');
		const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
		if (eq > 0) opts.set(key, a.slice(eq + 1));
		else if (valued.includes(key) && i + 1 < argv.length) opts.set(key, argv[++i]);
		else flags.add(key);
	}
	return { flags, opts, rest };
}

/** The project from --project <dir|.uproject>, else the nearest .uproject above cwd / CLAUDE_PROJECT_DIR. */
export function resolveProject(opt) {
	let start = process.cwd();
	if (opt) {
		const p = resolve(opt);
		start = p.toLowerCase().endsWith('.uproject') ? resolve(p, '..') : p;
	}
	const info = projectInfo(start);
	if (!info) {
		console.error(`ERROR: no .uproject at or above ${start} - run from the project folder or pass --project <dir>`);
		process.exit(2);
	}
	return info;
}

export function editorCmd(project) {
	const engine = resolveEngine(process.env, project.root);
	if (engine.error) return { error: engine.error };
	const exe = join(engine.unrealHome, 'Engine', 'Binaries', 'Win64', 'UnrealEditor-Cmd.exe');
	if (!existsSync(exe)) return { error: `ERROR: ${exe} not found - broken engine install?` };
	return { exe, unrealHome: engine.unrealHome };
}

/**
 * Minimal UE .ini reader: { section: { key: [values...] } }. `+Key=` and `Key=` append, `-Key=` removes, `!Key`
 * clears; enough for the Default*.ini and Config/Localization/*.ini files this kit reads (no engine hierarchy).
 */
export function readIni(path) {
	const out = {};
	let text;
	try { text = readFileSync(path, 'utf8'); } catch { return null; }
	let sec = null;
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith(';') || line.startsWith('#')) continue;
		const s = line.match(/^\[(.+)\]$/);
		if (s) { sec = out[s[1]] ??= {}; continue; }
		if (!sec) continue;
		const m = line.match(/^([+\-!.]?)([^=]+?)\s*=\s*(.*)$/) ?? line.match(/^(!)(.+)$/);
		if (!m) continue;
		const [, op, key, value = ''] = m;
		const list = (sec[key] ??= []);
		if (op === '-') { const i = list.indexOf(value); if (i >= 0) list.splice(i, 1); }
		else if (op === '!') list.length = 0;
		else list.push(value);
	}
	return out;
}

/** First value of key in section, or undefined. */
export const iniValue = (ini, section, key) => ini?.[section]?.[key]?.at(-1);

/** Files under dir (recursive) whose name matches re; [] when dir is missing. */
export function findFiles(dir, re) {
	const hits = [];
	const walk = (d) => {
		let entries;
		try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
		for (const e of entries) {
			const p = join(d, e.name);
			if (e.isDirectory()) walk(p);
			else if (re.test(e.name)) hits.push(p);
		}
	};
	walk(dir);
	return hits;
}

export const mtime = (p) => { try { return statSync(p).mtimeMs; } catch { return 0; } };

/**
 * Run `UnrealEditor-Cmd <uproject> <args...>` — or only print it with dryRun. Refuses while an editor of this
 * project runs (the commandlet would fight it over Saved/, DDC and the files it writes). Returns the exit code.
 */
export function runCommandlet(project, args, { dryRun = false, label = 'commandlet' } = {}) {
	const ed = editorCmd(project);
	if (ed.error) { console.error(ed.error); return 2; }
	const argv = [project.uproject, ...args, '-unattended', '-nopause', '-nosplash', '-NullRHI', '-stdout', '-FullStdOutLogOutput'];
	const shown = [ed.exe, ...argv].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
	if (dryRun) {
		console.log(`[dry-run] ${label}: ${shown}`);
		return 0;
	}
	const probe = editorsOfProject(project.root);
	if (!probe.precise) {
		console.error(`REFUSED: cannot list processes - not starting ${label} blind next to an editor that may be running.`);
		return 3;
	}
	const running = describe(probe);
	if (running) {
		console.error(`REFUSED: an editor of ${project.name} runs (${running}) - close it (or wait for it), then re-run.`);
		return 3;
	}
	console.log(`${label}: ${shown}`);
	const r = spawnSync(ed.exe, argv, { stdio: 'inherit', windowsHide: true });
	if (r.error) { console.error(`ERROR: ${r.error.message}`); return 2; }
	return r.status ?? 1;
}
