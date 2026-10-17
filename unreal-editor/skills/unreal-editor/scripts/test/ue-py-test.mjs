// ue-py-test.mjs — offline check of ue.py / raw.py against fake MCP servers (one VibeUE-like, one Epic-like).
// Covers: handshake + session file in UE_MCP_STATE_DIR (not the skill folder), a stale session renewed once,
// execute_python_code result parsing, call_tool, --tools server-kind detection, the Epic-only error text, and the
// port-owner check (a synthetic process table via UE_OWNER_FIXTURE: another project's editor on the port -> refused).
//
//   node scripts/test/ue-py-test.mjs

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const Scripts = dirname(dirname(fileURLToPath(import.meta.url)));
const py = ['python', 'python3', 'py'].find((p) => spawnSync(p, ['--version']).status === 0);
if (!py) {
	console.log('ue-py-test: SKIPPED (no python)');
	process.exit(0);
}

function fake(kind) {
	let session = 0;
	let staleNext = false;
	const server = createServer((req, res) => {
		let body = '';
		req.on('data', (c) => (body += c));
		req.on('end', () => {
			const msg = JSON.parse(body || '{}');
			const sid = req.headers['mcp-session-id'];
			const reply = (o, sse = false) => {
				res.writeHead(200, { 'content-type': sse ? 'text/event-stream' : 'application/json', 'mcp-session-id': `s${session}` });
				res.end(sse ? `event: message\ndata: ${JSON.stringify(o)}\n\n` : JSON.stringify(o));
			};
			if (msg.method === 'initialize') {
				session++;
				return reply({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: kind } } });
			}
			if (msg.id == null) {
				res.writeHead(202);
				return res.end();
			}
			if (sid !== `s${session}` || staleNext) {
				staleNext = false;
				res.writeHead(404);
				return res.end();
			}
			if (msg.method === 'tools/list') {
				const tools = kind === 'vibeue' ? ['execute_python_code', 'list_toolsets', 'describe_toolset', 'call_tool'] : ['list_toolsets', 'describe_toolset', 'call_tool'];
				return reply({ jsonrpc: '2.0', id: msg.id, result: { tools: tools.map((name) => ({ name, inputSchema: { type: 'object' } })) } });
			}
			const p = msg.params ?? {};
			if (p.name === 'execute_python_code') {
				if (kind !== 'vibeue') return reply({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'Tool not found: execute_python_code' } });
				const out = JSON.stringify({ success: true, output: `ran ${p.arguments.code.length} chars \u0436`, error: '' });
				return reply({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: out }] } }, true);
			}
			if (p.name === 'call_tool') {
				return reply({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify({ returnValue: `${p.arguments.toolset_name}/${p.arguments.tool_name}/${JSON.stringify(p.arguments.arguments)}` }) }] } });
			}
			return reply({ jsonrpc: '2.0', id: msg.id, result: {} });
		});
	});
	return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${server.address().port}/mcp`, close: () => server.close(), stale: () => (staleNext = true) })));
}

const fails = [];
const ok = (c, m) => c || fails.push(m);
const state = mkdtempSync(join(tmpdir(), 'ue-py-test-'));
const proj = join(state, 'Proj');
mkdirSync(proj);
writeFileSync(join(proj, 'Proj.uproject'), '{}');
const ownerFile = join(state, 'owner.json');
const setOwner = (listeners, processes = []) => writeFileSync(ownerFile, JSON.stringify({ processes, listeners }));
const editorRow = (pid, uproject) => ({ p: pid, q: 1, n: 'UnrealEditor.exe', c: `"C:/UE/UnrealEditor.exe" "${uproject}"`, s: (Date.now() + 11644473600000) * 10000 });
setOwner({});
// Async: the fake servers live in this process, so a blocking spawnSync would starve them.
const run = (script, args, url, input = '', extraEnv = {}) =>
	new Promise((res) => {
		const env = { ...process.env, UE_MCP_URL: url, UE_MCP_STATE_DIR: state, UE_OWNER_FIXTURE: ownerFile, ...extraEnv };
		delete env.PYTHONDONTWRITEBYTECODE;
		const c = spawn(py, [join(Scripts, script), ...args], { env });
		let stdout = '';
		let stderr = '';
		c.stdout.on('data', (d) => (stdout += d));
		c.stderr.on('data', (d) => (stderr += d));
		c.on('close', (status) => res({ status, stdout, stderr }));
		c.stdin.end(input);
	});

const v = await fake('vibeue');
const e = await fake('epic');
try {
	let r = await run('ue.py', ['--init'], v.url);
	ok(r.status === 0 && /session: s1/.test(r.stdout), `init: ${r.stdout}${r.stderr}`);
	ok(readdirSync(state).some((f) => /^sid-\d+\.txt$/.test(f)), 'init: the session id is in the state dir');
	r = await run('ue.py', [], v.url, 'import unreal\nprint(1)\n');
	ok(r.status === 0 && /success: True/.test(r.stdout) && /ran 23 chars \\u0436/.test(r.stdout), `python: ${r.stdout}${r.stderr}`);
	v.stale();
	r = await run('ue.py', [], v.url, 'import unreal');
	ok(r.status === 0 && /success: True/.test(r.stdout), `stale session renewed: ${r.stdout}${r.stderr}`);
	r = await run('ue.py', ['--tools'], v.url);
	ok(/vibeue: execute_python_code/.test(r.stdout), `tools vibeue: ${r.stdout}`);
	r = await run('ue.py', ['--tools'], e.url);
	ok(/epic \(tool search\)/.test(r.stdout), `tools epic: ${r.stdout}`);
	r = await run('ue.py', [], e.url, 'import unreal');
	ok(r.status === 1 && /stock unreal-mcp, not VibeUE/.test(r.stdout), `epic python refused with the branch hint: ${r.stdout}`);
	r = await run('ue.py', ['--call', 'EditorToolset.EditorAppToolset', 'IsPIERunning', '{"a":1}'], e.url);
	ok(r.status === 0 && /EditorToolset.EditorAppToolset\/IsPIERunning\/\{\\?"a\\?":1\}/.test(r.stdout), `call_tool: ${r.stdout}${r.stderr}`);
	r = await run('raw.py', [], v.url, 'x');
	ok(r.status === 0 && /"jsonrpc": "2.0"/.test(r.stdout), `raw: ${r.stdout}${r.stderr}`);
	r = await run('ue.py', [], 'http://127.0.0.1:9/mcp', 'x');
	ok(r.status === 2 && /no MCP server at/.test(r.stdout), `down: ${r.stdout}`);
	ok(!existsSync(join(Scripts, '__pycache__')), 'no __pycache__ next to the scripts');
	for (const s of ['ue.py', 'raw.py']) ok((await run(s, ['--help'], v.url)).status === 0, `${s} --help`);
	const vport = new URL(v.url).port;
	setOwner({ [vport]: 777 }, [editorRow(777, 'C:/Other/Other.uproject')]);
	r = await run('ue.py', ['--project', proj], v.url, 'print(1)');
	ok(r.status === 2 && /ANOTHER project \(Other/.test(r.stdout), `another project's editor on the port -> refused, nothing sent: ${r.stdout}${r.stderr}`);
	r = await run('raw.py', ['--project', proj], v.url, 'print(1)');
	ok(r.status === 2 && /ANOTHER project/.test(r.stdout), `raw.py refuses the same: ${r.stdout}`);
	setOwner({ [vport]: 778 }, [editorRow(778, join(proj, 'Proj.uproject'))]);
	r = await run('ue.py', ['--project', proj], v.url, 'print(1)');
	ok(r.status === 2 && /saves EVERY dirty package/.test(r.stdout), `python into a person's editor of this project -> refused without an OK: ${r.stdout}${r.stderr}`);
	r = await run('ue.py', ['--project', proj, '--allow-foreign'], v.url, 'print(1)');
	ok(r.status === 0 && /success: True/.test(r.stdout), `--allow-foreign after the person's OK -> allowed: ${r.stdout}${r.stderr}`);
	r = await run('ue.py', ['--project', proj, '--call', 'T', 'x', '{}'], v.url);
	ok(!/saves EVERY dirty package/.test(r.stdout), `a toolset call needs no OK: ${r.stdout}`);
	setOwner({});
} finally {
	v.close();
	e.close();
	rmSync(state, { recursive: true, force: true });
}
if (fails.length) {
	console.log(`ue-py-test FAILED:\n  ${fails.join('\n  ')}`);
	process.exit(1);
}
console.log('ue-py-test: ok');
