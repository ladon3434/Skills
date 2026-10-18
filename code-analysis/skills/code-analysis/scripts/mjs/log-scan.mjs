// log-scan.mjs — post-mortem of Unreal build / cook / automation logs: the lines that matter, grouped, capped.
//
// WHY. A cook or UAT run that ends "SUCCESS" can still carry Blueprint compile warnings, broken asset references
// and `Accessed None` that ship to the player. The logs are tens of thousands of lines; reading them whole costs the
// context and still misses the one line. This prints only the suspicious lines, as `file:line`, grouped by kind,
// with a hard cap per file. A whole huge log to triage by eye goes to the `log-triage` agent instead.
//
// Sources (deduplicated):
//   - <project>/Saved/Logs/*.log, *.txt          (editor, commandlets, -LOG=<name>.log runs)
//   - %APPDATA% / %LOCALAPPDATA%\Unreal Engine\AutomationTool\Logs\**  (UAT: BuildCookRun, Cook-*.txt, UAT_Log.txt)
//   - <engine>/Engine/Programs/AutomationTool/Saved/Logs/*               (UAT run from the engine folder)
//   - --file <path> (repeatable)                                         (only these, nothing else)
// Which files: modified within --since <minutes>, else the --latest N newest (default 5). No snapshot file —
// "logs of the run I just did" is `--since <its duration>`.
//
// Exit: 0 nothing suspicious · 1 findings · 2 no project / no logs / bad arguments.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { findUproject, resolveEngine } from './ue-engine.mjs';

/** Kinds, checked in order: the first that matches names the line. */
export const Kinds = [
	{ kind: 'fatal', re: /Fatal error|Critical error|Unhandled Exception|Assertion failed|EXCEPTION_ACCESS_VIOLATION/i },
	{ kind: 'accessed-none', re: /Accessed None/i },
	{ kind: 'blueprint', re: /(Warning|Error):.*Blueprint|LogBlueprint.*(Warning|Error)|Compile failed|LogScript.*(Warning|Error)/i },
	{ kind: 'asset', re: /Failed to load|Failed to find|unresolved reference|is missing|Missing cached shader|Can't find file|Unable to load package/i },
	{ kind: 'package-version', re: /Mismatched package version|newer engine version|Package .* has newer custom version/i },
	{ kind: 'error', re: /\bError:/ },
];

/** Engine / third-party noise that matches a kind but is never actionable. */
export const Ignore = [
	/aqProf\.dll/i, /VtuneApi(32e)?\.dll/i, /WinPixGpuCapturer\.dll/i,
	// success summaries that contain a keyword: "with 0 errors and 0 warnings and 0 blueprints that failed to load"
	/\b0 errors? and 0 warnings?/i, /\b0 blueprints that failed to load/i,
];

/** PURE: the kind of a log line, or null. */
export function classify(line) {
	if (Ignore.some((r) => r.test(line))) return null;
	for (const k of Kinds) if (k.re.test(line)) return k.kind;
	return null;
}

function listFiles(dir, recurse, pred, out) {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const e of entries) {
		const p = join(dir, e.name);
		if (e.isDirectory()) {
			if (recurse) listFiles(p, recurse, pred, out);
		} else if (pred(e.name)) out.push(p);
	}
}

/** Every candidate log for the project, newest first, with its mtime. UAT log folders are per engine, shared by
 * every project on the machine: a UAT log counts only when it names this project (its .uproject name), unless allUat. */
export function candidateLogs(projectDir, env = process.env, { projectName = '', allUat = false } = {}) {
	const found = [];
	const isLog = (n) => /\.(log|txt)$/i.test(n);
	listFiles(join(projectDir, 'Saved', 'Logs'), false, isLog, found);
	const uat = [];
	for (const base of [env.APPDATA, env.LOCALAPPDATA].filter(Boolean)) {
		listFiles(join(base, 'Unreal Engine', 'AutomationTool', 'Logs'), true, isLog, uat);
	}
	const prevCwd = process.cwd();
	try {
		process.chdir(projectDir);
		const eng = resolveEngine(env);
		if (eng.unrealHome) listFiles(join(eng.unrealHome, 'Engine', 'Programs', 'AutomationTool', 'Saved', 'Logs'), false, isLog, uat);
	} catch {
		// no engine — the project's own logs still count
	} finally {
		process.chdir(prevCwd);
	}
	// "Names this project" = the .uproject file name or the project folder path (either slash), not the bare
	// project name: a short name like "Game" would match half the engine's log lines.
	const marks = [`${projectName}.uproject`, resolve(projectDir).replace(/\\/g, '/'), resolve(projectDir)]
		.map((m) => m.toLowerCase());
	const mine = (f) => {
		if (allUat || !projectName) return true;
		try {
			const text = readFileSync(f, 'utf8').toLowerCase();
			return marks.some((m) => text.includes(m));
		} catch {
			return false;
		}
	};
	found.push(...uat.filter(mine));
	const seen = new Set();
	const rows = [];
	for (const f of found) {
		const key = resolve(f).toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		try {
			rows.push({ path: f, mtime: statSync(f).mtimeMs });
		} catch {
			// vanished between listing and stat
		}
	}
	return rows.sort((a, b) => b.mtime - a.mtime);
}

/** PURE: a line without its timestamp prefix, addresses and numbers — repeats of one message share this key. */
export function messageKey(line) {
	return line.replace(/^\[[^\]]*\]\[\s*\d+\]/, '').replace(/0x[0-9a-f]+/gi, '#').replace(/\d+/g, '#').trim();
}

