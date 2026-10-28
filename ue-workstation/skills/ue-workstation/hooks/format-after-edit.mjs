// PostToolUse (Edit|Write|MultiEdit): clang-format the C++ file just written, and tell the model when that
// changed the file.
//
// Only project sources (a path with /Source/ in it: <Project>/Source, Plugins/*/Source), never generated trees
// or ThirdParty.
// The .clang-format the formatter finds walking up from the file decides the style; with none, the file is left
// as written (--fallback-style=none) - a project without a style is never rewritten into LLVM's.
//
// WHY THE NOTICE: the rewrite silently invalidates the copy the model holds; its next Edit is built from
// pre-format text, old_string no longer matches, and the most frequent flow pays a re-read + retry. The notice
// goes out only on a real change (formatting an already clean file is a no-op, and a notice per edit is noise),
// as additionalContext — a PostToolUse hook's plain stderr with exit 0 never reaches the model.
//
// Fail-open: no clang-format, unreadable payload, a formatter error -> exit 0, nothing said.
// UE_WS_CLANG_FORMAT overrides the formatter (an executable; a .mjs/.js file is run with this node — tests).

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addContext, readPayload } from './hook-io.mjs';

const CppExt = /\.(h|hh|hpp|hxx|inl|ipp|c|cc|cpp|cxx)$/i;
// Generated trees, plus vendored ThirdParty code that must keep its own style.
const Generated = /\/(Binaries|Intermediate|Saved|DerivedDataCache|\.vs|ThirdParty)\//i;

/** PURE: whether this path is a project C++ source the hook formats. */
export function isProjectCpp(path) {
	const p = String(path).replace(/\\/g, '/');
	return CppExt.test(p) && /\/Source\//.test(p) && !Generated.test(p);
}

function formatter(env = process.env) {
	const custom = env.UE_WS_CLANG_FORMAT;
	if (custom) return /\.(mjs|js)$/i.test(custom) ? [process.execPath, [custom]] : [custom, []];
	return ['clang-format', []];
}

function main() {
	const payload = readPayload();
	const path = payload?.tool_input?.file_path;
	if (typeof path !== 'string' || !isProjectCpp(path) || !existsSync(path)) return;
	let before;
	try { before = readFileSync(path); } catch { return; }
	const [exe, pre] = formatter();
	const r = spawnSync(exe, [...pre, '--fallback-style=none', '-i', path], { stdio: 'ignore', windowsHide: true, timeout: 30000 });
	if (r.error || r.status !== 0) return;
	let after;
	try { after = readFileSync(path); } catch { return; }
	if (!before.equals(after)) {
		addContext('PostToolUse', `clang-format rewrote ${path} after your edit: the copy you hold is now STALE. Re-read it before the next Edit to that file; an Edit built on the pre-format text will fail to match.`);
	}
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
