// PreToolUse (Bash|PowerShell): the git bypasses an agent must not take on its own — the commit procedure of SKILL.md
// "Git in a UE checkout" held by a hook. Git itself is allowed; the shortcuts around review are not:
//
//   add     explicit paths only: no -A/--all, `.`, `*`, `:/`, and no -u/--update without paths
//   commit  no -a/--all (stages everything tracked), no --amend, no -n/--no-verify
//   push    no force of any kind (-f, --force, --force-with-lease, +refspec), no --delete/-d, `:branch`, --mirror
//   any     no --no-verify
//   history no reset --hard, clean -f, checkout/restore of the whole tree (`.`, `:/`), branch -D, stash clear
//
// Opt-in: off unless UE_WS_GIT_POLICY=1 (settings `env`, e.g. the project's untracked .claude/settings.local.json) —
// a plugin must not change how a person's sessions use git without being asked to.
// When the person really wants one of these, they run it themselves: `! <command>` in the prompt.
//
// Heredoc and PowerShell here-string bodies are dropped before parsing: a commit message that mentions
// `git add .` is text, not a call. Fails open on an unreadable payload. Blocks with exit 2 + a stderr reason.

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { block, readPayload } from './hook-io.mjs';
import { gitCalls } from './no-tree-git-editor-open.mjs';

const Heredoc = /<<-?[ \t]*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g;
const PsHereString = /@(['"])\r?\n[\s\S]*?\r?\n\1@/g;

/** PURE: the command with heredoc / here-string bodies removed and line continuations joined. */
export function dropBodies(command) {
	return String(command)
		.replace(Heredoc, (m) => m.split('\n', 1)[0])
		.replace(PsHereString, "''")
		.replace(/[\\`]\r?\n/g, ' ');
}

/** PURE: the reason a git call breaks the policy, else null. */
export function violation({ sub, args }) {
	const has = (...flags) => args.some((a) => flags.includes(a));
	const short = (letter) => args.some((a) => /^-[A-Za-z]+$/.test(a) && a.includes(letter));
	const paths = args.filter((a) => !a.startsWith('-'));
	if (has('--no-verify')) return '--no-verify skips the checks the repository asks for';
	switch (sub) {
		case 'add':
			if (has('-A', '--all') || paths.some((p) => ['.', '*', ':/', ':/*'].includes(p))) return 'git add of everything: stage your own paths by name';
			if (has('-u', '--update') && !paths.length) return 'git add -u without paths stages every tracked change';
			return null;
		case 'commit':
			if (has('--all') || short('a')) return 'git commit -a stages every tracked change: git add <paths> first';
			if (has('--amend')) return '--amend rewrites a commit: make a new one';
			if (short('n')) return 'git commit -n skips the hooks';
			return null;
		case 'push':
			if (has('--force', '--force-with-lease', '--force-if-includes', '--mirror') || short('f') || args.some((a) => /^--force-with-lease=/.test(a))) return 'force push / mirror';
			if (has('--delete') || short('d') || paths.some((p) => p.startsWith('+') || /^:\S/.test(p))) return 'push that deletes or force-updates a ref';
			return null;
		case 'reset':
			return has('--hard') ? 'reset --hard discards uncommitted work' : null;
		case 'clean':
			return has('--force') || short('f') ? 'clean -f deletes untracked files' : null;
		case 'checkout':
		case 'restore': {
			const after = args.includes('--') ? args.slice(args.indexOf('--') + 1) : paths;
			return after.some((p) => ['.', ':/', '*'].includes(p)) ? `${sub} of the whole tree discards uncommitted work` : null;
		}
		case 'branch':
			return has('-D') || (has('--delete', '-d') && has('--force', '-f')) ? 'branch -D deletes an unmerged branch' : null;
		case 'stash':
			return args.includes('clear') ? 'stash clear drops every stash' : null;
		default:
			return null;
	}
}

function main() {
	if (process.env.UE_WS_GIT_POLICY !== '1') return;
	const payload = readPayload();
	const command = payload?.tool_input?.command;
	if (typeof command !== 'string' || !/git/i.test(command)) return;
	for (const call of gitCalls(dropBodies(command))) {
		const why = violation(call);
		if (why) block(`BLOCKED: git ${call.sub} ${call.args.join(' ')} — ${why}. Commit procedure: show the message and the full file list, wait for the person's explicit OK, then git add <paths> and git commit -F <file>. If the person asked for exactly this command, they run it themselves with \`! <command>\`.`);
	}
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
