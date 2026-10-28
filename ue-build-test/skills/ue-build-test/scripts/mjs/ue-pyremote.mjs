// ue-pyremote.mjs — Python with `import unreal` inside a running Unreal Editor, through Epic's own Python Remote
// Execution (PythonScriptPlugin). No third-party editor plugin: the protocol is the engine's
// (Engine/Plugins/Experimental/PythonScriptPlugin/Source/PythonScriptPlugin/Private/PythonScriptRemoteExecution.cpp,
// client: .../Content/Python/remote_execution.py).
//
// MASTER COPY: ue-workstation/skills/ue-workstation/scripts/mjs/ue-pyremote.mjs (with the other shared modules).
// Identical copies live in unreal-editor (ue.py runs python with it) and ue-build-test (ue-stop-editor asks dirty
// packages and quits a detached editor with it); `--selftest` of every copy checks the siblings, and so does
// scripts/repo-check.mjs.
//
// The protocol: UDP multicast (default group 239.0.0.1:6766, bound to 127.0.0.1, TTL 0 — this machine only) finds the
// editors ("ping" -> "pong" with user, machine, engine_root, project_root, project_name); "open_connection" asks one
// editor to connect back to a TCP port this script listens on; "command" runs the code there, "command_result" carries
// success, result and the log output. The editor polls on its core ticker, so a modal dialog stops it like every MCP call.
//
// Remote Execution is OFF by default (`bRemoteExecution` in [/Script/PythonScriptPlugin.PythonScriptPluginSettings],
// config=Engine). An editor started by ue-launch-editor or the lazy bridge gets it from the command-line switch
// `LaunchSwitch` below, so no project file changes. A person's editor: Project Settings -> Plugins -> Python ->
// "Enable Remote Execution?" (takes effect at once, writes Config/DefaultEngine.ini), or the same key in
// Saved/Config/WindowsEditor/Engine.ini (per machine, read at the next start).
//
// Which editor: only one whose project_root is this project's. Whose editor: before any code, a read-only probe asks
// the editor for its pid (os.getpid()), and ue-owner's state of that pid decides — python goes only into an editor this
// session started, unless the person allowed it (--allow-foreign). Remote Execution saves nothing by itself, but the
// code runs in the person's open session, on their unsaved work, with no undo.
//
// The code is sent as a path to a temporary .py file, not as text: the editor reads one TCP message per read and
// treats a ".py" substring in literal code as a file name, and a file avoids both.
//
// CLI (exit 0 = the code ran without an uncaught exception, 1 = it raised, 2 = refused / no editor / protocol error):
//   node ue-pyremote.mjs [--project DIR] [--allow-foreign] [--timeout S] [--raw] [--out FILE] < code
//   node ue-pyremote.mjs --list [--project DIR]        the editors that answer, and which is this project's
//   node ue-pyremote.mjs --selftest                    offline: a fake editor node on a private multicast port
// Env: UE_PY_REMOTE_ENDPOINT=<group>:<port>, UE_PY_REMOTE_BIND=<ip> override the project's settings (tests use them).

import dgram from 'node:dgram';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeEditor, editors, findProjectRoot, sameProject, snapshot, whoAmI } from './ue-owner.mjs';

export const RemoteExecSection = '/Script/PythonScriptPlugin.PythonScriptPluginSettings';
export const LaunchSwitch = `-ini:Engine:[${RemoteExecSection}]:bRemoteExecution=True`;
const ProtocolVersion = 1;
const Magic = 'ue_py';
const Defaults = { group: '239.0.0.1', port: 6766, bind: '127.0.0.1', ttl: 0 };
const PidProbe = "import os\nprint('UE_PY_REMOTE_PID=%d' % os.getpid())";

export class RemoteError extends Error {}

// --- settings -------------------------------------------------------------------------------------------------------

function iniValue(text, section, key) {
	let inSection = false;
	let value;
	for (const raw of String(text).split(/\r?\n/)) {
		const line = raw.trim();
		if (line.startsWith('[')) { inSection = line === `[${section}]`; continue; }
		if (!inSection) continue;
		const m = line.match(/^[+]?([^=;]+?)\s*=\s*(.*)$/);
		if (m && m[1] === key) value = m[2].replace(/^"|"$/g, '');
	}
	return value;
}

