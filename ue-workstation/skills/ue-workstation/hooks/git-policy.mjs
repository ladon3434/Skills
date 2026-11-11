// PreToolUse (Bash|PowerShell): the git bypasses an agent must not take on its own — the commit procedure of SKILL.md
// "Git in a UE checkout" held by a hook. Git itself is allowed; the shortcuts around review are not:
//
//   add     explicit paths only: no -A/--all, `.`, `*`, `:/`, and no -u/--update without paths
//   commit  no -a/--all (stages everything tracked), no --amend, no -n/--no-verify
//   push    no force of any kind (-f, --force, --force-with-lease, +refspec), no --delete/-d, `:branch`, --mirror
//   any     no --no-verify
//   history no reset --hard, clean -f, checkout/restore of the whole tree (`.`, `./`, `:/`), checkout -f,
//           switch -f / --discard-changes, branch -D, stash clear, no `-c core.hooksPath=`
//   Abbreviated long options (--amen, --forc, --har) count as the option; the text after -m / -F does not.
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
export function violation({ sub, args: raw, pre = [] }) {
	// The value of -m / -F / --message / --file is text, not an option: `commit -m "--no-verify"` skips nothing.
	const args = raw.filter((a, k) => !(k > 0 && (/^-[A-Za-z]*[mF]$/.test(raw[k - 1]) || ['--message', '--file'].includes(raw[k - 1]))) && !/^--(?:message|file)=/.test(a));
	const has = (...flags) => args.some((a) => flags.includes(a));
	// git takes any unambiguous abbreviation of a long option: --amen, --forc, --har.
	const long = (full, min) => args.some((a) => a.startsWith('--') && a.split('=')[0].length >= min && full.startsWith(a.split('=')[0]));
	const short = (letter) => args.some((a) => /^-[A-Za-z]+$/.test(a) && a.includes(letter));
	const paths = args.filter((a) => !a.startsWith('-'));
	// `./`, `.\`, `./.` are the whole tree as much as `.` is.
	const whole = (p) => ['.', '*', ':/', ':/*', '..'].includes(p.replace(/^(?:\.[\\/])+/, '').replace(/[\\/]+$/, '') || '.');
	if (long('--no-verify', 6)) return '--no-verify skips the checks the repository asks for';
	if (pre.some((p) => /^core\.hookspath=/i.test(p))) return '-c core.hooksPath=... switches the hooks of the repository off';
	switch (sub) {
		case 'add':
			if (has('--all') || short('A') || paths.some(whole)) return 'git add of everything: stage your own paths by name';
			if ((short('u') || long('--update', 3)) && !paths.length) return 'git add -u without paths stages every tracked change';
			return null;
		case 'commit':
			if (has('--all') || short('a')) return 'git commit -a stages every tracked change: git add <paths> first';
			if (long('--amend', 4)) return '--amend rewrites a commit: make a new one';
			if (short('n')) return 'git commit -n skips the hooks';
			return null;
		case 'push':
			if (args.some((a) => /^--for/.test(a)) || long('--mirror', 3) || short('f')) return 'force push / mirror';
			if (long('--delete', 4) || short('d') || paths.some((p) => p.startsWith('+') || /^:\S/.test(p))) return 'push that deletes or force-updates a ref';
			return null;
		case 'reset':
			return long('--hard', 3) ? 'reset --hard discards uncommitted work' : null;
		case 'clean':
			return long('--force', 3) || short('f') ? 'clean -f deletes untracked files' : null;
		case 'switch':
			return long('--discard-changes', 4) || long('--force', 3) || short('f') ? 'switch that discards local changes' : null;
		case 'checkout':
		case 'restore': {
			if (sub === 'checkout' && (long('--force', 3) || short('f'))) return 'checkout -f discards local changes';
			const after = args.includes('--') ? args.slice(args.indexOf('--') + 1) : paths;
			return after.some(whole) ? `${sub} of the whole tree discards uncommitted work` : null;
		}
		case 'branch':
			return short('D') || ((long('--delete', 3) || short('d')) && (long('--force', 3) || short('f'))) ? 'branch -D deletes an unmerged branch' : null;
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
