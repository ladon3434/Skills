// bridge-test.mjs — black-box characterization of bridge.mjs through its real stdio contract.
// Hermetic and offline: every case runs against a throwaway fixture project, a fake HTTP MCP "editor" on an
// ephemeral 127.0.0.1 port, a synthetic process table for ue-owner.mjs (UE_OWNER_FIXTURE) and a fake launch command
// (a .cmd that writes a marker). No real editor, no real MCP server, no live process table is touched.
//
//   node scripts/mcp-bridge/test/bridge-test.mjs

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const Bridge = join(dirname(dirname(fileURLToPath(import.meta.url))), 'bridge.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];
let cases = 0;
const ok = (cond, m) => {
	if (!cond) fails.push(m);
};

/**
 * A fixture project: Fake.uproject + optional restore data; a process table for ue-owner (`processes`, rows
 * {p,q,n,c,s}; null = the query fails); a fake launcher.
 */
function fixture({ restorePanel = false, processes = [] } = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'bridge-test-'));
	writeFileSync(join(dir, 'Fake.uproject'), JSON.stringify({ EngineAssociation: '5.8', Plugins: [{ Name: 'ModelContextProtocol', Enabled: true }, { Name: 'AllToolsets', Enabled: true }] }));
	if (restorePanel) {
		mkdirSync(join(dir, 'Saved', 'Autosaves'), { recursive: true });
		writeFileSync(join(dir, 'Saved', 'Autosaves', 'PackageRestoreData.json'), Buffer.from(JSON.stringify({ RestoreEnabled: true, Packages: [{ p: 1 }] }), 'utf16le'));
	}
	const tools = join(dir, 'tools');
	mkdirSync(tools);
	const owner = join(tools, 'processes.json');
	if (processes !== null) writeFileSync(owner, JSON.stringify({ processes: typeof processes === 'function' ? processes(dir) : processes }));
	writeFileSync(join(tools, 'launch.cmd'), `@echo off\r\necho launched> "%~dp0launched.txt"\r\n`);
	return {
		dir,
		owner,
		launch: join(tools, 'launch.cmd'),
		launched: () => existsSync(join(tools, 'launched.txt')),
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

async function closedPortUrl() {
	const port = await new Promise((res) => {
		const s = createNetServer();
		s.listen(0, '127.0.0.1', () => {
			const p = s.address().port;
			s.close(() => res(p));
		});
	});
	return `http://127.0.0.1:${port}/mcp`;
}

/** Run the bridge: write lines, gather stdout for waitMs, then kill (or let stdin close end it). */
async function runBridge({ fx, url, args = [], env = {}, lines = [], endStdin = false, endAfterMs = 0, waitMs = 1000, cache = null }) {
	const cacheDir = join(fx.dir, 'cache');
	mkdirSync(cacheDir, { recursive: true });
	if (cache) writeFileSync(join(cacheDir, 'unreal-mcp.tools.json'), JSON.stringify(cache));
	const fullEnv = {
		...process.env,
		UE_MCP_URL: url,
		MCP_BRIDGE_CACHE_DIR: cacheDir,
		UE_OWNER_FIXTURE: fx.owner,
		UE_MCP_LAUNCH: fx.launch,
		MCP_BRIDGE_WARMUP_SEC: '2',
		MCP_BRIDGE_LAUNCH_TIMEOUT_SEC: '3',
		...env,
	};
	delete fullEnv.UE_MCP_PORT;
	const child = spawn(process.execPath, [Bridge, '--project', fx.dir, ...args], { stdio: ['pipe', 'pipe', 'pipe'], env: fullEnv });
	let out = '';
	let err = '';
	child.stdout.on('data', (d) => (out += d));
	child.stderr.on('data', (d) => (err += d));
	const exited = new Promise((r) => child.on('exit', (c) => r(c)));
	for (const l of lines) child.stdin.write(l + '\n');
	if (endStdin) child.stdin.end();
	if (endAfterMs) setTimeout(() => child.stdin.end(), endAfterMs);
	let exit = null;
	const race = await Promise.race([exited.then((c) => ({ c })), sleep(waitMs).then(() => 'timeout')]);
	if (race === 'timeout') {
		child.kill();
		await exited;
	} else exit = race.c;
	const responses = out.split('\n').filter(Boolean).map((l) => {
		try {
			return JSON.parse(l);
		} catch {
			return { __raw: l };
		}
	});
	return { responses, stderr: err, exit, cacheFile: join(cacheDir, 'unreal-mcp.tools.json') };
}

/** A fake HTTP MCP editor. `staleOnce`: the first tools/call with a session answers 404 (an editor restart). */
function startFakeEditor({ onToolsCall = null, killOnToolsCall = false, delayMs = 0, staleOnce = false } = {}) {
	const calls = [];
	let staled = false;
	let session = 0;
	const server = createServer((req, res) => {
		let body = '';
		req.on('data', (c) => (body += c));
		req.on('end', () => {
			let msg = {};
			try {
				msg = JSON.parse(body);
			} catch {
				/* {} */
			}
			calls.push({ ...msg, sid: req.headers['mcp-session-id'] ?? null });
			const reply = (obj) => {
				res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': `fake-${session}` });
				res.end(JSON.stringify(obj));
			};
			if (msg.method === 'initialize') {
				session++;
				return reply({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params?.protocolVersion, capabilities: {}, serverInfo: { name: 'fake', version: '1' } } });
			}
			if (msg.id == null) {
				res.writeHead(202);
				return res.end();
			}
			if (msg.method === 'tools/list') return reply({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'FakeTool', description: 'x', inputSchema: { type: 'object' } }] } });
			if (msg.method === 'tools/call') {
				if (staleOnce && !staled) {
					staled = true;
					res.writeHead(404);
					return res.end();
				}
				if (killOnToolsCall) {
					res.destroy();
					req.destroy();
					return;
				}
				const result = onToolsCall ? onToolsCall(msg) : { content: [{ type: 'text', text: `called ${msg.params?.name}` }] };
				if (delayMs) return void setTimeout(() => !res.destroyed && reply({ jsonrpc: '2.0', id: msg.id, result }), delayMs);
				return reply({ jsonrpc: '2.0', id: msg.id, result });
			}
			return reply({ jsonrpc: '2.0', id: msg.id, result: {} });
		});
	});
	return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${server.address().port}/mcp`, calls, close: () => new Promise((c) => server.close(c)) })));
}

const INIT = (id = 1) => JSON.stringify({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
const call = (id, name, extra = {}) => JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {}, ...extra } });
const text = (r, id) => r.responses.find((m) => m.id === id)?.result?.content?.[0]?.text ?? '';

async function test(name, fn) {
	cases++;
	const fx = fixture(fn.fixture ?? {});
	try {
		await fn(fx);
	} catch (e) {
		fails.push(`${name}: threw ${e.stack}`);
	} finally {
		fx.cleanup();
	}
}

// --- local contract: answered without an editor ---------------------------------------------------------------------

await test('initialize', async (fx) => {
	const r = await runBridge({ fx, url: await closedPortUrl(), lines: [INIT()] });
	const init = r.responses.find((m) => m.id === 1);
	ok(init?.result?.protocolVersion === '2025-06-18', 'L-init: echoes the client protocolVersion');
	ok(init?.result?.capabilities?.tools?.listChanged === true, 'L-init: advertises tools.listChanged');
	ok(init?.result?.serverInfo?.name === 'unreal-mcp', 'L-init: names the server');
	ok(!fx.launched(), 'L-init: no launch');
});

await test('ping', async (fx) => {
	const r = await runBridge({ fx, url: await closedPortUrl(), lines: [INIT(), JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' })] });
	ok(JSON.stringify(r.responses.find((m) => m.id === 7)?.result) === '{}', 'L-ping: empty result');
	ok(!r.responses.some((m) => m.id == null && m.result), 'L-ping: notifications/initialized draws no response');
});

await test('cached list', async (fx) => {
	const r = await runBridge({ fx, url: await closedPortUrl(), cache: { tools: [{ name: 'Cached', inputSchema: { type: 'object' } }] }, lines: [INIT(), JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })] });
	const t = r.responses.find((m) => m.id === 2)?.result?.tools ?? [];
	ok(t.length === 1 && t[0].name === 'Cached', 'L-cache: tools/list serves the cache verbatim');
	ok(!fx.launched(), 'L-cache: a cached tools/list never launches the editor');
});

await test('seed list', async (fx) => {
	const r = await runBridge({ fx, url: await closedPortUrl(), lines: [INIT(), JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} })] });
	const names = (r.responses.find((m) => m.id === 3)?.result?.tools ?? []).map((t) => t.name).sort().join();
	ok(names === 'call_tool,describe_toolset,list_toolsets', `L-seed: no cache -> Epic's three meta-tools from the seed (${names})`);
	ok(/serving the seed/.test(r.stderr) && !fx.launched(), 'L-seed: says so, launches nothing');
});

