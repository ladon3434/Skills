// repo-check — the marketplace's own consistency check. Run before every commit; it lives outside the plugins
// and is never installed.
//
//   node scripts/repo-check.mjs [<another marketplace dir> ...]
//
//   [CPY] a shared module that differs from its master. Plugins install on their own, so a module several of them
//         need is COPIED into each; the copies must stay one file. Master: ue-workstation/skills/ue-workstation/
//         scripts/mjs/<module>. Change the master, then copy it over every copy.
//   [VER] a plugin.json WITH a `version` (it freezes updates; the commit SHA is the version)
//   [DEP] a plugin.json dependency that is no plugin of the checked marketplaces
//   [DSC] a SKILL.md description over 1024 characters (the loader cuts it; the tail - often the triggers - is lost)
//   [MKT] a marketplace entry whose folder or plugin.json is missing
//
// Another marketplace dir (the private one) is checked the same way, its copies against THIS repo's masters,
// and its plugins count as known dependencies both ways. Exit 0 clean, 1 problems.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const Here = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MasterDir = join(Here, 'ue-workstation', 'skills', 'ue-workstation', 'scripts', 'mjs');
const SharedModules = ['ue-engine.mjs', 'ue-proc.mjs', 'ue-owner.mjs'];
const DescriptionLimit = 1024;
const SkipDirs = new Set(['.git', 'node_modules', '__pycache__']);

const problems = [];
const say = (tag, where, what) => problems.push(`[${tag}] ${relative(Here, where) || '.'}: ${what}`);
// Line endings are git's business (.gitattributes), not a difference.
const text = (p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

function* walk(dir) {
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		if (SkipDirs.has(e.name)) continue;
		const p = join(dir, e.name);
		if (e.isDirectory()) yield* walk(p);
		else yield p;
	}
}

/** The marketplace's plugins: [{name, dir, manifest}] (manifest null when unreadable). */
function plugins(root) {
	const mkt = join(root, '.claude-plugin', 'marketplace.json');
	let entries = [];
	try {
		entries = JSON.parse(readFileSync(mkt, 'utf8')).plugins ?? [];
	} catch (e) {
		say('MKT', mkt, `unreadable (${e.message})`);
	}
	return entries.map((e) => {
		const dir = resolve(root, e.source ?? '');
		const pj = join(dir, '.claude-plugin', 'plugin.json');
		let manifest = null;
		if (!existsSync(pj)) say('MKT', mkt, `${e.name}: no ${relative(Here, pj)}`);
		else {
			try {
				manifest = JSON.parse(readFileSync(pj, 'utf8'));
			} catch (err) {
				say('MKT', pj, `unreadable (${err.message})`);
			}
		}
		return { name: e.name, dir, manifest, pj };
	});
}

/** The `description:` value of a SKILL.md front matter: one line, or a folded `>` / literal `|` block. */
function description(skillMd) {
	const m = text(skillMd).match(/^---\n([\s\S]*?)\n---/);
	const lines = m?.[1].split('\n') ?? [];
	const i = lines.findIndex((l) => l.startsWith('description:'));
	if (i < 0) return null;
	const head = lines[i].slice('description:'.length).trim();
	if (!/^[>|][-+]?$/.test(head)) return head;
	const body = [];
	for (const l of lines.slice(i + 1)) {
		if (l.trim() && !/^\s/.test(l)) break;
		body.push(l.trim());
	}
	return body.join(head.startsWith('>') ? ' ' : '\n').trim();
}

const roots = [Here, ...process.argv.slice(2).map((a) => resolve(a))];
const all = roots.map((r) => ({ root: r, plugins: plugins(r) }));
const known = new Set(all.flatMap((m) => m.plugins.map((p) => p.name)));
const masters = Object.fromEntries(SharedModules.map((m) => [m, text(join(MasterDir, m))]));

for (const { root, plugins: list } of all) {
	for (const p of list) {
		if (p.manifest) {
			// No `version` on purpose: it pins the plugin, and `claude plugin update` skips every commit until it changes.
			// Without it the version is the commit SHA.
			if (p.manifest.version) say('VER', p.pj, `"version" pins the plugin - updates stop until it is bumped; remove it`);
			for (const d of p.manifest.dependencies ?? []) {
				const name = typeof d === 'string' ? d : d?.name;
				if (!known.has(name)) say('DEP', p.pj, `depends on "${name}", which no checked marketplace has`);
			}
		}
	}
	for (const f of walk(root)) {
		const base = f.slice(f.lastIndexOf(f.includes('\\') ? '\\' : '/') + 1);
		if (SharedModules.includes(base) && dirname(f) !== MasterDir && text(f) !== masters[base]) {
			say('CPY', f, `differs from the master ue-workstation/.../${base} - copy the master over it`);
		}
		if (base === 'SKILL.md') {
			const d = description(f);
			if (d && d.length > DescriptionLimit) say('DSC', f, `description is ${d.length} characters (limit ${DescriptionLimit})`);
		}
	}
}

for (const p of problems) console.log(p);
console.log(problems.length ? `repo-check: ${problems.length} problem(s)` : `repo-check: ok (${known.size} plugins in ${roots.length} marketplace(s))`);
process.exitCode = problems.length ? 1 : 0;