/** The project's Remote Execution settings: Saved (per machine) over Config/Default, then the engine defaults. */
export function remoteSettings(projectDir, env = process.env) {
	const files = projectDir ? [join(projectDir, 'Saved', 'Config', 'WindowsEditor', 'Engine.ini'), join(projectDir, 'Config', 'DefaultEngine.ini')] : [];
	const texts = files.map((f) => { try { return readFileSync(f, 'utf8'); } catch { return null; } }).filter((t) => t !== null);
	const get = (key) => { for (const t of texts) { const v = iniValue(t, RemoteExecSection, key); if (v !== undefined && v !== '') return v; } return undefined; };
	const out = { ...Defaults, enabled: get('bRemoteExecution') };
	const endpoint = env.UE_PY_REMOTE_ENDPOINT || get('RemoteExecutionMulticastGroupEndpoint');
	if (endpoint && /^[\d.]+:\d+$/.test(endpoint)) { const [g, p] = endpoint.split(':'); out.group = g; out.port = Number(p); }
	const bind = env.UE_PY_REMOTE_BIND || get('RemoteExecutionMulticastBindAddress');
	if (bind && /^[\d.]+$/.test(bind)) out.bind = bind;
	const ttl = Number(get('RemoteExecutionMulticastTtl'));
	if (Number.isInteger(ttl) && ttl >= 0) out.ttl = ttl;
	return out;
}

// --- protocol -------------------------------------------------------------------------------------------------------

const encode = (type, source, dest, data) => Buffer.from(JSON.stringify({ version: ProtocolVersion, magic: Magic, type, source, ...(dest ? { dest } : {}), ...(data ? { data } : {}) }), 'utf8');

function decode(buf, me) {
	try {
		const m = JSON.parse(buf.toString('utf8'));
		if (m.version !== ProtocolVersion || m.magic !== Magic) return null;
		if (m.source === me || (m.dest && m.dest !== me)) return null;
		return m;
	} catch {
		return null;
	}
}

/** A discovery session: the UDP socket stays open for open_connection / close_connection. */
export async function openSession(settings = Defaults) {
	const id = randomUUID();
	const nodes = new Map();
	const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
	await new Promise((ok, fail) => {
		sock.once('error', fail);
		sock.bind(settings.port, settings.bind, () => {
			sock.off('error', fail);
			try {
				sock.setMulticastLoopback(true);
				sock.setMulticastTTL(settings.ttl);
				sock.setMulticastInterface(settings.bind);
				sock.addMembership(settings.group, settings.bind);
				ok();
			} catch (e) {
				fail(e);
			}
		});
	}).catch((e) => { sock.close(); throw new RemoteError(`cannot join the Remote Execution group ${settings.group}:${settings.port} on ${settings.bind} (${e.message})`); });
	sock.on('error', () => {});
	sock.on('message', (buf) => {
		const m = decode(buf, id);
		if (m?.type === 'pong' && m.data) nodes.set(m.source, { node_id: m.source, ...m.data, seen: Date.now() });
	});
	const send = (type, dest, data) => new Promise((ok) => sock.send(encode(type, id, dest, data), settings.port, settings.group, () => ok()));
	const ping = setInterval(() => send('ping'), 1000);
	await send('ping');
	return {
		id,
		send,
		nodes: () => [...nodes.values()].filter((n) => Date.now() - n.seen < 5000),
		close: () => { clearInterval(ping); try { sock.close(); } catch { /* closed */ } },
	};
}

/** Discovery for `waitMs`; stops early once a node of `projectDir` (or any node, without a project) answered. */
export async function waitForNodes(session, { waitMs = 3000, projectDir = null } = {}) {
	const end = Date.now() + waitMs;
	const match = (n) => (projectDir ? sameProject(n.project_root, projectDir) : true);
	while (Date.now() < end) {
		if (session.nodes().some(match)) await new Promise((r) => setTimeout(r, 300)); // let a second editor answer too
		if (session.nodes().some(match)) break;
		await new Promise((r) => setTimeout(r, 100));
	}
	return session.nodes();
}