await test('no seed', async (fx) => {
	const r = await runBridge({ fx, url: await closedPortUrl(), args: ['--seed', join(fx.dir, 'none.json'), '--launch', 'none'], lines: [INIT(), JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} })] });
	ok(Array.isArray(r.responses.find((m) => m.id === 3)?.result?.tools) && r.responses.find((m) => m.id === 3).result.tools.length === 0, 'L-noseed: an empty list at once');
});

await test('garbage line', async (fx) => {
	const r = await runBridge({ fx, url: await closedPortUrl(), lines: ['not json', INIT(9)] });
	ok(r.responses.some((m) => m.id === 9 && m.result) && /dropped non-JSON/.test(r.stderr), 'L-garbage: dropped, the next message answered');
});

await test('stdin close', async (fx) => {
	const r = await runBridge({ fx, url: await closedPortUrl(), lines: [INIT()], endStdin: true, waitMs: 5000 });
	ok(r.exit === 0 && /stdin closed/.test(r.stderr), `L-close: exits 0 (${r.exit})`);
});

await test('non-tool request', async (fx) => {
	const fake = await startFakeEditor();
	const r = await runBridge({ fx, url: fake.url, waitMs: 1500, lines: [JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'server/discover', params: {} }), JSON.stringify({ jsonrpc: '2.0', id: 12, method: 'resources/list', params: {} })] });
	await fake.close();
	ok(r.responses.find((m) => m.id === 11)?.error?.code === -32601 && r.responses.find((m) => m.id === 12)?.error?.code === -32601, 'L-probe: method-not-found');
	ok(fake.calls.length === 0 && !fx.launched(), 'L-probe: never touches or launches the editor');
});

