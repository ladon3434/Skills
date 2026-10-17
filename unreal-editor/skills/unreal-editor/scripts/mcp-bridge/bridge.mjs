// bridge.mjs — lazy stdio <-> HTTP MCP bridge for an Unreal editor's MCP server (Epic's unreal-mcp, or VibeUE on it).
//
// The editor's MCP server exists only while an editor runs, and Claude Code connects to its MCP servers at session
// start: with the editor down the tools are absent for the whole session, and after an editor restart a plain
// `type: http` registration stays disconnected (the reason the skill keeps a curl fallback). This bridge is a stdio
// server Claude Code OWNS, so it never disconnects:
//   - initialize / ping / tools/list are answered locally (tool list from an on-disk cache, else a seed), so a
//     session starts instantly and never pays an editor boot it does not need;
//   - the first tools/call boots the editor (lazy), headless by default, only when the machine rule allows it
//     (ue-owner.mjs: no editor of this project runs, no editor elsewhere that is not ours, no foreign build), and
//     writes the ownership marker <project>/Saved/AgentEditors/<pid>.json so this session may stop it later;
//   - calls are proxied; a stale session after an editor restart is renewed and the call replayed; a dead editor is
//     reported with the recovery path and relaunched on the next call;
//   - the live tool list is cached and `notifications/tools/list_changed` tells the client when it changed;
//   - base64 images inside a toolset's JSON text (CaptureViewport, CaptureAssetImage, Slate Screenshot) are lifted
//     into native MCP image blocks, so a screenshot is seen in one call instead of overflowing the result limit.
// It never stops the editor. A headless editor it started stays up after the session ends: its marker then names
// an ended session, so the next session may adopt it (ue-owner: a headless orphan) or stop it.
//
//   node bridge.mjs [--project DIR] [--url URL] [--name unreal-mcp] [--seed FILE] [--launch default|none|"<cmd>"]
//                   [--prewarm] [--help]
// Env: UE_MCP_URL / UE_MCP_PORT (server), UE_MCP_LAUNCH (launch command), MCP_BRIDGE_CACHE_DIR,
//      MCP_BRIDGE_CALL_TIMEOUT_SEC (default 900), MCP_BRIDGE_PROGRESS_SEC (15), MCP_BRIDGE_WARMUP_SEC (45),
//      MCP_BRIDGE_LAUNCH_TIMEOUT_SEC (240), UE_OWNER_FIXTURE (tests: a synthetic process table for ue-owner.mjs).

import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { findProjectUproject, resolveEngine } from '../mjs/ue-engine.mjs';
import { preflight, projectInfo } from '../mjs/ue-project.mjs';
import { canLaunch, claim, editors, sameProject, snapshot, whoAmI } from '../mjs/ue-owner.mjs';

const Here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (f) => {
	const i = argv.indexOf(f);
	return i >= 0 ? argv[i + 1] : null;
};

if (argv.includes('--help') || argv.includes('-h')) {
	const head = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).slice(0, 26);
	process.stdout.write(head.map((l) => l.replace(/^\/\/ ?/, '')).join('\n') + '\n');
	process.exit(0);
}

// --- configuration -------------------------------------------------------------------------------------------

