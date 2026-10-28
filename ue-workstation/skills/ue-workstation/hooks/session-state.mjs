// SessionStart: tell the agent what state the Unreal project is in before it acts — is an editor of this project
// running and whose (ownership markers, ue-owner.mjs), which modules are older than their sources, where git stands.
// Lands in the context as a few lines. Never blocks: any probe that fails is reported as unknown.
// Silent outside an Unreal project. Off with UE_WS_SESSION_STATE=0.

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addContext, readPayload } from './hook-io.mjs';
import { describeEditor, editors, findProjectRoot, sameProject, snapshot, whoAmI } from '../scripts/mjs/ue-owner.mjs';

const Platform = process.platform === 'win32' ? 'Win64' : process.platform === 'darwin' ? 'Mac' : 'Linux';
const LibExt = process.platform === 'win32' ? '.dll' : process.platform === 'darwin' ? '.dylib' : '.so';
const SourceExt = /\.(h|hpp|cpp|inl|cs)$/i;

const list = (dir) => {
	try {
		return readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
};

function newestSource(dir) {
	let newest = 0;
	let file = null;
	for (const e of list(dir)) {
		const p = join(dir, e.name);
		if (e.isDirectory()) {
			const sub = newestSource(p);
			if (sub.time > newest) ({ time: newest, file } = sub);
		} else if (SourceExt.test(e.name)) {
			const t = statSync(p).mtimeMs;
			if (t > newest) [newest, file] = [t, p];
		}
	}
	return { time: newest, file };
}

/** A .uproject / .uplugin parsed, or null when it is missing or not valid JSON. */
function descriptor(dir, ext) {
	const f = list(dir).find((e) => e.isFile() && e.name.toLowerCase().endsWith(ext));
	if (!f) return null;
	try {
		return JSON.parse(readFileSync(join(dir, f.name), 'utf8').replace(/^﻿/, ''));
	} catch {
		return null;
	}
}

const pluginName = (dir) => (list(dir).find((e) => e.name.toLowerCase().endsWith('.uplugin'))?.name ?? '').slice(0, -'.uplugin'.length);

/** Whether a module entry of a descriptor is built into the editor on this platform. */
function builtForEditor(m) {
	if (!m?.Name || m.Type === 'Program') return false;
	const allow = m.PlatformAllowList ?? m.WhitelistPlatforms;
	const deny = m.PlatformDenyList ?? m.BlacklistPlatforms;
	if (Array.isArray(allow) && allow.length && !allow.includes(Platform)) return false;
	if (Array.isArray(deny) && deny.includes(Platform)) return false;
	return true;
}

/**
 * Modules (project and project plugins) whose newest source is newer than their editor binary. The module list comes
 * from the .uproject / .uplugin: a Source folder no descriptor declares, a Program module, a module excluded on this
 * platform and a plugin the project switched off are never built, so they are not stale. A descriptor that cannot be
 * read falls back to every folder under Source.
 */
export function staleModules(root) {
	const project = descriptor(root, '.uproject');
	const enabled = new Map((project?.Plugins ?? []).map((p) => [String(p.Name).toLowerCase(), p.Enabled !== false]));
	const owners = [{ dir: root, desc: project }];
	const walkPlugins = (dir, depth) => {
		for (const e of list(dir)) {
			if (!e.isDirectory() || depth > 3) continue;
			const p = join(dir, e.name);
			if (!list(p).some((f) => f.name.toLowerCase().endsWith('.uplugin'))) {
				walkPlugins(p, depth + 1);
				continue;
			}
			const desc = descriptor(p, '.uplugin');
			if (enabled.get(pluginName(p).toLowerCase()) ?? desc?.EnabledByDefault !== false) owners.push({ dir: p, desc });
		}
	};
	walkPlugins(join(root, 'Plugins'), 0);
	const out = [];
	for (const { dir: owner, desc } of owners) {
		const libs = list(join(owner, 'Binaries', Platform)).map((e) => e.name.toLowerCase());
		const declared = Array.isArray(desc?.Modules) ? new Set(desc.Modules.filter(builtForEditor).map((m) => m.Name.toLowerCase())) : null;
		const modules = list(join(owner, 'Source')).filter((e) => e.isDirectory() && (!declared || declared.has(e.name.toLowerCase())));
		for (const m of modules) {
			const prefix = `unrealeditor-${m.name.toLowerCase()}`;
			const built = libs
				.filter((n) => n.endsWith(LibExt) && (n === prefix + LibExt || n.startsWith(`${prefix}-`)))
				.reduce((t, n) => Math.max(t, statSync(join(owner, 'Binaries', Platform, n)).mtimeMs), 0);
			const src = newestSource(join(owner, 'Source', m.name));
			if (src.time > built) out.push({ module: m.name, built, file: src.file });
		}
	}
	return out;
}

function editorLines(root) {
	try {
		const snap = snapshot();
		const mine = editors(snap, whoAmI(snap)).filter((e) => sameProject(e.project, root));
		return mine.length ? mine.map((e) => `- editor: ${describeEditor(e)}`) : ['- editor: none of this project running'];
	} catch {
		return ['- editor: unknown (process query failed)'];
	}
}

function binariesLines(root) {
	try {
		const stale = staleModules(root);
		if (!stale.length) return ['- binaries: every module is newer than its sources'];
		return stale.slice(0, 8).map((s) => `- binaries: ${s.module} is stale (${s.built ? `built ${new Date(s.built).toISOString().slice(0, 16).replace('T', ' ')}` : 'never built'}, newer source e.g. ${s.file.slice(root.length + 1)})`);
	} catch {
		return ['- binaries: unknown'];
	}
}

function gitLines(root) {
	try {
		const out = execFileSync('git', ['status', '--porcelain=v1', '--branch'], { cwd: root, encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] });
		const rows = out.split(/\r?\n/).filter(Boolean);
		const branch = rows[0]?.startsWith('## ') ? rows[0].slice(3) : 'unknown';
		return [`- git: ${branch} (vs last fetch), ${rows.length - 1 ? `${rows.length - 1} uncommitted path(s)` : 'clean'}`];
	} catch {
		return ['- git: unknown'];
	}
}

function main() {
	if (process.env.UE_WS_SESSION_STATE === '0') return;
	const payload = readPayload() ?? {};
	const root = findProjectRoot(payload.cwd || process.cwd());
	if (!root) return;
	const lines = [`State of ${basename(root)} at session start (ue-workstation session-state):`, ...editorLines(root), ...binariesLines(root), ...gitLines(root)];
	addContext('SessionStart', lines.join('\n'));
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