// --- proxy contract -------------------------------------------------------------------------------------------------

await test('proxy', async (fx) => {
	const fake = await startFakeEditor();
	const r = await runBridge({ fx, url: fake.url, waitMs: 2500, lines: [INIT(), call(42, 'FakeTool')] });
	await fake.close();
	ok(text(r, 42) === 'called FakeTool', 'P-proxy: the upstream result under the client id');
	ok(fake.calls.some((c) => c.method === 'tools/call' && c.params?.name === 'FakeTool'), 'P-proxy: the editor received the call');
	ok(!fx.launched(), 'P-proxy: an editor that is up is used as is - no launch');
});

await test('list_changed', async (fx) => {
	const fake = await startFakeEditor();
	const r = await runBridge({ fx, url: fake.url, waitMs: 2500, lines: [INIT(), call(43, 'FakeTool')] });
	await fake.close();
	ok(r.responses.some((m) => m.method === 'notifications/tools/list_changed'), 'P-listchanged: the client is told the list changed');
	ok(existsSync(r.cacheFile) && JSON.parse(readFileSync(r.cacheFile, 'utf8')).tools[0].name === 'FakeTool', 'P-listchanged: the live list is cached');
	const again = await runBridge({ fx, url: await closedPortUrl(), lines: [INIT(), JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} })] });
	ok(again.responses.find((m) => m.id === 5)?.result?.tools?.[0]?.name === 'FakeTool', 'P-listchanged: the next session lists the cached tools with the editor down');
});

await test('image lift', async (fx) => {
	const b64 = 'A'.repeat(5000);
	const fake = await startFakeEditor({ onToolsCall: () => ({ content: [{ type: 'text', text: JSON.stringify({ shot: { mimeType: 'image/png', data: b64 }, labeledActors: ['Sun'] }) }] }) });
	const r = await runBridge({ fx, url: fake.url, waitMs: 2500, lines: [INIT(), call(44, 'call_tool')] });
	await fake.close();
	const content = r.responses.find((m) => m.id === 44)?.result?.content ?? [];
	ok(content.some((b) => b.type === 'image' && b.mimeType === 'image/png' && b.data === b64), 'P-image: base64 lifted to a native image block');
	ok(content.some((b) => b.type === 'text' && /lifted to a native MCP image block/.test(b.text) && /Sun/.test(b.text)), 'P-image: the text keeps a placeholder and the rest');
});

await test('editor dies', async (fx) => {
	const fake = await startFakeEditor({ killOnToolsCall: true });
	const r = await runBridge({ fx, url: fake.url, waitMs: 3000, lines: [INIT(), call(45, 'FakeTool')] });
	await fake.close();
	const res = r.responses.find((m) => m.id === 45)?.result;
	ok(res?.isError === true && /EDITOR DIED/.test(res?.content?.[0]?.text ?? ''), 'P-died: a tool error naming the recovery path');
});

await test('stale session', async (fx) => {
	const fake = await startFakeEditor({ staleOnce: true });
	const r = await runBridge({ fx, url: fake.url, waitMs: 2500, lines: [INIT(), call(46, 'FakeTool')] });
	await fake.close();
	ok(text(r, 46) === 'called FakeTool', `P-stale: a 404 (editor restarted) is re-handshaken and replayed\n${r.stderr}`);
	ok(fake.calls.filter((c) => c.method === 'initialize').length >= 2, 'P-stale: a second initialize happened');
});