const ServerName = opt('--name') || 'unreal-mcp';
const projectArg = opt('--project');
const Uproject = projectArg ? (projectArg.toLowerCase().endsWith('.uproject') ? resolve(projectArg) : findProjectUproject(resolve(projectArg))) : findProjectUproject();
const Info = Uproject ? projectInfo(Uproject, process.env, { withEngine: false }) : null;
const UpstreamUrl = opt('--url') || process.env.UE_MCP_URL || Info?.url || `http://127.0.0.1:${process.env.UE_MCP_PORT || 8000}/mcp`;
const CacheDir = process.env.MCP_BRIDGE_CACHE_DIR || (Info ? join(Info.project, 'Saved', 'mcp-bridge') : join(tmpdir(), 'unreal-editor-mcp', 'bridge'));
const CacheFile = join(CacheDir, `${ServerName}.tools.json`);
const LockFile = join(CacheDir, 'editor-launch.lock');
const SeedFile = opt('--seed') || join(Here, 'seed-epic-tool-search.json');
const LaunchMode = opt('--launch') || process.env.UE_MCP_LAUNCH || 'default';
const Prewarm = argv.includes('--prewarm');
const secs = (name, dflt) => (Number(process.env[name]) > 0 ? Number(process.env[name]) : dflt) * 1000;
const LaunchTimeoutMs = secs('MCP_BRIDGE_LAUNCH_TIMEOUT_SEC', 240); // a cold boot on a file DDC takes 3-4 minutes
const StaleLockMs = LaunchTimeoutMs + 30000;
const CallWarmupMs = secs('MCP_BRIDGE_WARMUP_SEC', 45); // under a typical 60 s client tool timeout
const ToolCallTimeoutMs = secs('MCP_BRIDGE_CALL_TIMEOUT_SEC', 15 * 60); // backstop for a hung game-thread call
const ProgressEveryMs = secs('MCP_BRIDGE_PROGRESS_SEC', 15);
const ProtocolFallback = '2025-06-18';

mkdirSync(CacheDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...parts) => process.stderr.write(`[mcp-bridge:${ServerName}] ${parts.join(' ')}\n`);
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const makeResult = (id, result) => ({ jsonrpc: '2.0', id: id ?? null, result });
const makeError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const toolError = (id, text) => makeResult(id, { content: [{ type: 'text', text }], isError: true });

// --- state ---------------------------------------------------------------------------------------------------

let clientProtocol = ProtocolFallback;
let upstreamSessionId = null;
let upstreamReady = false;
let connecting = null;
let cachedTools = null;
let launchFailedAt = 0;
let launchRefused = null; // why the last connect did not launch (an editor that is not ours, restore panel...)
let launchLockHeld = false;
let bridgeIds = 1;
const nextId = () => `bridge-${bridgeIds++}`;

function loadToolList(file) {
	const j = JSON.parse(readFileSync(file, 'utf8'));
	return { tools: Array.isArray(j.tools) ? j.tools : [] };
}
try {
	if (existsSync(CacheFile)) cachedTools = loadToolList(CacheFile);
	else if (SeedFile && existsSync(SeedFile)) {
		cachedTools = loadToolList(SeedFile);
		log(`no runtime tool cache yet; serving the seed ${SeedFile} until the first live tools/list`);
	}
} catch (e) {
	log('failed to read the tool cache:', e.message);
}

/** Is the editor alive and merely slow? A live process keeps writing its log; a dead one or one on a modal stops. */
function editorLogAdvancing(withinMs = 90000) {
	try {
		if (!Info?.log || !existsSync(Info.log)) return null;
		const age = Date.now() - statSync(Info.log).mtimeMs;
		return age <= withinMs ? `${Info.name}.log written ${Math.round(age / 1000)}s ago` : null;
	} catch {
		return null;
	}
}

// --- upstream HTTP (Streamable HTTP: JSON or SSE, optional session id) -------------------------------------------

function parseSse(text) {
	const messages = [];
	let data = [];
	const flush = () => {
		if (!data.length) return;
		try {
			messages.push(JSON.parse(data.join('\n')));
		} catch {
			/* keep-alive frame */
		}
		data = [];
	};
	for (const line of text.split(/\r?\n/)) {
		if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
		else if (line === '') flush();
	}
	flush();
	return messages.length === 1 ? messages[0] : messages;
}

async function upstreamPost(body, timeoutMs = 600000) {
	const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
	if (upstreamSessionId) headers['mcp-session-id'] = upstreamSessionId;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(UpstreamUrl, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
		const sid = res.headers.get('mcp-session-id');
		if (sid) upstreamSessionId = sid;
		if (res.status === 202) return null;
		if (!res.ok) {
			// A stale mcp-session-id after an editor restart shows up here as 400/404.
			const err = new Error(`upstream HTTP ${res.status}`);
			err.httpStatus = res.status;
			throw err;
		}
		const text = await res.text();
		if (!text) return null;
		return (res.headers.get('content-type') || '').includes('text/event-stream') ? parseSse(text) : JSON.parse(text);
	} catch (e) {
		if (controller.signal.aborted) {
			const err = new Error(`upstream call timed out after ${Math.round(timeoutMs / 1000)}s`);
			err.timedOut = true;
			throw err;
		}
		throw e;
	} finally {
		clearTimeout(timer);
	}
}

