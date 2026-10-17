// statusline.mjs — a cheap Claude Code status line for an Unreal project:
//   <project> · <model> · <branch>[*] · UE:open · ctx N% · 5h N% · 7d N%
//
// CHEAP ON PURPOSE: it runs in every window on every redraw. A naive `git status` over an LFS + submodule UE
// repository is the heaviest git call there is (it wakes git-lfs), and with several windows that alone pins a
// core. So: the branch is read from .git/HEAD without starting git; the dirty marker is asked of git at most once
// a minute per repository (LFS filter switched off for that call); the editor marker at most every 30 s per
// project. Both caches are small files in ~/.claude shared by every window.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { editorsOfProject } from './ue-proc.mjs';
import { findUproject } from './ue-engine.mjs';

const Home = join(homedir(), '.claude');
const DirtyTtlMs = 60_000;
const EditorTtlMs = 30_000;

let data = {};
try { data = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { data = {}; }

const esc = '\x1b';
const reset = `${esc}[0m`, dim = `${esc}[2m`, cyan = `${esc}[2;36m`, green = `${esc}[2;32m`, magenta = `${esc}[2;35m`, yellow = `${esc}[33m`;
const parts = [];

function cached(file, key, ttl, compute) {
	const path = join(Home, file);
	let cache = {};
	try { cache = JSON.parse(readFileSync(path, 'utf8')); } catch { cache = {}; }
	const hit = cache[key];
	if (hit && Date.now() - hit.at < ttl) return hit.value;
	let value;
	try { value = compute(); } catch { value = hit?.value ?? null; }
	cache[key] = { at: Date.now(), value };
	try { writeFileSync(path, JSON.stringify(cache)); } catch { /* another window wrote it; fine */ }
	return value;
}

/** The repository's top and .git directory for `start` (a worktree's .git file followed), or null. */
function gitDirOf(start) {
	let d = resolve(start);
	for (;;) {
		const g = join(d, '.git');
		if (existsSync(g)) {
			try {
				if (statSync(g).isDirectory()) return { top: d, git: g };
				const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(g, 'utf8'));
				if (m) return { top: d, git: resolve(d, m[1].trim()) };
			} catch { return null; }
		}
		const up = dirname(d);
		if (up === d) return null;
		d = up;
	}
}

const cwd = data?.workspace?.current_dir || data?.cwd || process.cwd();
const projectDir = data?.workspace?.project_dir || process.env.CLAUDE_PROJECT_DIR || cwd;
const uproject = findUproject(projectDir);
parts.push(`${cyan}${uproject ? basename(uproject, '.uproject') : basename(cwd)}${reset}`);
if (data?.model?.display_name) parts.push(`${magenta}${data.model.display_name}${reset}`);

const repo = gitDirOf(cwd);
let branch = data?.worktree?.branch || null;
if (!branch && repo) {
	try {
		const head = readFileSync(join(repo.git, 'HEAD'), 'utf8').trim();
		branch = head.startsWith('ref: refs/heads/') ? head.slice('ref: refs/heads/'.length) : head.slice(0, 7);
	} catch { branch = null; }
}
if (branch) {
	const dirty = repo && cached('statusline-dirty-cache.json', repo.top, DirtyTtlMs, () => execFileSync('git',
		['-C', repo.top, '--no-optional-locks', '-c', 'filter.lfs.process=', '-c', 'filter.lfs.clean=cat', '-c', 'filter.lfs.required=false',
			'status', '--porcelain', '--ignore-submodules=dirty'],
		{ encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim().length > 0);
	parts.push(`${green}${branch}${dirty ? '*' : ''}${reset}`);
}

if (uproject) {
	const root = dirname(uproject);
	const open = cached('statusline-editor-cache.json', root.toLowerCase(), EditorTtlMs, () => {
		const p = editorsOfProject(root);
		return p.precise ? (p.gui.length ? 'gui' : p.headless.length ? 'headless' : '') : null;
	});
	if (open) parts.push(`${yellow}UE:${open === 'gui' ? 'open' : 'headless'}${reset}`);
}

if (data?.context_window?.used_percentage != null) parts.push(`${dim}ctx ${reset}${Math.round(data.context_window.used_percentage)}%`);

// Claude.ai rate limits: account-wide, so the last seen values are cached and replayed (marked ~) until this
// session gets its own numbers.
const rlPath = join(Home, 'rate-limits-cache.json');
const live = data?.rate_limits;
let rl = null, stale = false;
if (live?.five_hour?.used_percentage != null || live?.seven_day?.used_percentage != null) {
	rl = live;
	try { writeFileSync(rlPath, JSON.stringify(live)); } catch { /* best effort */ }
} else {
	try { rl = JSON.parse(readFileSync(rlPath, 'utf8').replace(/^﻿/, '')); } catch { rl = null; }
	stale = true;
}
const now = Math.floor(Date.now() / 1000);
for (const [label, w] of [['5h', rl?.five_hour], ['7d', rl?.seven_day]]) {
	if (w?.used_percentage == null) continue;
	const pct = stale && w.resets_at && w.resets_at <= now ? 0 : w.used_percentage;
	parts.push(`${dim}${label} ${reset}${stale ? '~' : ''}${Math.round(pct)}%`);
}

process.stdout.write(parts.join(`${dim} ·${reset} `) + '\n');
