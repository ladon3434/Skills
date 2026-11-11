// PreToolUse (Bash|PowerShell): no git command that rewrites the working tree of a project whose Unreal Editor
// (GUI or headless) is open.
//
// Such a command writes files into the working folder; files the editor holds (.uasset, .umap, module DLLs) stop
// it halfway («unable to unlink ...», «Could not reset index file»), and the repository is left half one state,
// half the other. Refused before the command starts: pull, merge, rebase, cherry-pick, revert, am, checkout,
// switch, restore (unless --staged only), clean, reset --hard/--merge/--keep, stash (push/pop/apply/bare),
// submodule update, apply (unless --cached/--check/--stat), read-tree -u, lfs pull/checkout, `gh pr checkout`.
// Reading (status, log, diff, fetch, show), a plain `reset`, `stash list/show/drop` and a new
// branch at HEAD (`checkout -b x`, `switch -c x` with no start point) pass.
// A submodule counts as its superproject: the editor holds its content too.
//
// The call is found wherever it stands in a simple command (`timeout 600 git pull`, `$out = git pull`,
// `if (...) { git pull }`) and inside the quoted command of a shell wrapper (`cmd /c "git pull"`, `bash -c`,
// `powershell -Command`). A `cd` earlier in the line sets the folder of the calls after it.
//
// Fails open when the payload cannot be read, the folder is no git repository or the process query fails.
// Blocks with exit 2 + a stderr reason naming the way out.

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { block, readPayload } from './hook-io.mjs';
import { describe, editorsOfProject } from '../scripts/mjs/ue-proc.mjs';

const TreeVerbs = /pull|merge|rebase|cherry-pick|revert|\bam\b|checkout|switch|restore|clean|reset|stash|submodule|apply|read-tree/;
const GitWord = /^(?:.*[\\/])?git(?:\.exe)?$/i;
const GhWord = /^(?:.*[\\/])?gh(?:\.exe)?$/i;
// A program whose quoted argument is itself a command line.
const ShellWord = /^(?:.*[\\/])?(?:cmd|bash|sh|zsh|dash|powershell|pwsh|wsl|eval|iex|invoke-expression)(?:\.exe)?$/i;
const CdWord = /^(?:cd|chdir|pushd|set-location|sl|push-location)$/i;

/** PURE: is `a` the long option `full` or an abbreviation of it that git accepts (at least `min` characters)? */
const isOpt = (a, full, min) => a.length >= min && a.startsWith('--') && full.startsWith(a);

/**
 * PURE: the command split into simple commands at ; & | ( ) and newlines OUTSIDE quotes, each as a word list
 * (quotes removed). The words «git pull» inside a quoted commit message stay one word and are never a call.
 * @returns {string[][]}
 */
export function splitCommands(command) {
	const out = [];
	let words = [];
	let word = '';
	let inWord = false;
	let quote = null;
	const endWord = () => { if (inWord) words.push(word); word = ''; inWord = false; };
	const endCmd = () => { endWord(); if (words.length) out.push(words); words = []; };
	for (const ch of String(command)) {
		if (quote) {
			if (ch === quote) quote = null;
			else word += ch;
			continue;
		}
		if (ch === '"' || ch === "'") { quote = ch; inWord = true; continue; }
		if (';&|()\n\r'.includes(ch)) { endCmd(); continue; }
		if (/\s/.test(ch)) { endWord(); continue; }
		word += ch;
		inWord = true;
	}
	endCmd();
	return out;
}

/**
 * PURE: every git call in a command line as {dir, sub, args, cd}: `dir` is the last `-C` value or null, `cd` the
 * folder a `cd` earlier in the line moved to (or null). Recognises `git`, `git.exe` and a full path to it at any
 * word of a simple command (after env assignments, `timeout N`, `$x =`, `{`, `then` ...) and inside the quoted
 * command of a shell wrapper. `gh pr checkout` is reported as sub `gh-pr-checkout`.
 */
export function gitCalls(command, depth = 0) {
	const calls = [];
	let cd = null;
	for (const all of splitCommands(command)) {
		const words = all.filter((w) => w !== '{' && w !== '}');
		if (!words.length) continue;
		if (CdWord.test(words[0])) {
			const to = words.slice(1).find((w) => !w.startsWith('-'));
			if (to) cd = to;
			continue;
		}
		const head = words.findIndex((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)); // FOO=1 git ...
		if (head < 0) continue;
		if (ShellWord.test(words[head]) && depth < 3) {
			for (const w of words.slice(head + 1)) {
				if (!/\s/.test(w) || !/\bg(?:it|h)\b/i.test(w)) continue;
				for (const c of gitCalls(w, depth + 1)) calls.push({ ...c, cd: c.cd ?? cd });
			}
		}
		const gh = words.findIndex((w, k) => k >= head && GhWord.test(w));
		if (gh >= 0 && words[gh + 1] === 'pr' && words[gh + 2] === 'checkout') {
			calls.push({ dir: null, sub: 'gh-pr-checkout', args: words.slice(gh + 3), cd });
		}
		let i = GitWord.test(words[head]) ? head : words.findIndex((w, k) => k > head && GitWord.test(w) && !/\s/.test(w));
		if (i < 0) continue;
		let dir = null;
		for (i++; i < words.length; i++) {
			const w = words[i];
			if (w === '-C') { dir = words[++i] ?? null; continue; }
			if (w === '-c' || w === '--git-dir' || w === '--work-tree' || w === '--namespace') { i++; continue; }
			if (w.startsWith('-')) continue;
			break;
		}
		if (i >= words.length) continue;
		calls.push({ dir, sub: words[i].toLowerCase(), args: words.slice(i + 1), cd });
	}
	return calls;
}

