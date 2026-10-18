// PreToolUse `Agent`: refuses a fork (subagent_type "fork") once the parent's context is past a limit. A fork
// carries the whole parent conversation in every request it makes; past ~150k tokens that is a lot of tokens per
// turn of a task that usually needs a few files. A fresh agent with a self-contained prompt does the same job.
//
// The context size is not in the hook payload; it is read from the transcript: the usage of the last main-chain
// assistant message (input + cache read + cache write). Fail-open: no transcript, no usage -> the fork goes through.
//
// UE_WS_FORK_MAX_CONTEXT — the limit in tokens (default 150000); 0 turns the guard off.

import { closeSync, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { block, readPayload } from './hook-io.mjs';

const DefaultLimit = 150000;
const TailBytes = 4 * 1024 * 1024;

/** The last TailBytes of a file as text (a transcript can be hundreds of MB). */
function tail(path) {
	const fd = openSync(path, 'r');
	try {
		const size = fstatSync(fd).size;
		const len = Math.min(size, TailBytes);
		const buf = Buffer.alloc(len);
		readSync(fd, buf, 0, len, size - len);
		return buf.toString('utf8');
	} finally {
		closeSync(fd);
	}
}

/** PURE: the context tokens of the last main-chain assistant message in JSONL text, or null. */
export function lastContextTokens(jsonl) {
	const lines = jsonl.split('\n');
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i];
		if (!line.includes('"usage"')) continue;
		let j;
		try {
			j = JSON.parse(line);
		} catch {
			continue; // the first line of a tail is usually cut
		}
		if (j.type !== 'assistant' || j.isSidechain) continue;
		const u = j.message?.usage;
		if (!u) continue;
		return (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
	}
	return null;
}

/** The limit from the environment: a positive number, 0 (off), or the default. */
export function limitFrom(env = process.env) {
	const raw = env.UE_WS_FORK_MAX_CONTEXT;
	if (raw === undefined || raw === '') return DefaultLimit;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? n : DefaultLimit;
}

function main() {
	const payload = readPayload();
	if (!payload || payload.tool_name !== 'Agent') return;
	if (String(payload.tool_input?.subagent_type ?? '').toLowerCase() !== 'fork') return;
	const limit = limitFrom();
	if (!limit || !payload.transcript_path) return;
	let tokens = null;
	try {
		tokens = lastContextTokens(tail(payload.transcript_path));
	} catch {
		return;
	}
	if (tokens === null || tokens <= limit) return;
	block(
		`fork-context-guard: this conversation is at ~${Math.round(tokens / 1000)}k tokens of context (limit ${Math.round(limit / 1000)}k). `
		+ 'A fork would carry all of it in every request. Launch a fresh agent instead (general-purpose or a typed one) '
		+ 'with a self-contained prompt: the goal, the files or paths, what is out of scope, and where to write the result. '
		+ '(Limit: UE_WS_FORK_MAX_CONTEXT, 0 turns the guard off.)',
	);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
