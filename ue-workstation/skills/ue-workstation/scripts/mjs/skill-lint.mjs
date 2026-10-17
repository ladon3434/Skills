// skill-lint — every reference in a project's agent instructions (its skills and its AGENTS.md / CLAUDE.md) must
// point at something that still exists. A skill that cites a deleted script or a removed tool does not fail — it
// quietly gives wrong advice. This catches that.
//
//   [PTH] a repo path (under one of `pathRoots`) that does not exist
//   [SCR] a script name (*.cmd, *.py, *.ps1, *.bat, *.sh, *.mjs) found nowhere in the repo, user skills or plugins
//   [SKL] a skill name that is not a skill of the project, the user profile or an installed plugin
//   [MCP] an MCP tool of a server that is not configured
//   [RET] a retired tool or hook that must not be recommended any more
//   [FRM] SKILL.md front matter without name/description, or name != folder
//   [LST] the skill list in the instructions file out of sync with the skills folder
//
// The project's settings: <project>/.claude/skill-lint.json (no file = the project does not use the linter):
//   { "skillsDir": ".agents/skills", "instructions": ".agents/AGENTS.md",
//     "listSection": "Skills Usage",            // H2 section listing `- **name**:` per skill; omit to skip [LST]
//     "countPattern": "все (\\d+) скилл",        // a stated skill count inside that section; optional
//     "pathRoots": [".agents", ".claude", "Source", "Docs", "Config"],
//     "skillNamePattern": "ue-[a-z0-9-]+",       // backticked words of this shape are taken as skill names
//     "notSkills": ["ue-build"], "optionalPaths": ["Docs/audio"],
//     "retired": { "ue_execute_python": "Rider MCP was removed; use mcp__unreal-mcp__execute_python_code" } }
//
// Usage: skill-lint.cmd [--project <dir>]   Exit 0 clean, 1 problems, 2 no config.

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ConfigRel = join('.claude', 'skill-lint.json');
const SkipDirs = new Set(['.git', 'Binaries', 'Intermediate', 'DerivedDataCache', 'Saved', 'Content', '.vs', '.idea', '__pycache__', 'node_modules', '_Product']);
const EngineScripts = new Set(['Build.bat', 'RunUAT.bat', 'Clean.bat', 'GenerateProjectFiles.bat', 'RunUBT.bat', 'Rebuild.bat']);
const ScriptRe = /(?<![\w/\\.-])([\w.-]+\.(?:cmd|py|ps1|bat|sh|mjs))\b/g;
const BacktickRe = /`([^`\n]+)`/g;
const SkillContextRe = /(?:скилл\p{L}*|skills?)\s+`([a-z0-9][a-z0-9:-]*)`/giu;
const McpRe = /\bmcp__([A-Za-z0-9_-]+?)__[A-Za-z0-9_]+/g;

/** The nearest folder at or above `start` holding .claude/skill-lint.json, or null. */
export function findLintRoot(start) {
	let dir = resolve(start);
	for (;;) {
		if (existsSync(join(dir, ConfigRel))) return dir;
		const up = dirname(dir);
		if (up === dir) return null;
		dir = up;
	}
}

export function loadConfig(root) {
	const c = JSON.parse(readFileSync(join(root, ConfigRel), 'utf8'));
	return {
		skillsDir: c.skillsDir ?? '.claude/skills',
		instructions: c.instructions ?? 'CLAUDE.md',
		listSection: c.listSection ?? null,
		countPattern: c.countPattern ? new RegExp(c.countPattern, 'u') : null,
		pathRoots: c.pathRoots ?? ['.claude', 'Source', 'Docs', 'Config'],
		skillNamePattern: c.skillNamePattern ? new RegExp(`^(?:${c.skillNamePattern})$`) : null,
		notSkills: new Set(c.notSkills ?? []),
		optionalPaths: c.optionalPaths ?? [],
		retired: c.retired ?? {},
	};
}

const dirsOf = (d) => {
	try {
		return readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
	} catch {
		return [];
	}
};

function* walkFiles(dir, skip = SkipDirs) {
	let entries = [];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const e of entries) {
		if (e.isDirectory()) {
			if (!skip.has(e.name)) yield* walkFiles(join(dir, e.name), skip);
		} else yield e.name;
	}
}

/** Folders of the installed Claude Code plugins; a plugin of a marketplace added from a local folder is read there. */
export function pluginRoots(home = homedir()) {
	const read = (f) => {
		try {
			return JSON.parse(readFileSync(join(home, '.claude', 'plugins', f), 'utf8'));
		} catch {
			return {};
		}
	};
	const markets = read('known_marketplaces.json');
	const roots = new Set();
	for (const [key, entries] of Object.entries(read('installed_plugins.json').plugins ?? {})) {
		const [plugin, market] = key.split('@');
		const local = join(markets[market]?.installLocation ?? '', plugin);
		for (const e of entries) {
			const p = existsSync(join(local, 'skills')) ? local : e.installPath;
			if (p && existsSync(p)) roots.add(p);
		}
	}
	return [...roots];
}

function context(root, cfg) {
	const userSkills = join(homedir(), '.claude', 'skills');
	const plugins = pluginRoots();
	const files = new Set([...walkFiles(root), ...walkFiles(userSkills), ...plugins.flatMap((p) => [...walkFiles(p)])]);
	const local = new Set(dirsOf(join(root, cfg.skillsDir)));
	const all = new Set([...local, ...dirsOf(userSkills), ...plugins.flatMap((p) => dirsOf(join(p, 'skills')))]);
	const mcp = new Set();
	for (const f of [join(root, '.mcp.json'), join(homedir(), '.claude.json')]) {
		try {
			const j = JSON.parse(readFileSync(f, 'utf8'));
			Object.keys(j.mcpServers ?? {}).forEach((s) => mcp.add(s));
			const here = Object.entries(j.projects ?? {}).find(([p]) => resolve(p).toLowerCase() === resolve(root).toLowerCase());
			Object.keys(here?.[1]?.mcpServers ?? {}).forEach((s) => mcp.add(s));
		} catch {
			/* absent */
		}
	}
	return { files, local, all, mcp };
}

/** Lints one instructions file; returns problems as strings. Exported for the edit hook and the tests. */
export function lintFile(root, cfg, ctx, path) {
	const out = [];
	const rel = relative(root, path).replace(/\\/g, '/');
	const pathRe = new RegExp(`(?<![\\w/\\\\.-])((?:${cfg.pathRoots.map((r) => r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})[/\\\\][^\\s\`'"()\\[\\],;*|]*)`, 'g');
	const exists = (ref) => {
		ref = ref.replace(/[.:]+$/, '');
		if (/[<{]|\.\.\./.test(ref)) return true;
		const c = ref.replace(/\\/g, '/').replace(/\/+$/, '');
		if (cfg.optionalPaths.some((o) => c.startsWith(o))) return true;
		return existsSync(join(root, c)) || existsSync(join(dirname(path), c));
	};
	readFileSync(path, 'utf8').split(/\r?\n/).forEach((line, i) => {
		const where = `${rel}:${i + 1}`;
		for (const [token, why] of Object.entries(cfg.retired)) if (line.includes(token)) out.push(`[RET] ${where}: ${token} - ${why}`);
		for (const m of line.matchAll(pathRe)) if (!exists(m[1])) out.push(`[PTH] ${where}: path does not exist: ${m[1]}`);
		for (const m of line.matchAll(ScriptRe)) {
			if (!EngineScripts.has(m[1]) && !ctx.files.has(m[1])) out.push(`[SCR] ${where}: script found nowhere in the repo, user skills or plugins: ${m[1]}`);
		}
		const named = new Set([...line.matchAll(SkillContextRe)].map((m) => m[1]));
		if (cfg.skillNamePattern) for (const m of line.matchAll(BacktickRe)) if (cfg.skillNamePattern.test(m[1])) named.add(m[1]);
		for (const s of named) if (!cfg.notSkills.has(s) && !s.includes(':') && !ctx.all.has(s)) out.push(`[SKL] ${where}: unknown skill: ${s}`);
		for (const m of line.matchAll(McpRe)) if (!ctx.mcp.has(m[1]) && !m[1].startsWith('claude_ai_')) out.push(`[MCP] ${where}: MCP server is not configured: ${m[1]}`);
	});
	return out;
}

function lintFrontMatter(root, cfg, skill) {
	const path = join(root, cfg.skillsDir, skill, 'SKILL.md');
	const rel = relative(root, path).replace(/\\/g, '/');
	if (!existsSync(path)) return { ok: false, problems: [`[FRM] ${rel}: skill folder has no SKILL.md`] };
	const m = readFileSync(path, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!m) return { ok: true, problems: [`[FRM] ${rel}: no front matter`] };
	const fields = Object.fromEntries([...m[1].matchAll(/^(\w+):\s*(.*)$/gm)].map((x) => [x[1], x[2].trim()]));
	const problems = [];
	if (fields.name !== skill) problems.push(`[FRM] ${rel}: name "${fields.name ?? ''}" does not match folder "${skill}"`);
	if (!fields.description) problems.push(`[FRM] ${rel}: empty description`);
	return { ok: true, problems };
}

function lintList(root, cfg, local) {
	if (!cfg.listSection) return [];
	const rel = cfg.instructions;
	const text = readFileSync(join(root, cfg.instructions), 'utf8').replace(/\r\n/g, '\n');
	const start = text.search(new RegExp(`^## ${cfg.listSection.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm'));
	if (start < 0) return [`[LST] ${rel}: no "## ${cfg.listSection}" section`];
	const rest = text.slice(start).split('\n').slice(1).join('\n');
	const body = rest.slice(0, rest.search(/^## /m) >= 0 ? rest.search(/^## /m) : undefined);
	const listed = new Set([...body.matchAll(/^- \*\*([a-z0-9-]+)\*\*/gm)].map((m) => m[1]));
	const out = [];
	for (const s of [...local].sort()) if (!listed.has(s)) out.push(`[LST] ${rel}: skill missing from ${cfg.listSection}: ${s}`);
	for (const s of [...listed].sort()) if (!local.has(s)) out.push(`[LST] ${rel}: listed skill has no folder: ${s}`);
	const count = cfg.countPattern && body.match(cfg.countPattern);
	if (count && Number(count[1]) !== local.size) out.push(`[LST] ${rel}: says ${count[1]} skills, ${cfg.skillsDir} has ${local.size}`);
	return out;
}

/** The whole project: every skill's front matter and SKILL.md, the instructions file, the list. */
export function lintProject(root) {
	const cfg = loadConfig(root);
	const ctx = context(root, cfg);
	const problems = [];
	for (const skill of [...ctx.local].sort()) {
		const fm = lintFrontMatter(root, cfg, skill);
		problems.push(...fm.problems);
		if (fm.ok) problems.push(...lintFile(root, cfg, ctx, join(root, cfg.skillsDir, skill, 'SKILL.md')));
	}
	if (existsSync(join(root, cfg.instructions))) problems.push(...lintFile(root, cfg, ctx, join(root, cfg.instructions)));
	problems.push(...lintList(root, cfg, ctx.local));
	return { problems, skills: ctx.local.size, cfg };
}

/** Is `path` one of the files the linter covers (a skill's .md or the instructions file)? */
export function covers(root, cfg, path) {
	const rel = relative(root, resolve(path)).replace(/\\/g, '/');
	return rel === cfg.instructions.replace(/\\/g, '/') || (rel.startsWith(`${cfg.skillsDir.replace(/\\/g, '/')}/`) && rel.endsWith('.md'));
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
	const i = process.argv.indexOf('--project');
	const root = findLintRoot(i > 0 ? process.argv[i + 1] : process.env.CLAUDE_PROJECT_DIR || process.cwd());
	if (!root) {
		console.log(`skill-lint: no ${ConfigRel} here or above - this project does not use the linter.`);
		process.exit(2);
	}
	const { problems, skills } = lintProject(root);
	for (const p of problems) console.log(p);
	console.log(`\nSkills: ${skills}`);
	console.log(problems.length ? `[FAILED] ${problems.length} problem(s).` : '[SUCCESS] Every reference in the skills and the instructions resolves.');
	process.exit(problems.length ? 1 : 0);
}