/** PURE over text: suspicious lines of one log; repeats of one message fold into the first, with a count. */
export function scanText(text) {
	const hits = [];
	const byKey = new Map();
	const lines = text.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const kind = classify(lines[i]);
		if (!kind) continue;
		const key = messageKey(lines[i]);
		const seen = byKey.get(key);
		if (seen) {
			seen.repeats++;
			continue;
		}
		const hit = { line: i + 1, kind, text: lines[i].trim(), repeats: 1 };
		byKey.set(key, hit);
		hits.push(hit);
	}
	return hits;
}

function usage(code) {
	console.log(`log-scan — suspicious lines of UE build / cook / automation logs, grouped and capped.

  log-scan [--project <dir>] [--since <minutes> | --latest <N>] [--file <path>]... [--max <N>] [--kind <k,...>]

  --project   project root (default: nearest folder with a .uproject above the current directory)
  --since     only logs modified in the last <minutes> (the run you just did)
  --latest    the N newest logs (default 5) when --since is not given
  --file      scan exactly these files (repeatable); no discovery
  --max       lines shown per file (default 40); the count of the rest is printed
  --kind      only these kinds: ${Kinds.map((k) => k.kind).join(', ')}
  --list      print the candidate logs with their age and stop
  --all-uat   also UAT logs that do not name this project (UAT log folders are shared per engine)

A message repeated many times is shown once with xN (numbers and addresses ignored when comparing).

Exit 0 clean, 1 findings, 2 no project / no logs / bad arguments. A whole huge log -> the log-triage agent.`);
	process.exit(code);
}

function main(argv) {
	const opt = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
	if (argv.includes('--help') || argv.includes('-h')) usage(0);
	const files = argv.flatMap((a, i) => (a === '--file' ? [argv[i + 1]] : [])).filter(Boolean);
	const max = Number(opt('--max') ?? 40);
	const kinds = opt('--kind')?.split(',').map((s) => s.trim()).filter(Boolean);
	if (!Number.isFinite(max) || max < 0) usage(2);

	let targets;
	if (files.length) {
		targets = files.map((p) => ({ path: p, mtime: existsSync(p) ? statSync(p).mtimeMs : 0 }));
	} else {
		const uproject = opt('--project') ? findUproject(opt('--project')) : findUproject();
		if (!uproject) {
			console.error('log-scan: no .uproject here or above - run from the project or pass --project <dir> / --file <path>');
			process.exit(2);
		}
		const projectName = uproject.replace(/^.*[\\/]/, '').replace(/\.uproject$/i, '');
		const all = candidateLogs(dirname(uproject), process.env, { projectName, allUat: argv.includes('--all-uat') });
		if (argv.includes('--list')) {
			const now = Date.now();
			for (const r of all) console.log(`${Math.round((now - r.mtime) / 60000).toString().padStart(6)} min  ${r.path}`);
			process.exit(all.length ? 0 : 2);
		}
		const since = opt('--since');
		targets = since !== undefined
			? all.filter((r) => Date.now() - r.mtime <= Number(since) * 60000)
			: all.slice(0, Number(opt('--latest') ?? 5));
		if (!targets.length) {
			console.log(since !== undefined ? `log-scan: no log modified in the last ${since} min (--list shows what exists)` : 'log-scan: no logs found');
			process.exit(all.length ? 0 : 2);
		}
	}

	let total = 0;
	const byKind = {};
	for (const t of targets) {
		let text;
		try {
			text = readFileSync(t.path, 'utf8');
		} catch {
			console.log(`\n${t.path}: unreadable`);
			continue;
		}
		let hits = scanText(text);
		if (kinds) hits = hits.filter((h) => kinds.includes(h.kind));
		if (!hits.length) {
			console.log(`\n${t.path}: clean`);
			continue;
		}
		const lineCount = hits.reduce((n, h) => n + h.repeats, 0);
		total += lineCount;
		for (const h of hits) byKind[h.kind] = (byKind[h.kind] ?? 0) + h.repeats;
		const counts = Object.entries(hits.reduce((m, h) => ((m[h.kind] = (m[h.kind] ?? 0) + h.repeats), m), {}))
			.map(([k, n]) => `${k} ${n}`).join(', ');
		console.log(`\n${t.path}: ${lineCount} line(s), ${hits.length} distinct (${counts})`);
		// Worst first: the order of Kinds is the severity order.
		const rank = (k) => Kinds.findIndex((x) => x.kind === k);
		const shown = [...hits].sort((a, b) => rank(a.kind) - rank(b.kind) || a.line - b.line).slice(0, max);
		for (const h of shown) {
			const text = h.text.length > 300 ? h.text.slice(0, 300) + '…' : h.text;
			console.log(`  ${h.line}: [${h.kind}]${h.repeats > 1 ? ` x${h.repeats}` : ''} ${text}`);
		}
		if (hits.length > shown.length) console.log(`  … ${hits.length - shown.length} more distinct (--max, --kind, or the log-triage agent)`);
	}
	const summary = Object.entries(byKind).map(([k, n]) => `${k} ${n}`).join(', ');
	console.log(`\nRESULT: ${total ? `${total} suspicious line(s) in ${targets.length} log(s): ${summary}` : `clean - ${targets.length} log(s)`}`);
	process.exit(total ? 1 : 0);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main(process.argv.slice(2));
