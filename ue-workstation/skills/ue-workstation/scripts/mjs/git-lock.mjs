// git-lock.mjs — remove a stale `.git/index.lock` only when no index-writing git is alive.
//
//   node git-lock.mjs [--repo <dir>] [--dry-run]     |   node git-lock.mjs --selftest
//
// WHY: a long pre-commit hook outlives the agent's tool timeout, the timeout kills the commit, the lock stays,
// and every later git that writes the index dies on «index.lock exists».
// THE TEST IS «IS ANY GIT THAT WRITES THE INDEX ALIVE», not the lock's age: a live commit can sit in its hooks for
// minutes, and removing the lock under it corrupts the index. Read-only gits (status, diff — an IDE runs them all
// the time) never take the lock and do not count. The process list cannot say which checkout a git works in, so a
// writing git of ANY checkout keeps the lock (a retry costs less than an index). An unreadable process list keeps
// it too (fail-closed).

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { existsSync, mkdtempSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const IndexWriters = new Set(['commit', 'add', 'rm', 'mv', 'rebase', 'merge', 'pull', 'stash', 'checkout', 'switch', 'reset',
	'restore', 'cherry-pick', 'revert', 'am', 'apply', 'update-index', 'read-tree', 'submodule', 'clean']);

/** PURE: the subcommand of a git command line (first word after -C <dir>, -c <k=v>, --options). */
export function gitVerb(cmdline) {
	const words = String(cmdline).match(/"[^"]*"|\S+/g) ?? [];
	let i = words.findIndex((w) => /(^|[\\/])git(\.exe)?"?$/i.test(w));
	if (i < 0) return null;
	for (i++; i < words.length; i++) {
		const w = words[i];
		if (['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(w)) { i++; continue; }
		if (w.startsWith('-')) continue;
		return w.replace(/"/g, '');
	}
	return null;
}

/** Every running git with its command line, or null when the list cannot be read. */
export function gitProcesses() {
	const r = process.platform === 'win32'
		? spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
			"Get-CimInstance Win32_Process -Filter \"Name='git.exe'\" | ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }"],
		{ encoding: 'utf8', timeout: 20000, windowsHide: true })
		: spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8', timeout: 10000 });
	if (r.status !== 0 || r.error) return null;
	const out = [];
	for (const line of (r.stdout || '').split(/\r?\n/)) {
		const m = process.platform === 'win32' ? line.match(/^(\d+)\t(.*)$/) : line.match(/^\s*(\d+)\s+(.*)$/);
		if (!m) continue;
		if (process.platform !== 'win32' && gitVerb(m[2]) === null) continue;
		out.push({ pid: Number(m[1]), cmdline: m[2] });
	}
	return out;
}

/** PURE: remove only when the list was read and no git in it writes the index. */
export function lockVerdict(procs) {
	if (procs === null) return { remove: false, writers: [] };
	const writers = procs.filter((p) => { const v = gitVerb(p.cmdline); return v !== null && IndexWriters.has(v); });
	return { remove: writers.length === 0, writers };
}

/** Sweep `repo`'s index.lock. Returns a line to print, or null when there is no lock. */
export function sweepStaleIndexLock(repo, procs = gitProcesses, dryRun = false) {
	const r = spawnSync('git', ['-C', repo, 'rev-parse', '--git-path', 'index.lock'], { encoding: 'utf8', windowsHide: true });
	if (r.status !== 0) return null;
	const rel = r.stdout.trim();
	const lock = isAbsolute(rel) ? rel : join(repo, rel);
	if (!existsSync(lock)) return null;
	let age;
	try { age = `${Math.round((Date.now() - statSync(lock).mtimeMs) / 1000)}s`; } catch { return null; }
	const v = lockVerdict(procs());
	if (!v.remove) {
		return v.writers.length
			? `index.lock in ${repo} (${age} old) left alone: a git is still writing (${v.writers.map((w) => `pid ${w.pid}: ${gitVerb(w.cmdline)}`).join(', ')})`
			: `index.lock in ${repo} (${age} old) left alone: the running gits could not be listed`;
	}
	if (dryRun) return `would remove a stale index.lock in ${repo} (${age} old, no git is writing)`;
	try { unlinkSync(lock); } catch (e) { return `index.lock in ${repo} could not be removed: ${e.message}`; }
	return `removed a stale index.lock in ${repo} (${age} old, no git was writing)`;
}

function selftest() {
	const fails = [];
	let n = 0;
	const eq = (a, b, m) => { n++; if (JSON.stringify(a) !== JSON.stringify(b)) fails.push(`${m}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); };
	eq(gitVerb('"C:\\Program Files\\Git\\cmd\\git.exe" commit -q -m x'), 'commit', 'the verb after a quoted exe');
	eq(gitVerb('C:\\Git\\mingw64\\bin\\git.exe -C D:/p -c core.x=1 --no-pager add -- a'), 'add', 'options before the verb are skipped');
	eq(gitVerb('git.exe diff --stat'), 'diff', 'a read-only verb');
	eq(gitVerb('node something.js'), null, 'not a git');
	eq(lockVerdict([{ pid: 1, cmdline: 'git.exe status --porcelain' }, { pid: 2, cmdline: 'git.exe diff' }]).remove, true, 'only read-only gits: stale');
	eq(lockVerdict([{ pid: 1, cmdline: 'git.exe status' }, { pid: 7, cmdline: 'git.exe commit -m x' }]).writers.map((w) => w.pid), [7], 'a live commit keeps the lock');
	eq(lockVerdict(null).remove, false, 'an unreadable process list keeps the lock');
	eq(lockVerdict([]).remove, true, 'no git at all: stale');
	const d = mkdtempSync(join(tmpdir(), 'git-lock-'));
	try {
		spawnSync('git', ['init', '-q', d]);
		eq(sweepStaleIndexLock(d, () => []), null, 'no lock: nothing to say');
		writeFileSync(join(d, '.git', 'index.lock'), '');
		eq(/left alone: a git is still writing \(pid 9: commit\)/.test(sweepStaleIndexLock(d, () => [{ pid: 9, cmdline: 'git commit' }]) ?? ''), true, 'a live commit keeps it');
		eq(/would remove/.test(sweepStaleIndexLock(d, () => [], true) ?? ''), true, 'dry run only says');
		eq(existsSync(join(d, '.git', 'index.lock')), true, 'and the lock is still there');
		eq(/removed a stale index\.lock/.test(sweepStaleIndexLock(d, () => [{ pid: 3, cmdline: 'git status' }]) ?? ''), true, 'no writer: removed');
		eq(existsSync(join(d, '.git', 'index.lock')), false, 'and gone');
	} finally { rmSync(d, { recursive: true, force: true }); }
	if (fails.length) { console.log(`git-lock self-test FAILED:\n  ${fails.join('\n  ')}`); process.exit(1); }
	console.log(`git-lock self-test: ok (${n} checks)`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
	const argv = process.argv.slice(2);
	if (argv.includes('--selftest')) selftest();
	else if (argv.includes('--help')) console.log('usage: git-lock [--repo <dir>] [--dry-run] | --selftest');
	else {
		const i = argv.indexOf('--repo');
		const repo = i >= 0 ? argv[i + 1] : process.cwd();
		console.log(sweepStaleIndexLock(repo, gitProcesses, argv.includes('--dry-run')) ?? `no index.lock in ${repo}`);
	}
}
