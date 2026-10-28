// unbounded-wait-guard.mjs — no wait without an end. A background command in an interactive window has no time limit
// of the client's own, and a foreground command that outlives its `timeout` is not killed: the client moves it to
// the background, where it runs unbounded too. A window that then ends its turn "waiting for the notice" sits idle
// for as long as the command hangs — one stood three hours behind a single hung loop.
//
// PreToolUse  Bash|PowerShell  a `run_in_background` command is refused unless the command itself carries its bound:
//                              a coreutils `timeout <N>` (Git Bash; in the PowerShell tool only through `bash -c`,
//                              since a bare `timeout` there is timeout.exe, a sleep), or a PowerShell `-Timeout…`
//                              parameter (`Wait-Job -Timeout`, `Wait-Process -Timeout`, `Invoke-WebRequest
//                              -TimeoutSec`). When the bound fires the command ends, its notice wakes the window, and
//                              the window tells the person what hung. A process meant to outlive the call (a server,
//                              a watcher the person asked for) says so with a comment `unbounded-ok: <why>`.
// PostToolUse Bash|PowerShell  a foreground command the client moved to the background (the client's own mark
//                              `tool_response.timedOutAfterMs`) is named to the agent at once, with the same rule
//                              for waiting on it.
//
// Off with UE_WS_WAIT_GUARD=0. Fails open on an unreadable payload. Blocks with exit 2 + a stderr reason.

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { addContext, block, readPayload } from './hook-io.mjs';

export const OptOut = 'unbounded-ok:';

// A coreutils `timeout [-k N] [-s SIG] <N>[smhd]` at the start of a command: after a separator, `(`, `$(`, `!`, `{`,
// a backtick, or the quote that opens a `bash -c` string.
const BashBound = /(?:^|[;&|(!{`"'\s])timeout\s+(?:-\S+\s+(?:[0-9]\S*\s+)?)*[0-9]+(?:\.[0-9]+)?[smhd]?(?:\s|$)/;
// PowerShell parameter names are case-insensitive: -Timeout, -TimeoutSec, -timeoutsec 30, -Timeout:600.
const PsBound = /-Timeout[A-Za-z]*[\s:]+[0-9]/i;
const BashInPs = new RegExp(String.raw`\bbash(?:\.exe)?\b[^;]*` + BashBound.source);

/**
 * PURE: why a background command must be refused — the hint to give the agent — or null when it passes.
 * `tool` is the tool name (Bash | PowerShell).
 */
export function unboundedHint(tool, command) {
	const cmd = String(command ?? '');
	if (!cmd.trim() || cmd.includes(OptOut)) return null;
	if (tool === 'PowerShell') {
		if (PsBound.test(cmd) || BashInPs.test(cmd)) return null;
		return 'In the PowerShell tool a bare `timeout` is timeout.exe (a sleep): run the wait from the Bash tool as `timeout <seconds> <command>`, or give the PowerShell wait its own `-Timeout`.';
	}
	if (BashBound.test(cmd)) return null;
	return 'Prefix it: `timeout <seconds> <command>` (for a loop: `timeout 600 bash -c "until grep -q READY f; do sleep 5; done"`).';
}

/** PURE: did the client move this foreground command to the background? Its mark is a key of tool_response. */
export function movedToBackground(toolResponse) {
	return !!toolResponse && typeof toolResponse === 'object' && !Array.isArray(toolResponse)
		&& Object.prototype.hasOwnProperty.call(toolResponse, 'timedOutAfterMs');
}

export const MovedNotice = 'THIS COMMAND DID NOT FINISH WITHIN ITS TIMEOUT AND NOW RUNS IN THE BACKGROUND WITH NO TIME LIMIT. '
	+ 'Do not end your turn waiting for its notice: if it hangs, nobody is told. Either stop it (TaskStop) and re-run it '
	+ 'under `timeout <seconds>`, or wait on it with a bound — the Monitor tool (it has a deadline) or a background '
	+ '`timeout <seconds> bash -c "until …; do sleep 5; done"`. When the bound fires, tell the person what hung and for how long.';

function main() {
	if (process.env.UE_WS_WAIT_GUARD === '0') return;
	const payload = readPayload();
	if (!payload) return;
	const tool = String(payload.tool_name ?? '');
	if (tool !== 'Bash' && tool !== 'PowerShell') return;
	if (payload.hook_event_name === 'PostToolUse') {
		if (movedToBackground(payload.tool_response)) addContext('PostToolUse', MovedNotice);
		return;
	}
	if (payload.hook_event_name !== 'PreToolUse' || payload.tool_input?.run_in_background !== true) return;
	const how = unboundedHint(tool, payload.tool_input?.command);
	if (!how) return;
	block(
		'REFUSED: a background command with no time bound. In this window a background command has no limit of its own; '
		+ 'if it hangs, its notice never comes and the window waits silently for hours.\n'
		+ `${how}\n`
		+ 'Pick the bound as the longest a healthy run takes, with margin. When it fires (exit 124), tell the person what '
		+ 'hung and for how long — never wait again silently.\n'
		+ `A process meant to outlive the call (a server, a watcher the person asked for) carries a comment \`${OptOut} <why>\` instead. `
		+ '(Off on this machine: UE_WS_WAIT_GUARD=0.)',
	);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