await test('progress', async (fx) => {
	const fake = await startFakeEditor({ delayMs: 2500 });
	const r = await runBridge({ fx, url: fake.url, waitMs: 4500, env: { MCP_BRIDGE_PROGRESS_SEC: '1' }, lines: [INIT(), call(47, 'SlowTool', { _meta: { progressToken: 'tok' } }), call(48, 'SlowTool')] });
	await fake.close();
	const progress = r.responses.filter((m) => m.method === 'notifications/progress');
	ok(progress.length >= 1 && progress.every((p) => p.params.progressToken === 'tok'), 'P-progress: only the call with a token reports progress');
	ok(text(r, 47) === 'called SlowTool', 'P-progress: the slow call still returns');
});

await test('call timeout', async (fx) => {
	const fake = await startFakeEditor({ delayMs: 4000 });
	const r = await runBridge({ fx, url: fake.url, waitMs: 3500, env: { MCP_BRIDGE_CALL_TIMEOUT_SEC: '1' }, lines: [INIT(), call(49, 'HungTool')] });
	await fake.close();
	ok(/HungTool/.test(JSON.stringify(r.responses.find((m) => m.id === 49) ?? '')), 'P-timeout: a call past the budget fails naming the tool');
});

// --- lazy launch under the ownership rule ----------------------------------------------------------------------------

const ft = (ms) => (ms + 11644473600000) * 10000;
const editorRow = (pid, uproject, gui = true) => ({ p: pid, q: 1, n: gui ? 'UnrealEditor.exe' : 'UnrealEditor-Cmd.exe', c: `"C:\\UE\\UnrealEditor.exe" "${uproject}"`, s: ft(Date.now() - 60000) });

await test('launch when nothing runs', async (fx) => {
	const r = await runBridge({ fx, url: await closedPortUrl(), waitMs: 6000, lines: [INIT(), call(50, 'FakeTool')] });
	ok(fx.launched(), `O-launch: the editor down, nothing else running -> the launch command ran\n${r.stderr}`);
	ok(/EDITOR (STARTING|FAILED|STILL)/.test(text(r, 50)), `O-launch: the call says the editor is starting (${text(r, 50)})`);
});

async function refusedWith(name, opts, id, re, label) {
	cases++;
	const fx = fixture(opts);
	try {
		const r = await runBridge({ fx, url: await closedPortUrl(), waitMs: 4000, lines: [INIT(), call(id, 'FakeTool')] });
		ok(!fx.launched() && re.test(text(r, id)), `${label} (${text(r, id)})\n${r.stderr}`);
	} catch (e) {
		fails.push(`${name}: threw ${e.stack}`);
	} finally {
		fx.cleanup();
	}
}

await refusedWith('person editor elsewhere', { processes: [editorRow(500, 'C:\\Other\\Other.uproject')] }, 51,
	/EDITOR NOT STARTED: .*GUI editor pid 500 of Other .*a person's.*wait/s, 'O-elsewhere: a person\'s editor of another project -> no launch, wait');
await refusedWith('person editor here', { processes: (dir) => [editorRow(501, join(dir, 'Fake.uproject'))] }, 52,
	/EDITOR NOT STARTED: .*pid 501 of bridge-test-.*a person's.*second editor of the same project/s, 'O-here: a person\'s editor of this project -> no second editor');
await refusedWith('query failed', { processes: null }, 53,
	/EDITOR NOT STARTED: the process query failed/, 'O-noquery: no process table -> never launches blind');
await refusedWith('restore panel', { restorePanel: true }, 57,
	/EDITOR NOT STARTED: RESTORE PANEL/, 'O-restore: pending restore data blocks the launch');

await test('launch none', async (fx) => {
	const r = await runBridge({ fx, url: await closedPortUrl(), args: ['--launch', 'none'], waitMs: 4000, lines: [INIT(), call(54, 'FakeTool')] });
	ok(!fx.launched() && /--launch none/.test(text(r, 54)), 'O-none: never launches');
});

{
	cases++;
	const fx = fixture();
	try {
		const r = await runBridge({ fx, url: await closedPortUrl(), waitMs: 9000, lines: [INIT(), call(58, 'FakeTool')], endAfterMs: 3000 });
		ok(r.exit === 0, `O-exit: the session ends (stdin closes) -> clean exit (${r.exit})`);
	} finally {
		fx.cleanup();
	}
}

if (fails.length) {
	console.log(`bridge-test FAILED (${fails.length} of the checks, ${cases} cases):\n  ${fails.join('\n  ')}`);
	process.exit(1);
}
console.log(`bridge-test: ok (${cases} cases)`);
