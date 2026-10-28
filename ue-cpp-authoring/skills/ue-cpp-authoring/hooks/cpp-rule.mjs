// PostToolUse (Read|Edit|Write|MultiEdit): the first time in a session a file under a Source/ tree is read or
// written, hand the model the always-on Unreal C++ facts from ../rules/ue-cpp.md.
//
// WHY A HOOK: a plugin cannot ship `.claude/rules` (path-scoped rules are not a plugin component), and copying the
// rule into the project's .claude/rules is exactly the project change the plugin install must avoid. This hook
// reproduces the rule's `paths:` trigger: same globs, same text, once per session.
//
// Once per session: a marker file `ue-cpp-rule-<session_id>` in the OS temp dir. No session id -> say it every
// time (still correct, only noisier). Fail-open: unreadable payload or rule file -> exit 0, nothing said.

import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const Here = dirname(fileURLToPath(import.meta.url));
const RuleFile = join(Here, '..', 'rules', 'ue-cpp.md');

/** PURE: the rule's `paths:` — Source/** and Plugins/**\/Source/**, generated trees excluded. */
export function isProjectSource(path) {
	const p = String(path ?? '').replace(/\\/g, '/');
	return /(^|\/)Source\//.test(p) && !/\/(Binaries|Intermediate|Saved|DerivedDataCache|\.vs)\//i.test(p);
}

/** PURE: the rule body without its YAML frontmatter. */
export function ruleBody(text) {
	return String(text).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();
}

function main() {
	let payload;
	try {
		payload = JSON.parse(readFileSync(0, 'utf8'));
	} catch {
		process.exit(0);
	}
	const path = payload?.tool_input?.file_path ?? payload?.tool_input?.notebook_path;
	if (!isProjectSource(path)) process.exit(0);

	const sid = String(payload?.session_id ?? '').replace(/[^\w-]/g, '');
	const marker = sid ? join(tmpdir(), `ue-cpp-rule-${sid}`) : null;
	if (marker && existsSync(marker)) process.exit(0);

	let body;
	try {
		body = ruleBody(readFileSync(RuleFile, 'utf8'));
	} catch {
		process.exit(0);
	}
	if (marker) {
		try {
			writeFileSync(marker, '');
		} catch {
			// no marker -> the rule repeats on the next Source/ file; harmless
		}
	}
	process.stdout.write(
		JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: body } }),
	);
	process.exit(0);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