async function upstreamRpc(request, timeoutMs) {
	const out = await upstreamPost(request, timeoutMs);
	if (out == null) return null;
	if (Array.isArray(out)) return out.find((m) => m && m.id === request.id) || out[out.length - 1];
	return out;
}

async function handshake(timeoutMs) {
	upstreamSessionId = null;
	const res = await upstreamRpc(
		{ jsonrpc: '2.0', id: nextId(), method: 'initialize', params: { protocolVersion: clientProtocol, capabilities: {}, clientInfo: { name: 'unreal-editor-bridge', version: '1.0.0' } } },
		timeoutMs,
	);
	if (!res || res.error) throw new Error('initialize rejected by upstream');
	await upstreamPost({ jsonrpc: '2.0', method: 'notifications/initialized' }, timeoutMs).catch(() => {});
	return true;
}

async function safeHandshake(timeoutMs) {
	try {
		return await handshake(timeoutMs);
	} catch {
		return false;
	}
}

// --- the ownership rule and the launch guard ------------------------------------------------------------------------

/**
 * May this bridge launch an editor? {go: true}; {wait: reason} when this session's editor of the project is already
 * up (booting: wait for it, never start a second); {refuse: reason} otherwise.
 */
async function launchGuard() {
	if (Info) {
		const pf = await preflight(Info, { probe: false });
		const panel = pf.verdicts.find((v) => v.startsWith('RESTORE PANEL'));
		if (panel) return { refuse: `${panel} (Saved/Autosaves/PackageRestoreData.json)` };
	}
	const snap = snapshot();
	if (!snap) return { refuse: 'the process query failed, so nobody can tell whose editors run here - not starting one blind' };
	const me = whoAmI(snap);
	if (!me) log("no claude.exe above the bridge: an editor it starts cannot be recorded as this session's");
	if (!Info) {
		const others = editors(snap, me).filter((e) => e.state !== 'mine');
		return others.length ? { refuse: `an editor that is not ours runs (pid ${others.map((e) => e.pid).join(', ')}) and the bridge has no project to judge it - not starting a second one` } : { go: true };
	}
	const v = canLaunch(snap, me, Info.project);
	if (v.ok) return { go: true };
	if (v.reuse) return { wait: v.reason };
	return { refuse: v.reason };
}

/** Records the editor this bridge just started: `pid` when the spawn is the editor, else found by start time. */
function claimLaunched(since, pid = null) {
	if (!Info) return;
	const snap = snapshot();
	if (!snap) return;
	const me = whoAmI(snap);
	if (!me) return;
	const fresh = editors(snap, me).filter((e) =>
		pid ? e.pid === pid : e.state === 'human' && sameProject(e.project, Info.project) && e.start != null && e.start >= since - 2000);
	for (const e of fresh) {
		if (e.state === 'mine') continue;
		const r = claim(snap, me, e.pid, { projectRoot: Info.project, since });
		log(r.ok ? `editor pid ${e.pid} recorded as this session's (Saved/AgentEditors)` : `editor pid ${e.pid} not recorded: ${r.reason}`);
	}
}

function acquireLaunchLock() {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			closeSync(openSync(LockFile, 'wx'));
			launchLockHeld = true;
			return true;
		} catch (e) {
			if (e.code !== 'EEXIST') return false;
			try {
				if (Date.now() - statSync(LockFile).mtimeMs > StaleLockMs) {
					unlinkSync(LockFile); // a bridge that died mid-launch
					continue;
				}
			} catch {
				/* vanished: retry */
			}
			return false;
		}
	}
	return false;
}

function releaseLaunchLock() {
	launchLockHeld = false;
	try {
		unlinkSync(LockFile);
	} catch {
		/* gone */
	}
}

