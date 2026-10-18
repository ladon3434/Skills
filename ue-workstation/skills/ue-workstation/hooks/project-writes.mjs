// PreToolUse + PermissionRequest (Edit|Write|NotebookEdit|MultiEdit): write inside the project without being
// asked, ask for anything outside it.
//
// A hook rather than a permission rule: a rule in a user-level settings file cannot say "the project directory"
// (its paths resolve against ~/.claude); $CLAUDE_PROJECT_DIR is the only project-independent way to name it.
// Deletion is the other half of the policy and lives in the `ask` list of settings.json (rm / Remove-Item / ...).
//
// Also allowed without asking: the Claude config dir (CLAUDE_CONFIG_DIR or ~/.claude: skills, memory), agent
// scratch folders (*/Temp/claude/*), and extra roots in UE_WS_WRITE_ROOTS (';'-separated, e.g. a sibling
// project or a shared asset drive).
// No decision (normal permission flow): generated trees Binaries/Intermediate/DerivedDataCache/Saved/.vs, .git,
// node_modules — "generated trees are never edited" is the model's rule, not this hook's.
//
// Why PermissionRequest too: `.claude/` is a protected path; its safety check runs before allow rules, so a
// PreToolUse allow cannot talk over it. Outside bypassPermissions that check raises a dialog, the dialog fires
// PermissionRequest, and the grant is repeated there, where it counts.
//
// Opt-in: the plugin ships this hook switched off — it loosens the permission policy, which installing a plugin
// must not do silently. It acts only with UE_WS_PROJECT_WRITES=1 (settings `env`, e.g. the project's untracked
// .claude/settings.local.json); otherwise it exits with no decision.
//
// Fail-open: an unreadable payload or a path that cannot be canonicalised -> no decision.

import { homedir } from 'node:os';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normPath, readPayload } from './hook-io.mjs';

/** PURE: textual canonicalisation of `.` / `..` (the file need not exist); null when `..` escapes the root. */
export function canonical(p) {
	const parts = [];
	const segs = normPath(p).split('/');
	for (let i = 0; i < segs.length; i++) {
		const s = segs[i];
		if (s === '.' || (s === '' && i > 0)) continue;
		if (s === '..') {
			if (parts.length <= 1) return null;
			parts.pop();
			continue;
		}
		parts.push(s);
	}
	return parts.join('/') || '/';
}

const under = (path, root) => !!root && (path === root || path.startsWith(root + '/'));

/**
 * PURE: 'allow' | 'ask' | null (no decision) for a write to `file`.
 * @param {string} file the payload's path (absolute or relative to the project)
 * @param {{project: string, configDir: string, extraRoots?: string[]}} ctx
 */
export function decide(file, ctx) {
	const project = canonical(ctx.project);
	const raw = normPath(file);
	const abs = /^([a-z]:)?\//.test(raw) ? raw : `${project}/${raw}`;
	const f = canonical(abs);
	if (!f) return null;
	if (/\/(binaries|intermediate|deriveddatacache|saved|\.vs|\.git|node_modules)(\/|$)/.test(f)) return null;
	if (under(f, canonical(ctx.configDir))) return 'allow';
	if (/\/temp\/claude\//.test(f)) return 'allow';
	for (const r of ctx.extraRoots ?? []) if (r && under(f, canonical(r))) return 'allow';
	if (under(f, project)) return 'allow';
	return 'ask';
}

function main() {
	if (process.env.UE_WS_PROJECT_WRITES !== '1') return;
	const payload = readPayload();
	const file = payload?.tool_input?.file_path ?? payload?.tool_input?.notebook_path;
	if (typeof file !== 'string' || !file) return;
	const event = payload.hook_event_name || 'PreToolUse';
	const verdict = decide(file, {
		// A background job may start hooks without CLAUDE_PROJECT_DIR; the payload's cwd is the next best answer.
		project: process.env.CLAUDE_PROJECT_DIR || payload.cwd || process.cwd(),
		configDir: process.env.CLAUDE_CONFIG_DIR || `${process.env.USERPROFILE || homedir()}/.claude`,
		extraRoots: (process.env.UE_WS_WRITE_ROOTS || '').split(';').map((s) => s.trim()).filter(Boolean),
	});
	if (verdict === 'allow') {
		const out = event === 'PermissionRequest'
			? { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } }
			: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'Write inside the project.' } };
		process.stdout.write(JSON.stringify(out));
	} else if (verdict === 'ask' && event !== 'PermissionRequest') {
		// On PermissionRequest "ask" means saying nothing: the dialog shows.
		process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'Write outside the project directory - confirm.' } }));
	}
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