/** PURE: the reason word when the call rewrites the working tree, else null. */
export function treeWriter({ sub, args }) {
	const has = (...flags) => args.some((a) => flags.includes(a));
	switch (sub) {
		case 'checkout': case 'switch': {
			// A new branch at HEAD (`checkout -b x`, `switch -c x`, no start point) writes no file.
			const create = sub === 'checkout' ? ['-b', '-B'] : ['-c', '-C', '--create', '--force-create'];
			const words = args.filter((a) => !a.startsWith('-'));
			return has(...create) && words.length === 1 ? null : sub;
		}
		case 'pull': case 'merge': case 'rebase': case 'cherry-pick': case 'revert': case 'am': case 'clean':
			return sub;
		case 'restore':
			// --staged alone touches the index only; --worktree/-W (or neither flag) writes files.
			return has('--staged', '-S') && !has('--worktree', '-W') ? null : 'restore';
		case 'reset': {
			// git takes any unambiguous abbreviation of a long option (--har).
			const mode = ['--hard', '--merge', '--keep'].find((full) => args.some((a) => isOpt(a, full, full === '--merge' ? 4 : 3)));
			return mode ? `reset ${mode}` : null;
		}
		case 'stash': {
			// The value of -m/--message is not the verb (`stash -m list` is a push).
			const verb = args.find((a, k) => !a.startsWith('-') && !['-m', '--message'].includes(args[k - 1]));
			return ['list', 'show', 'drop', 'clear', 'branch', 'create', 'store'].includes(verb) ? null : `stash${verb ? ' ' + verb : ''}`;
		}
		case 'submodule':
			return args.includes('update') ? 'submodule update' : null;
		case 'apply':
			return has('--cached', '--check', '--stat', '--numstat', '--summary') ? null : 'apply';
		case 'read-tree':
			return has('--reset') || args.some((a) => /^-[a-z]*u/.test(a)) ? 'read-tree -u' : null;
		case 'lfs': {
			const verb = args.find((a) => !a.startsWith('-'));
			return verb === 'pull' || verb === 'checkout' ? `lfs ${verb}` : null;
		}
		case 'gh-pr-checkout':
			return 'pr checkout (gh)';
		default:
			return null;
	}
}

function git(dir, ...args) {
	const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
	return r.status === 0 ? r.stdout.trim() : '';
}

function main() {
	const payload = readPayload();
	const command = payload?.tool_input?.command;
	if (typeof command !== 'string' || !/git|\bgh\b/i.test(command) || !TreeVerbs.test(command)) return;
	const cwd = payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
	// msys `/c/x` is `c:/x`.
	const at = (base, p) => {
		const w = String(p).replace(/^\/([A-Za-z])(?=\/|$)/, '$1:');
		return isAbsolute(w) ? w : resolve(base, w);
	};
	for (const call of gitCalls(command)) {
		const what = treeWriter(call);
		if (!what) continue;
		const base = call.cd ? at(cwd, call.cd) : cwd;
		const target = call.dir ? at(base, call.dir) : base;
		// A folder that cannot be resolved (a variable, a typo) falls back to the session's own.
		let root = git(target, 'rev-parse', '--show-toplevel') || git(cwd, 'rev-parse', '--show-toplevel');
		if (!root) continue;
		const superRoot = git(root, 'rev-parse', '--show-superproject-working-tree');
		if (superRoot) root = superRoot;
		// A harness repository mounted as .claude holds nothing the editor locks.
		if (/[\\/]\.claude$/i.test(root)) continue;
		const probe = editorsOfProject(root);
		if (!probe.precise || !probe.pids.length) continue;
		const detail = describe(probe);
		const way = probe.gui.length
			? 'a GUI editor belongs to a person: ask them to close it (never kill it)'
			: 'a headless editor: check `node ue-owner.mjs status`; stop it only if this session started it or it is an ended session\'s headless editor';
		block(`BLOCKED: git ${what} in ${root} is refused while an editor of this project is open (${detail}): files the editor holds would stop it halfway and leave the repository between two states. Way out: ${way}, then run it again. Reading git (status, log, diff, fetch) is not affected; ue-workstation/scripts/safe-pull.cmd pulls source-only changes with the editor open.`);
	}
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