/** The default launch: the project's engine, headless, MCP server forced on at the bridge's port. */
function defaultLaunch() {
	if (!Info) throw new Error('no .uproject to launch - pass --project or a --launch command');
	const eng = resolveEngine(process.env, Info.uproject);
	if (eng.error) throw new Error(eng.error);
	const exe = join(eng.unrealHome, 'Engine', 'Binaries', 'Win64', 'UnrealEditor-Cmd.exe');
	const port = new URL(UpstreamUrl).port || '80';
	// -RenderOffScreen keeps Slate and the viewport alive (the GUI toolsets work); -nullrhi would break them.
	return {
		cmd: exe,
		args: [Info.uproject, '-unattended', '-nopause', '-nosplash', '-RenderOffScreen', '-nosound', '-SCCProvider=None', '-ModelContextProtocolStartServer', `-ModelContextProtocolPort=${port}`],
	};
}

function launchEditor() {
	if (LaunchMode === 'default') {
		const { cmd, args } = defaultLaunch();
		log(`launching: ${cmd} ${args.join(' ')}`);
		// detached: on Windows a non-detached child sits in Node's kill-on-close job and would die with the bridge.
		const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true });
		child.unref();
		return child.pid ?? null;
	}
	log(`launching: ${LaunchMode}`);
	spawn(LaunchMode, { stdio: 'ignore', detached: true, windowsHide: true, shell: true }).unref();
	return null; // a shell command: the editor is found by its start time
}

// --- connect flow -------------------------------------------------------------------------------------------------

async function connectFlow() {
	launchFailedAt = 0;
	launchRefused = null;
	if (await safeHandshake(3000)) {
		log('upstream already up');
		upstreamReady = true;
		void refreshCache();
		return true;
	}
	if (LaunchMode === 'none') {
		launchRefused = 'the bridge runs with --launch none: start the editor yourself (scripts/editor-ready.sh waits for it)';
		return false;
	}
	const locked = acquireLaunchLock();
	try {
		let since = null;
		let spawnedPid = null;
		if (locked) {
			const g = await launchGuard();
			if (g.refuse) {
				launchRefused = g.refuse;
				log(`not launching: ${g.refuse}`);
				return false;
			}
			if (g.wait) log(`not launching a second editor: ${g.wait}; waiting for it`);
			else {
				since = Date.now();
				try {
					spawnedPid = launchEditor();
				} catch (e) {
					launchRefused = `launch failed: ${e.message}`;
					log(launchRefused);
					return false;
				}
			}
		} else {
			log('an editor launch is already in progress (another bridge); waiting');
		}
		const deadline = Date.now() + LaunchTimeoutMs;
		let pollMs = 250;
		let claimed = since === null;
		const claimOnce = () => {
			if (claimed) return;
			claimed = true;
			claimLaunched(since, spawnedPid);
		};
		while (Date.now() < deadline) {
			if (since !== null && Date.now() - since > 3000) claimOnce();
			if (await safeHandshake(3000)) {
				claimOnce();
				log('upstream ready');
				upstreamReady = true;
				void refreshCache();
				return true;
			}
			await sleep(pollMs);
			pollMs = Math.min(pollMs * 2, 2000);
		}
	} finally {
		if (locked) releaseLaunchLock();
	}
	log('timed out waiting for the editor');
	launchFailedAt = Date.now();
	return false;
}

function startConnect() {
	if (upstreamReady) return Promise.resolve(true);
	if (!connecting) {
		connecting = connectFlow().finally(() => {
			if (!upstreamReady) connecting = null;
		});
	}
	return connecting;
}

/** Wait up to `ms` for the editor, never cancelling the launch: the agent's retry lands on a warm editor. */
async function ensureUpstreamWithin(ms) {
	if (upstreamReady) return true;
	return (await Promise.race([startConnect(), sleep(ms).then(() => 'pending')])) === true;
}