/** Opens the TCP command channel with one node: {run(command, execMode), close()}. */
export async function connect(session, node, { acceptMs = 30000 } = {}) {
	const server = net.createServer();
	await new Promise((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok); });
	const port = server.address().port;
	const accepted = new Promise((ok) => server.once('connection', ok));
	let socket = null;
	const deadline = Date.now() + acceptMs;
	while (!socket && Date.now() < deadline) {
		await session.send('open_connection', node.node_id, { command_ip: '127.0.0.1', command_port: port });
		socket = await Promise.race([accepted, new Promise((r) => setTimeout(() => r(null), 5000))]);
	}
	if (!socket) { server.close(); throw new RemoteError(`the editor (${node.project_name ?? node.node_id}) did not connect back within ${acceptMs / 1000}s - is it stuck in a modal dialog?`); }
	server.close();
	socket.on('error', () => {});
	const run = (command, { execMode = 'ExecuteFile', unattended = true, timeoutMs = 300000 } = {}) =>
		new Promise((ok, fail) => {
			let buf = Buffer.alloc(0);
			const timer = setTimeout(() => { cleanup(); fail(new RemoteError(`no result within ${timeoutMs / 1000}s - the code still runs in the editor, or a modal dialog stopped it`)); }, timeoutMs);
			const onData = (chunk) => {
				buf = Buffer.concat([buf, chunk]);
				const m = decode(buf, session.id);
				if (m?.type === 'command_result') { cleanup(); ok(m.data ?? {}); }
			};
			const onClose = () => { cleanup(); fail(new RemoteError('the editor closed the command connection before answering (it quit or crashed?)')); };
			const cleanup = () => { clearTimeout(timer); socket.off('data', onData); socket.off('close', onClose); };
			socket.on('data', onData);
			socket.on('close', onClose);
			socket.write(encode('command', session.id, node.node_id, { command, unattended, exec_mode: execMode }));
		});
	const close = async () => {
		await session.send('close_connection', node.node_id).catch(() => {});
		socket.destroy();
	};
	return { run, close };
}

/** The log lines the code printed (each entry is one line, with or without its newline). */
export const outputText = (data) => (Array.isArray(data?.output) ? data.output.map((o) => String(o?.output ?? '').replace(/\r?\n$/, '')).join('\n') : '');

// --- the whole call -------------------------------------------------------------------------------------------------

/**
 * Runs `code` in this project's editor. `allow(pid)` -> {ok, reason} decides after the pid probe; `pid` restricts the
 * call to that very editor. Resolves {node, pid, data}; throws RemoteError with a reason a person can act on.
 */
export async function runPython(code, { projectDir, pid = null, allow = () => ({ ok: true }), timeoutMs = 300000, waitMs = 3000, env = process.env } = {}) {
	const settings = remoteSettings(projectDir, env);
	const session = await openSession(settings);
	try {
		const all = await waitForNodes(session, { waitMs, projectDir });
		const mine = projectDir ? all.filter((n) => sameProject(n.project_root, projectDir)) : all;
		if (!mine.length) {
			const others = all.map((n) => `${n.project_name ?? '?'} (${n.project_root ?? 'no project'})`).join(', ');
			throw new RemoteError(all.length
				? `no editor of this project answers Python Remote Execution; only: ${others}`
				: `no editor answers Python Remote Execution on ${settings.group}:${settings.port} via ${settings.bind} - the editor is not running, or Remote Execution is off in it (an editor started by ue-launch-editor or the bridge has it on; a person's editor: Project Settings -> Plugins -> Python -> Enable Remote Execution)`);
		}
		const tried = [];
		for (const node of mine) {
			const ch = await connect(session, node);
			try {
				const probe = await ch.run(PidProbe, { timeoutMs: 60000 });
				const got = Number(outputText(probe).match(/UE_PY_REMOTE_PID=(\d+)/)?.[1]);
				if (!got) throw new RemoteError(`the editor did not report its pid: ${JSON.stringify(probe).slice(0, 300)}`);
				if (pid && got !== Number(pid)) { tried.push(got); continue; }
				const v = allow(got);
				if (!v.ok) throw new RemoteError(v.reason);
				const dir = join(tmpdir(), 'ue-pyremote');
				mkdirSync(dir, { recursive: true });
				const file = join(dir, `run-${session.id}.py`);
				writeFileSync(file, code, 'utf8');
				try {
					const data = await ch.run(`"${file}"`, { timeoutMs });
					return { node, pid: got, data };
				} finally {
					rmSync(file, { force: true });
				}
			} finally {
				await ch.close();
			}
		}
		throw new RemoteError(`editor pid ${pid} does not answer Python Remote Execution (this project's editors that do: pid ${tried.join(', ')})`);
	} finally {
		session.close();
	}
}

