// safe-pull.mjs — an editor-aware pull for an Unreal project.
//
//   node safe-pull.mjs [--repo <dir>] [--rebase] [--dry-run] [--no-fetch]   |   --selftest
//
// A plain `git pull` while the project's editor is open dies halfway on files the editor holds (.uasset/.umap,
// module DLLs) and leaves the tree between two states — the no-tree-git-editor-open hook refuses it outright.
// This script fetches first and decides by WHAT origin changed:
//   - editor open and origin changed a package/DLL -> refused, the files are named: close the editor, run again
//   - editor open and origin changed only source/config -> pulled, with a warning (the editor keeps its loaded state;
//     rebuild/restart when C++ changed)
//   - an uncommitted local edit on a file origin changed -> refused (commit it first; never stashed behind your back)
// Default integration is fast-forward only; --rebase replays local commits on top (never autostash, never a merge
// commit). Exit: 0 pulled / up to date, 1 refused or failed, 2 usage.

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, editorsOfProject } from './ue-proc.mjs';

const EditorHeld = /\.(uasset|umap|dll|pdb|exe)$/i;

function makeGit(env) {
	const clean = { ...env };
	for (const k of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_PREFIX']) delete clean[k];
	return (cwd, ...args) => {
		const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, env: clean });
		return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
	};
}
const lines = (s) => s.split(/\r?\n/).filter(Boolean);

/** @returns {{code: number, log: string[]}} */
export function safePull(repo, opts = {}, env = process.env) {
	const git = makeGit(env);
	const log = [];
	const top = git(repo, 'rev-parse', '--show-toplevel');
	if (!top.ok) return { code: 2, log: [`ERROR: ${repo} is not a git repository`] };
	const root = top.out;
	const sup = git(root, 'rev-parse', '--show-superproject-working-tree');
	const projectRoot = sup.out || root;
	if (!opts.noFetch) {
		const f = git(root, 'fetch', '--quiet');
		if (!f.ok) return { code: 1, log: [`ERROR: git fetch failed: ${f.err}`] };
	}
	const up = git(root, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}');
	if (!up.ok) return { code: 2, log: ['ERROR: the current branch has no upstream'] };
	const [behind] = git(root, 'rev-list', '--count', 'HEAD..@{u}').out.split(/\s+/).map(Number);
	if (!behind) return { code: 0, log: [`up to date with ${up.out}`] };
	const incoming = lines(git(root, 'diff', '--name-only', 'HEAD...@{u}').out);
	const dirty = new Set(lines(git(root, 'status', '--porcelain', '--untracked-files=no').out).map((l) => l.slice(3).replace(/^"|"$/g, '')));
	const clash = incoming.filter((f) => dirty.has(f));
	if (clash.length) {
		return { code: 1, log: [`REFUSED: uncommitted local edits on files ${up.out} changed - commit them first (nothing is stashed for you):`, ...clash.map((f) => `  ${f}`)] };
	}
	const probe = editorsOfProject(projectRoot, env);
	const editor = probe.precise ? describe(probe) : '';
	if (!probe.precise) log.push('note: the process query failed - cannot tell whether an editor is open; pulling as if none were');
	if (editor) {
		const held = incoming.filter((f) => EditorHeld.test(f));
		if (held.length) {
			return { code: 1, log: [`REFUSED: an editor of this project is open (${editor}) and ${up.out} changed ${held.length} file(s) it may hold:`,
				...held.slice(0, 20).map((f) => `  ${f}`), ...(held.length > 20 ? [`  ... and ${held.length - 20} more`] : []),
				'Close the editor (a GUI editor belongs to a person: ask them), then run safe-pull again.'] };
		}
		log.push(`warning: an editor of this project is open (${editor}); origin changed no package, pulling ${incoming.length} file(s). Restart/rebuild the editor if C++ or config changed.`);
	}
	if (opts.dryRun) {
		log.push(`dry run: would ${opts.rebase ? 'rebase onto' : 'fast-forward to'} ${up.out} (${behind} commit(s), ${incoming.length} file(s))`);
		return { code: 0, log };
	}
	const r = opts.rebase ? git(root, 'rebase', '@{u}') : git(root, 'merge', '--ff-only', '@{u}');
	if (!r.ok) {
		if (opts.rebase) git(root, 'rebase', '--abort');
		return { code: 1, log: [...log, `FAILED: ${opts.rebase ? 'rebase' : 'fast-forward'} onto ${up.out}: ${r.err}`,
			...(opts.rebase ? ['(rebase aborted, the branch is where it was)'] : ['(local commits diverge: run again with --rebase)'])] };
	}
	log.push(`pulled ${behind} commit(s) from ${up.out} (${incoming.length} file(s))`);
	return { code: 0, log };
}