function connectionErrorCode(e) {
	const code = e?.cause?.code || e?.code;
	return code && ['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ENOTFOUND', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'].includes(code) ? code : null;
}

function markUpstreamDead(reason) {
	upstreamReady = false;
	upstreamSessionId = null;
	connecting = null;
	log(`upstream lost (${reason}); the next call reconnects or relaunches`);
}

async function refreshCache() {
	try {
		const res = await upstreamRpc({ jsonrpc: '2.0', id: nextId(), method: 'tools/list', params: {} }, 60000);
		if (!res?.result || !Array.isArray(res.result.tools)) return;
		const fresh = JSON.stringify({ tools: res.result.tools });
		const previous = cachedTools ? JSON.stringify(cachedTools) : null;
		cachedTools = { tools: res.result.tools };
		writeFileSync(CacheFile, fresh);
		if (fresh !== previous) {
			send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
			log('tool list changed; client notified');
		}
	} catch (e) {
		log('tool list refresh failed:', e.message);
	}
}

// --- images -------------------------------------------------------------------------------------------------------

/** Lift every {mimeType:"image/...", data:"<base64>"} inside a JSON text block into a native MCP image block; the
 *  text keeps a short placeholder and stays readable (CaptureViewport's labeledActors). Never breaks the relay. */
function liftToolsetImages(res) {
	try {
		const content = res?.result?.content;
		if (!Array.isArray(content)) return;
		const extracted = [];
		for (const block of content) {
			if (block?.type !== 'text' || typeof block.text !== 'string' || block.text.length < 4096) continue;
			if (!block.text.includes('"data"') || !block.text.includes('"mimeType"')) continue;
			let parsed;
			try {
				parsed = JSON.parse(block.text);
			} catch {
				continue;
			}
			const before = extracted.length;
			const lift = (node) => {
				if (!node || typeof node !== 'object') return;
				for (const [key, val] of Object.entries(node)) {
					if (!val || typeof val !== 'object') continue;
					if (typeof val.mimeType === 'string' && val.mimeType.startsWith('image/') && typeof val.data === 'string' && val.data.length > 2048) {
						extracted.push({ type: 'image', data: val.data, mimeType: val.mimeType });
						node[key] = `<image lifted to a native MCP image block (${val.mimeType})>`;
					} else lift(val);
				}
			};
			lift({ root: parsed });
			if (extracted.length > before) block.text = JSON.stringify(parsed);
		}
		if (extracted.length) content.push(...extracted);
	} catch {
		/* cosmetic */
	}
}

// --- request handling ---------------------------------------------------------------------------------------------

function reportProgress(msg) {
	const token = msg.params?._meta?.progressToken;
	if (token === undefined || token === null) return () => {};
	const started = Date.now();
	const timer = setInterval(() => {
		const sec = Math.round((Date.now() - started) / 1000);
		send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: sec, message: `${msg.params?.name}: the editor is working, ${sec}s` } });
	}, ProgressEveryMs);
	return () => clearInterval(timer);
}

function notReadyText() {
	const writing = editorLogAdvancing();
	if (launchRefused) return `EDITOR NOT STARTED: ${launchRefused}. Nothing was run. Resolve that (node <unreal-editor skill>/scripts/mjs/ue-owner.mjs status lists every editor and whose it is), then re-run this exact call.`;
	if (launchFailedAt) {
		return writing
			? `EDITOR STILL BOOTING: the launch passed ${Math.round(LaunchTimeoutMs / 1000)}s, but its log is still being written (${writing}) - alive and slow (a cold DDC takes minutes), not dead. Do NOT kill it or launch a second one; wait and re-run this exact call.`
			: `EDITOR FAILED TO START: no answer after ${Math.round(LaunchTimeoutMs / 1000)}s and its log stopped (${Info?.log ?? 'no log'}). A frozen log means a modal window or a boot error (a broken module DLL after a bad build) - read the log; do not just retry.`;
	}
	return writing
		? `EDITOR STARTING: not ready within ${Math.round(CallWarmupMs / 1000)}s, log advancing (${writing}). Re-run this exact call; it waits for the ongoing boot.`
		: `EDITOR STARTING: not ready within ${Math.round(CallWarmupMs / 1000)}s. Re-run this exact call; if this repeats, read ${Info?.log ?? 'Saved/Logs/<project>.log'}.`;
}

