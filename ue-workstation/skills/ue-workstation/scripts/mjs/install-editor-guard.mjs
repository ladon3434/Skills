// install-editor-guard.mjs — wires hooks/editor-guard.mjs into a Claude Code settings file.
//
//   node install-editor-guard.mjs [--settings <file>] [--uninstall] [--dry-run]
//
// Default target: %USERPROFILE%\.claude\settings.json — the guard is a machine rule (one editor per machine,
// nobody stops what they did not start), so it belongs to every session on the machine, not to one project.
// Idempotent: a hook already running editor-guard.mjs is left as is. Other hooks are never touched. The file is
// backed up once per run next to itself (<file>.editor-guard-bak) before it is rewritten.

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const Script = 'editor-guard.mjs';
const HookPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'hooks', Script).replace(/\\/g, '/');
const Wiring = [
	{ event: 'PreToolUse', matcher: 'Bash|PowerShell|mcp__.*unreal.*' },
	{ event: 'PostToolUse', matcher: 'Bash|PowerShell|mcp__.*unreal.*' },
];

const runsGuard = (h) => String(h?.command ?? '').includes(Script);

/** PURE: {settings, changes: string[]} with the guard added (or removed). */
export function wire(settings, { uninstall = false, hookPath = HookPath } = {}) {
	const out = structuredClone(settings ?? {});
	const changes = [];
	out.hooks ??= {};
	for (const { event, matcher } of Wiring) {
		const groups = out.hooks[event] ?? [];
		if (uninstall) {
			const kept = [];
			for (const g of groups) {
				const hooks = (g.hooks ?? []).filter((h) => !runsGuard(h));
				if (hooks.length !== (g.hooks ?? []).length) changes.push(`${event}: removed ${Script}`);
				if (hooks.length) kept.push({ ...g, hooks });
			}
			if (kept.length) out.hooks[event] = kept;
			else delete out.hooks[event];
			continue;
		}
		const wired = groups.find((g) => (g.hooks ?? []).some(runsGuard));
		if (wired) {
			if (wired.matcher !== matcher) {
				changes.push(`${event}: matcher ${wired.matcher} -> ${matcher}`);
				wired.matcher = matcher;
			}
			continue;
		}
		out.hooks[event] = [...groups, { matcher, hooks: [{ type: 'command', command: `node "${hookPath}"`, timeout: 30 }] }];
		changes.push(`${event} [${matcher}]: added node "${hookPath}"`);
	}
	if (!Object.keys(out.hooks).length) delete out.hooks;
	return { settings: out, changes };
}

function main(argv) {
	const at = argv.indexOf('--settings');
	const target = at >= 0 ? resolve(argv[at + 1]) : join(homedir(), '.claude', 'settings.json');
	const uninstall = argv.includes('--uninstall');
	const dry = argv.includes('--dry-run');
	if (!uninstall && !existsSync(HookPath)) {
		console.log(`ERROR: ${HookPath} not found`);
		return 1;
	}
	let current = {};
	if (existsSync(target)) {
		try {
			current = JSON.parse(readFileSync(target, 'utf8').replace(/^﻿/, ''));
		} catch (e) {
			console.log(`ERROR: ${target} is not valid JSON (${e.message}) - fix it first; nothing written`);
			return 1;
		}
	}
	const { settings, changes } = wire(current, { uninstall });
	for (const c of changes) console.log(`${dry ? 'would ' : ''}${c}`);
	if (!changes.length) {
		console.log(`${target}: nothing to change`);
		return 0;
	}
	if (dry) return 0;
	mkdirSync(dirname(target), { recursive: true });
	if (existsSync(target)) copyFileSync(target, `${target}.editor-guard-bak`);
	writeFileSync(target, JSON.stringify(settings, null, 2) + '\n');
	console.log(`${target}: written${existsSync(`${target}.editor-guard-bak`) ? ` (backup ${target}.editor-guard-bak)` : ''}. Restart Claude Code sessions to pick it up.`);
	return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
	process.exit(main(process.argv.slice(2)));
}