function selftest() {
	const fails = [];
	let n = 0;
	const eq = (a, b, m) => { n++; if (JSON.stringify(a) !== JSON.stringify(b)) fails.push(`${m}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); };
	const git = makeGit(process.env);
	const d = mkdtempSync(join(tmpdir(), 'safe-pull-'));
	const id = ['-c', 'user.name=t', '-c', 'user.email=t@t'];
	try {
		const origin = join(d, 'origin.git'), mine = join(d, 'Game'), theirs = join(d, 'theirs');
		git(d, 'init', '-q', '--bare', origin);
		git(d, 'clone', '-q', origin, theirs);
		writeFileSync(join(theirs, 'A.cpp'), 'a\n');
		git(theirs, 'add', 'A.cpp'); git(theirs, ...id, 'commit', '-q', '-m', 'a'); git(theirs, 'push', '-q', 'origin', 'HEAD');
		git(d, 'clone', '-q', origin, mine);
		const fx = join(d, 'procs.json');
		const editorOpen = { ...process.env, UE_WS_PROC_FIXTURE: fx };
		writeFileSync(fx, JSON.stringify([{ image: process.platform === 'win32' ? 'UnrealEditor.exe' : 'UnrealEditor', pid: 77, cmd: `UnrealEditor "${join(mine, 'Game.uproject')}"` }]));
		const none = join(d, 'none.json');
		writeFileSync(none, '[]');
		const noEditor = { ...process.env, UE_WS_PROC_FIXTURE: none };

		eq(safePull(mine, {}, noEditor).code, 0, 'up to date');
		// origin changes source only -> pulled even with the editor open, with a warning
		writeFileSync(join(theirs, 'A.cpp'), 'a2\n');
		git(theirs, ...id, 'commit', '-q', '-am', 'a2'); git(theirs, 'push', '-q');
		const r1 = safePull(mine, {}, editorOpen);
		eq(r1.code, 0, 'source-only change pulled with the editor open');
		eq(r1.log.some((l) => /warning: an editor of this project is open/.test(l)), true, 'with a warning naming the editor');
		// origin changes a package -> refused while the editor is open
		writeFileSync(join(theirs, 'Hero.uasset'), 'bin');
		git(theirs, 'add', 'Hero.uasset'); git(theirs, ...id, 'commit', '-q', '-m', 'pkg'); git(theirs, 'push', '-q');
		const r2 = safePull(mine, {}, editorOpen);
		eq(r2.code, 1, 'a package change is refused with the editor open');
		eq(r2.log.some((l) => /Hero\.uasset/.test(l)), true, 'and the package is named');
		eq(safePull(mine, { dryRun: true, noFetch: true }, noEditor).code, 0, 'dry run with no editor passes');
		eq(git(mine, 'rev-list', '--count', 'HEAD..@{u}').out, '1', 'dry run moved nothing');
		// a local uncommitted edit on a file origin changes -> refused
		writeFileSync(join(theirs, 'A.cpp'), 'a3\n');
		git(theirs, ...id, 'commit', '-q', '-am', 'a3'); git(theirs, 'push', '-q');
		writeFileSync(join(mine, 'A.cpp'), 'mine\n');
		eq(safePull(mine, {}, noEditor).code, 1, 'an uncommitted edit on an incoming file is refused');
		git(mine, 'checkout', '--', 'A.cpp');
		const r3 = safePull(mine, {}, noEditor);
		eq(r3.code, 0, 'no editor: everything is pulled');
		eq(git(mine, 'rev-list', '--count', 'HEAD..@{u}').out, '0', 'and the branch is at origin');
	} finally { rmSync(d, { recursive: true, force: true }); }
	if (fails.length) { console.log(`safe-pull self-test FAILED:\n  ${fails.join('\n  ')}`); process.exit(1); }
	console.log(`safe-pull self-test: ok (${n} checks)`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
	const argv = process.argv.slice(2);
	if (argv.includes('--selftest')) selftest();
	else if (argv.includes('--help') || argv.includes('-h')) console.log('usage: safe-pull [--repo <dir>] [--rebase] [--dry-run] [--no-fetch] | --selftest');
	else {
		const i = argv.indexOf('--repo');
		const r = safePull(i >= 0 ? argv[i + 1] : process.cwd(), { rebase: argv.includes('--rebase'), dryRun: argv.includes('--dry-run'), noFetch: argv.includes('--no-fetch') });
		for (const l of r.log) console.log(l);
		process.exit(r.code);
	}
}