async function relayToEditor(msg) {
	const { id } = msg;
	if (!(await ensureUpstreamWithin(CallWarmupMs))) {
		send(toolError(id, notReadyText()));
		return;
	}
	try {
		const timeoutMs = ToolCallTimeoutMs;
		const started = Date.now();
		let res;
		try {
			res = await upstreamRpc(msg, timeoutMs);
		} catch (e) {
			if (e.httpStatus && (await safeHandshake(5000))) {
				log(`upstream HTTP ${e.httpStatus}; re-handshake ok, replaying`);
				res = await upstreamRpc(msg, timeoutMs);
			} else throw e;
		}
		if (Date.now() - started > 10000) log(`slow call: ${msg.params?.name} took ${Math.round((Date.now() - started) / 1000)}s`);
		if (res) {
			liftToolsetImages(res);
			res.id = id;
			send(res);
		} else send(makeResult(id, {}));
	} catch (e) {
		const conn = connectionErrorCode(e);
		const what = `tool "${msg.params?.name}"`;
		if (conn) {
			markUpstreamDead(conn);
			send(toolError(id, `EDITOR DIED: the connection was lost while calling ${what} (${conn}). The next call reconnects (and relaunches a headless editor if none answers). A read: re-run it. A call that CHANGES content may have landed before the editor died - read the state back before re-running. If it repeats, read ${Info?.log ?? 'the editor log'}.`));
			return;
		}
		const cause = e?.cause?.code || e?.cause?.message;
		send(makeError(id, -32002, `Upstream MCP call failed for ${what}: ${e.message}${cause ? ` (${cause})` : ''}`));
	}
}

async function handleMessage(msg) {
	const { id, method } = msg;
	const isNotification = id === undefined || id === null;
	if (method === 'initialize') {
		if (msg.params?.protocolVersion) clientProtocol = msg.params.protocolVersion;
		send(makeResult(id, { protocolVersion: clientProtocol, capabilities: { tools: { listChanged: true } }, serverInfo: { name: ServerName, version: '1.0.0' } }));
		return;
	}
	if (method === 'notifications/initialized' || method === 'initialized') return;
	if (method === 'ping') {
		if (!isNotification) send(makeResult(id, {}));
		return;
	}
	if (method === 'tools/list') {
		if (cachedTools) send(makeResult(id, cachedTools));
		else {
			send(makeResult(id, { tools: [] }));
			void startConnect(); // tools arrive with tools/list_changed once the editor answers
		}
		return;
	}
	if (method !== 'tools/call') {
		// Only tools/call needs the editor; a probe (server/discover, resources/list...) never boots one.
		if (isNotification) {
			if (upstreamReady) upstreamPost(msg).catch((e) => log(`notification ${method} not relayed: ${e.message}`));
			return;
		}
		send(makeError(id, -32601, `Method not found: ${method} (the ${ServerName} bridge serves tools only)`));
		return;
	}
	const stop = reportProgress(msg);
	try {
		await relayToEditor(msg);
	} finally {
		stop();
	}
}

// --- main ---------------------------------------------------------------------------------------------------------

if (Prewarm) {
	const ok = await startConnect();
	if (ok) await refreshCache();
	log(ok ? 'prewarm complete (tool list cached; editor left running)' : `prewarm failed: ${launchRefused ?? 'the editor did not answer'}`);
	process.exit(ok ? 0 : 1);
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
	const t = line.trim();
	if (!t) return;
	let msg;
	try {
		msg = JSON.parse(t);
	} catch {
		log('dropped non-JSON line from the client');
		return;
	}
	handleMessage(msg).catch((e) => log('handler error:', e.message));
});
rl.on('close', () => {
	log('stdin closed; exiting (the editor, if any, stays up)');
	process.exit(0);
});
process.on('exit', () => {
	if (launchLockHeld) releaseLaunchLock();
});
log(`bridge started (lazy) -> ${UpstreamUrl}${Info ? ` [${Info.name}, ${Info.serverKind}]` : ' [no project]'}`);
