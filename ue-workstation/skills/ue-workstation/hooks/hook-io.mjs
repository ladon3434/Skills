// hook-io.mjs — the shared bits of the Claude Code hooks in this folder. Node, not bash + jq: Git for Windows
// ships no jq, and a guard that needs it silently waves everything through on a machine without it.

import { readFileSync } from 'node:fs';

/** The hook payload from stdin, or null when it is missing or not JSON (every hook then fails open). */
export function readPayload() {
	let raw = '';
	try {
		raw = readFileSync(0, 'utf8');
	} catch {
		return null;
	}
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

/** Lower-case forward-slash path; msys `/c/x` folded to `c:/x`; no trailing slash. */
export function normPath(p) {
	let s = String(p ?? '').replace(/\\/g, '/').toLowerCase();
	const msys = s.match(/^\/([a-z])\/(.*)$/);
	if (msys) s = `${msys[1]}:/${msys[2]}`;
	return s.replace(/\/+$/, '');
}

/** Block a PreToolUse call: the reason goes to the model on stderr, exit code 2. */
export function block(reason) {
	process.stderr.write(reason + '\n');
	process.exit(2);
}

/** Say something to the model without blocking (PostToolUse / SubagentStart / SessionStart). */
export function addContext(hookEventName, text) {
	process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: text } }));
	process.exit(0);
}
