// merge-settings.mjs — merge the kit's templates/settings.json INTO an existing .claude/settings.json without
// clobbering anything. Never writes the existing file.
//
//   node merge-settings.mjs <existing settings.json> [--out <new file>]
//
// Prints a summary of what would be added to stderr and the merged JSON to stdout (or to --out, which must not
// exist). Review it, then replace the file yourself.
// Rules: existing scalar values win (defaultMode, statusLine, ...); permission lists and enabledMcpjsonServers
// are unions; a hook is added only when no existing hook of that event already runs the same command file.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TemplatePath = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), 'templates', 'settings.json');

/** PURE: {merged, added: string[]} */
export function mergeSettings(existing, template) {
	const merged = structuredClone(existing);
	const added = [];
	for (const [key, value] of Object.entries(template)) {
		if (key === 'permissions' || key === 'hooks' || key === 'enabledMcpjsonServers') continue;
		if (!(key in merged)) { merged[key] = value; added.push(key); }
	}
	const tp = template.permissions ?? {};
	merged.permissions ??= {};
	if (tp.defaultMode && !merged.permissions.defaultMode) { merged.permissions.defaultMode = tp.defaultMode; added.push('permissions.defaultMode'); }
	for (const list of ['allow', 'deny', 'ask']) {
		const have = new Set(merged.permissions[list] ?? []);
		const extra = (tp[list] ?? []).filter((r) => !have.has(r));
		if (extra.length) { merged.permissions[list] = [...(merged.permissions[list] ?? []), ...extra]; added.push(`permissions.${list}: +${extra.length}`); }
	}
	if (template.enabledMcpjsonServers) {
		const have = new Set(merged.enabledMcpjsonServers ?? []);
		const extra = template.enabledMcpjsonServers.filter((s) => !have.has(s));
		if (extra.length) { merged.enabledMcpjsonServers = [...(merged.enabledMcpjsonServers ?? []), ...extra]; added.push(`enabledMcpjsonServers: +${extra.join(', ')}`); }
	}
	const scriptOf = (cmd) => (String(cmd).match(/[\w.-]+\.(?:mjs|js|sh|cmd|py)\b/) ?? [String(cmd)])[0];
	if (template.hooks) merged.hooks ??= {};
	for (const [event, groups] of Object.entries(template.hooks ?? {})) {
		const present = new Set((merged.hooks[event] ?? []).flatMap((g) => (g.hooks ?? []).map((h) => scriptOf(h.command))));
		for (const group of groups) {
			const fresh = (group.hooks ?? []).filter((h) => !present.has(scriptOf(h.command)));
			if (!fresh.length) continue;
			merged.hooks[event] = [...(merged.hooks[event] ?? []), { ...group, hooks: fresh }];
			added.push(`hooks.${event}: ${fresh.map((h) => scriptOf(h.command)).join(', ')}`);
		}
	}
	return { merged, added };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
	const argv = process.argv.slice(2);
	const outAt = argv.indexOf('--out');
	const target = argv.find((a, i) => !a.startsWith('--') && (outAt < 0 || i !== outAt + 1));
	if (!target || argv.includes('--help')) {
		console.error('usage: merge-settings <existing settings.json> [--out <new file>]');
		process.exit(2);
	}
	const read = (p) => JSON.parse(readFileSync(p, 'utf8').replace(/^﻿/, ''));
	const { merged, added } = mergeSettings(read(target), read(TemplatePath));
	console.error(added.length ? `would add:\n  ${added.join('\n  ')}` : 'nothing to add: the settings already carry the kit');
	const text = JSON.stringify(merged, null, 2) + '\n';
	if (outAt >= 0) {
		const out = argv[outAt + 1];
		if (!out || existsSync(out)) { console.error(`refused: --out ${out ?? '(missing)'} exists or is missing - this script never overwrites`); process.exit(1); }
		writeFileSync(out, text);
		console.error(`merged copy written to ${out}`);
	} else {
		process.stdout.write(text);
	}
}