/** ue-owner's verdict for python into the editor `pid`. */
export function pythonAllowed(pid, { allowForeign = false, env = process.env } = {}) {
	if (allowForeign) return { ok: true };
	const snap = snapshot(env);
	if (!snap) return { ok: false, reason: 'the process query failed - cannot tell whose editor this is; nothing was run' };
	const e = editors(snap, whoAmI(snap)).find((x) => x.pid === Number(pid));
	if (e?.state === 'mine') return { ok: true };
	return {
		ok: false,
		reason: `${e ? describeEditor(e) : `editor pid ${pid} (not in the process table)`}. Python runs inside that open session - on the person's unsaved work, with no undo. Ask the person first; with their OK pass --allow-foreign. Toolset calls (ue.py --call) need no OK.`,
	};
}

// --- CLI ------------------------------------------------------------------------------------------------------------

const ascii = (s) => String(s).replace(/[^\x09\x0a\x0d\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

async function readStdin() {
	const chunks = [];
	for await (const c of process.stdin) chunks.push(c);
	return Buffer.concat(chunks).toString('utf8');
}

async function cli(argv) {
	const opt = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
	const flag = (f) => argv.includes(f);
	if (flag('-h') || flag('--help')) {
		console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//   node')).map((l) => l.slice(3)).join('\n'));
		return 0;
	}
	if (flag('--selftest')) {
		const { n, fails } = await selftest();
		for (const f of fails) console.log(`  FAIL ${f}`);
		console.log(fails.length ? `ue-pyremote selftest: ${fails.length} of ${n} failed` : `ue-pyremote selftest: ok (${n} checks)`);
		return fails.length ? 1 : 0;
	}
	const projectDir = opt('--project') ? resolve(opt('--project')) : findProjectRoot();
	const out = opt('--out');
	const say = (s, limit = 8000) => {
		if (out) { writeFileSync(out, `${s}\n`, { encoding: 'utf8', flag: 'a' }); return; }
		const t = s.length <= limit ? s : `${s.slice(0, limit)}\n... (${s.length - limit} more chars; --out FILE keeps all of it)`;
		console.log(ascii(t));
	};
	if (out) writeFileSync(out, '', 'utf8');
	if (flag('--list')) {
		const session = await openSession(remoteSettings(projectDir));
		try {
			const nodes = await waitForNodes(session, { waitMs: Number(opt('--timeout') ?? 3) * 1000 });
			if (!nodes.length) console.log('no editor answers Python Remote Execution');
			for (const n of nodes) console.log(`${n.project_name ?? '?'}  ${n.project_root ?? '(no project)'}  ${n.engine_version ?? ''}${sameProject(n.project_root, projectDir) ? '  <- this project' : ''}`);
			return 0;
		} finally {
			session.close();
		}
	}
	const code = await readStdin();
	try {
		const { pid, data } = await runPython(code, {
			projectDir,
			timeoutMs: Number(opt('--timeout') ?? 300) * 1000,
			allow: (p) => pythonAllowed(p, { allowForeign: flag('--allow-foreign') }),
		});
		if (flag('--raw')) { say(JSON.stringify({ pid, ...data }, null, 1), 1e9); return data.success ? 0 : 1; }
		say(`success: ${data.success ? 'True' : 'False'}  (editor pid ${pid})`);
		const text = outputText(data);
		if (text) say(text);
		// On an exception `result` repeats the traceback that is already in the output.
		if (data.success && data.result && data.result !== 'None') say(`result: ${data.result}`, 2000);
		if (!data.success && !text && data.result) say(data.result, 4000);
		return data.success ? 0 : 1;
	} catch (e) {
		if (!(e instanceof RemoteError)) throw e;
		say(`ERROR: ${e.message}`);
		return 2;
	}
}

// --- self-test ------------------------------------------------------------------------------------------------------

/** A fake editor node for tests: answers pings, connects back, answers the pid probe, "runs" a file by its length. */
export async function fakeEditor(settings, { projectRoot, pid }) {
	const id = randomUUID();
	const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
	await new Promise((ok) => sock.bind(settings.port, settings.bind, ok));
	sock.setMulticastLoopback(true);
	sock.setMulticastInterface(settings.bind);
	sock.addMembership(settings.group, settings.bind);
	const conns = [];
	sock.on('message', (buf) => {
		const m = decode(buf, id);
		if (!m) return;
		if (m.type === 'ping') sock.send(encode('pong', id, m.source, { user: 'u', machine: 'm', engine_version: '5.8.3', engine_root: 'C:/UE/Engine/', project_root: `${projectRoot.replace(/\\/g, '/')}/`, project_name: 'Proj' }), settings.port, settings.group);
		if (m.type === 'open_connection' && m.dest === id) {
			const c = net.connect(m.data.command_port, m.data.command_ip);
			conns.push(c);
			c.on('error', () => {});
			c.on('data', (b) => {
				const cmd = decode(b, id);
				if (cmd?.type !== 'command') return;
				const text = cmd.data.command;
				let output;
				let success = true;
				if (text.includes('os.getpid()')) output = `UE_PY_REMOTE_PID=${pid}\n`;
				else {
					const file = text.replace(/^"|"$/g, '');
					const body = existsSync(file) ? readFileSync(file, 'utf8') : `<no file ${file}>`;
					success = !body.includes('raise');
					output = `ran ${body.length} chars \u0436\n`;
				}
				c.write(encode('command_result', id, cmd.source, { success, command: text, result: 'None', output: [{ type: 'Info', output }] }));
			});
		}
	});
	return { close: () => { sock.close(); for (const c of conns) c.destroy(); } };
}

/** Offline checks against a fake node on a private multicast port: {n, fails}. */
export async function selftest() {
	const fails = [];
	let n = 0;
	const ok = (c, m) => { n++; if (!c) fails.push(m); };
	const settings = { ...Defaults, port: 16766 + (process.pid % 500) };
	const env = { ...process.env, UE_PY_REMOTE_ENDPOINT: `${settings.group}:${settings.port}` };
	const root = join(tmpdir(), `ue-pyremote-selftest-${process.pid}`);
	const A = join(root, 'ProjA');
	const B = join(root, 'ProjB');
	for (const d of [A, B]) mkdirSync(d, { recursive: true });
	ok(iniValue(`[${RemoteExecSection}]\nbRemoteExecution=True\n[Other]\nbRemoteExecution=False`, RemoteExecSection, 'bRemoteExecution') === 'True', 'ini: the key is read from its own section only');
	ok(remoteSettings(A, env).port === settings.port, 'settings: UE_PY_REMOTE_ENDPOINT overrides the port');
	const fa = await fakeEditor(settings, { projectRoot: A, pid: 4242 });
	try {
		let r = await runPython('print(1)\n', { projectDir: A, env, waitMs: 3000 });
		ok(r.pid === 4242 && r.data.success === true && /ran 9 chars/.test(outputText(r.data)), `run: ${JSON.stringify(r.data)}`);
		r = await runPython('raise X\n', { projectDir: A, env });
		ok(r.data.success === false, 'an uncaught exception comes back as success:false');
		let err = await runPython('print(1)', { projectDir: B, env }).catch((e) => e);
		ok(err instanceof RemoteError && /only: Proj/.test(err.message), `another project's editor is not used: ${err?.message}`);
		err = await runPython('print(1)', { projectDir: A, env, allow: () => ({ ok: false, reason: 'not yours' }) }).catch((e) => e);
		ok(err instanceof RemoteError && err.message === 'not yours', `the ownership verdict stops the code: ${err?.message}`);
		err = await runPython('print(1)', { projectDir: A, env, pid: 1 }).catch((e) => e);
		ok(err instanceof RemoteError && /pid 1 does not answer/.test(err.message), `--pid picks that very editor: ${err?.message}`);
		const tmp = join(tmpdir(), 'ue-pyremote');
		ok(!existsSync(tmp) || !readdirSync(tmp).some((f) => f.startsWith('run-')), 'the temporary code files are removed');
	} finally {
		fa.close();
	}
	const err = await runPython('print(1)', { projectDir: A, env, waitMs: 800 }).catch((e) => e);
	ok(err instanceof RemoteError && /no editor answers/.test(err.message), `no editor -> the reason names Remote Execution: ${err?.message}`);
	rmSync(root, { recursive: true, force: true });

	const here = fileURLToPath(import.meta.url);
	const repo = resolve(dirname(here), '..', '..', '..', '..', '..'); // <plugin>/skills/<skill>/scripts/mjs
	const mineText = readFileSync(here, 'utf8');
	for (const s of ['ue-workstation', 'unreal-editor', 'ue-build-test']) {
		const p = join(repo, s, 'skills', s, 'scripts', 'mjs', 'ue-pyremote.mjs');
		n++;
		if (existsSync(p) && readFileSync(p, 'utf8') !== mineText) fails.push(`${s}/skills/${s}/scripts/mjs/ue-pyremote.mjs differs from this copy - copy the master (ue-workstation) over it`);
	}
	return { n, fails };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
	cli(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.log(`ERROR: ${e?.stack ?? e}`); process.exit(2); });
}
