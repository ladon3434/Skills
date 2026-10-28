// dump-toolset-schemas.mjs — keep the Epic toolset schema snapshots (references/toolsets/) in step with the engine.
//
// Why: one describe_toolset answer is tens of KB, and Epic's toolset schemas change only with the engine, so an agent
// reads the dated snapshot (`jq` one signature) instead of describing toolsets live every session.
// The snapshot set is EPIC-ONLY: a toolset a project or a third-party plugin registers into Epic's registry shows up in
// list_toolsets too, and it is dropped here (it does not exist in another project).
//
//   node dump-toolset-schemas.mjs [--url URL] [--project DIR] [--out DIR] [--exclude REGEX]   live: needs a WARM editor
//   node dump-toolset-schemas.mjs --from SRCDIR [--project DIR] [--out DIR] [--exclude REGEX] offline: re-filter a set
//   node dump-toolset-schemas.mjs --check [DIR] [--project DIR] [--exclude REGEX]             offline: assert the set
//   node dump-toolset-schemas.mjs --selftest
//
// A toolset is project/third-party when its first name segment (the C++ module or python package that registers it,
// e.g. `EditorToolset` in `EditorToolset.EditorAppToolset`) is a module (`<seg>.Build.cs`) or a python package
// (`Content/Python/<seg>`) inside the project's Source/ or Plugins/. --exclude drops more by name.
// The live run is serial on the editor's game thread (~50 describes, minutes). Only needed after an engine update.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findProjectUproject, resolveEngine } from './ue-engine.mjs';
import { projectInfo } from './ue-project.mjs';

const SkillDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DefaultOut = join(SkillDir, 'references', 'toolsets');

// --- which toolsets belong to the project ---------------------------------------------------------------------

/** Module names (`X.Build.cs`) and python packages (`Content/Python/X`) the project itself ships. */
export function projectModuleNames(root) {
	const names = new Set();
	const walk = (dir, depth) => {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (e.isFile() && e.name.endsWith('.Build.cs')) names.add(e.name.slice(0, -'.Build.cs'.length).toLowerCase());
			if (!e.isDirectory() || /^(Binaries|Intermediate|Saved|DerivedDataCache|\..*)$/i.test(e.name)) continue;
			if (e.name === 'Python' && /Content$/i.test(dir)) {
				for (const p of readdirSync(join(dir, e.name), { withFileTypes: true })) if (p.isDirectory()) names.add(p.name.toLowerCase());
				continue;
			}
			if (depth > 0) walk(join(dir, e.name), depth - 1);
		}
	};
	if (root) {
		walk(join(root, 'Source'), 3);
		walk(join(root, 'Plugins'), 7);
		walk(join(root, 'Content'), 1);
	}
	return names;
}

export function makeFilter({ root = null, exclude = null } = {}) {
	const own = projectModuleNames(root);
	const rx = exclude ? new RegExp(exclude, 'i') : null;
	return (name) => {
		if (rx && rx.test(name)) return `excluded by --exclude`;
		if (own.has(String(name).split('.')[0].toLowerCase())) return 'registered by the project (module/package in Source or Plugins)';
		return null;
	};
}

/** list_toolsets markdown → the raw text with the dropped toolsets' entries (a "- Name.Sub: ..." line and its
 *  continuation lines up to the next entry) removed. */
export function filterRawList(raw, keep) {
	const out = [];
	let skipping = false;
	for (const line of String(raw ?? '').split('\n')) {
		const m = /^\s*[-*]\s+([A-Za-z_]\w*(?:\.\w+)+)\s*:/.exec(line);
		if (m) skipping = !keep(m[1]);
		if (!skipping) out.push(line);
	}
	return out.join('\n');
}

const fileOf = (name) => `${name.replace(/[^\w.-]/g, '_')}.json`;
const stampOf = (s) => ({ version: s.version ?? 'unknown', changelist: s.changelist ?? null, dumpedAt: s.dumpedAt ?? null });

function writeSet(out, stamp, entries, raw, dropped) {
	mkdirSync(out, { recursive: true });
	for (const f of readdirSync(out)) if (f.endsWith('.json')) unlinkSync(join(out, f));
	for (const e of entries) writeFileSync(join(out, fileOf(e.toolset)), JSON.stringify({ ...stamp, toolset: e.toolset, schema: e.schema }, null, 1) + '\n');
	const index = { ...stamp, source: 'unreal-mcp list_toolsets (Epic toolsets only; project/third-party toolsets dropped)', toolsets: entries.map((e) => e.toolset), raw };
	writeFileSync(join(out, 'index.json'), JSON.stringify(index, null, 2) + '\n');
	console.log(`snapshots: ${entries.length} toolsets -> ${out}`);
	for (const d of dropped) console.log(`  dropped ${d.name}: ${d.why}`);
}

// --- offline: re-filter an existing set -------------------------------------------------------------------------

function fromDir(src, out, keepWhy) {
	const index = JSON.parse(readFileSync(join(src, 'index.json'), 'utf8'));
	const stamp = stampOf(index);
	const entries = [];
	const dropped = [];
	for (const name of index.toolsets ?? []) {
		const why = keepWhy(name);
		if (why) {
			dropped.push({ name, why });
			continue;
		}
		const f = join(src, fileOf(name));
		if (!existsSync(f)) {
			dropped.push({ name, why: 'no snapshot file in the source set' });
			continue;
		}
		const snap = JSON.parse(readFileSync(f, 'utf8'));
		entries.push({ toolset: name, schema: snap.schema });
	}
	writeSet(out, stamp, entries, filterRawList(index.raw, (n) => !keepWhy(n)), dropped);
	return 0;
}

// --- offline: check a set ----------------------------------------------------------------------------------------

export function checkSet(dir, keepWhy) {
	const problems = [];
	let index;
	try {
		index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'));
	} catch (e) {
		return [`no readable index.json in ${dir} (${e.message})`];
	}
	if (index.home !== undefined) problems.push('index.json carries a machine path (home)');
	const listed = new Set((index.toolsets ?? []).map(fileOf));
	for (const name of index.toolsets ?? []) {
		const why = keepWhy(name);
		if (why) problems.push(`${name}: ${why}`);
		if (!existsSync(join(dir, fileOf(name)))) problems.push(`${name}: listed but no file`);
	}
	for (const f of readdirSync(dir)) {
		if (!f.endsWith('.json') || f === 'index.json') continue;
		if (!listed.has(f)) problems.push(`${f}: file not listed in index.json`);
		const snap = JSON.parse(readFileSync(join(dir, f), 'utf8'));
		if (snap.home !== undefined) problems.push(`${f}: carries a machine path (home)`);
		if (keepWhy(snap.toolset)) problems.push(`${f}: ${keepWhy(snap.toolset)}`);
	}
	for (const m of String(index.raw ?? '').matchAll(/^\s*[-*]\s+([A-Za-z_]\w*(?:\.\w+)+)\s*:/gm)) {
		if (keepWhy(m[1])) problems.push(`index.raw still lists ${m[1]}`);
	}
	return problems;
}

// --- live dump ----------------------------------------------------------------------------------------------------

function parseSse(text) {
	const messages = [];
	let data = [];
	const flush = () => {
		if (!data.length) return;
		try {
			messages.push(JSON.parse(data.join('\n')));
		} catch {
			/* keep-alive */
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

async function client(url) {
	let sessionId = null;
	let id = 1;
	const post = async (body) => {
		const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
		if (sessionId) headers['mcp-session-id'] = sessionId;
		const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
		const sid = res.headers.get('mcp-session-id');
		if (sid) sessionId = sid;
		if (res.status === 202) return null;
		if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
		const text = await res.text();
		if (!text) return null;
		return (res.headers.get('content-type') || '').includes('text/event-stream') ? parseSse(text) : JSON.parse(text);
	};
	const rpc = async (method, params) => {
		const req = { jsonrpc: '2.0', id: `dump-${id++}`, method, params };
		const out = await post(req);
		const msg = Array.isArray(out) ? out.find((m) => m && m.id === req.id) || out[out.length - 1] : out;
		if (!msg || msg.error) throw new Error(`${method} failed: ${msg?.error?.message ?? 'no response'}`);
		return msg.result;
	};
	await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'toolset-dump', version: '1.0.0' } });
	await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
	return { rpc };
}

const contentText = (r) => (r?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');

/** Toolset names out of list_toolsets: JSON when the server answers JSON, else the "- Name.Sub:" markdown lines.
 *  Anchor on that shape: a loose word split once turned English prose into 69 junk "toolsets". */
export function toolsetNamesOf(listRaw) {
	let names = [];
	try {
		const collect = (v) => {
			if (typeof v === 'string') names.push(v);
			else if (Array.isArray(v)) v.forEach(collect);
			else if (v && typeof v === 'object') {
				if (typeof v.toolset_name === 'string') names.push(v.toolset_name);
				else if (typeof v.name === 'string') names.push(v.name);
				else Object.values(v).forEach(collect);
			}
		};
		collect(JSON.parse(listRaw));
		names = names.filter((t) => t.includes('.'));
	} catch {
		for (const line of String(listRaw).split(/\r?\n/)) {
			const m = /^\s*[-*]\s+([A-Za-z_]\w*(?:\.\w+)+)\s*:/.exec(line);
			if (m) names.push(m[1]);
		}
	}
	return [...new Set(names)];
}

function engineStamp(uproject) {
	const eng = resolveEngine(process.env, uproject);
	if (eng.error) return { version: 'unknown', changelist: null };
	try {
		const v = JSON.parse(readFileSync(join(eng.unrealHome, 'Engine', 'Build', 'Build.version'), 'utf8'));
		return { version: `${v.MajorVersion}.${v.MinorVersion}.${v.PatchVersion}`, changelist: v.Changelist ?? null };
	} catch {
		return { version: 'unreadable', changelist: null };
	}
}

async function live(url, out, keepWhy, uproject) {
	const stamp = { ...engineStamp(uproject), dumpedAt: new Date().toISOString() };
	console.log(`engine ${stamp.version} (CL ${stamp.changelist}); server ${url}`);
	const c = await client(url);
	const tools = await c.rpc('tools/list', {});
	const names = (tools?.tools ?? []).map((t) => t.name);
	if (!names.includes('list_toolsets')) {
		console.log('ERROR: this server has no list_toolsets - turn bEnableToolSearch on (the snapshots follow tool-search mode)');
		return 1;
	}
	const listRaw = contentText(await c.rpc('tools/call', { name: 'list_toolsets', arguments: {} }));
	const all = toolsetNamesOf(listRaw);
	if (!all.length) {
		console.log('ERROR: could not read toolset names from list_toolsets');
		return 1;
	}
	const entries = [];
	const dropped = [];
	for (const name of all) {
		const why = keepWhy(name);
		if (why) {
			dropped.push({ name, why });
			continue;
		}
		try {
			const r = await c.rpc('tools/call', { name: 'describe_toolset', arguments: { toolset_name: name } });
			const text = contentText(r);
			if (r?.isError || !text || /unknown toolset|not found|no toolset/i.test(text.slice(0, 200))) {
				dropped.push({ name, why: 'server returned no schema' });
				continue;
			}
			entries.push({ toolset: name, schema: text });
		} catch (e) {
			dropped.push({ name, why: e.message });
		}
	}
	writeSet(out, stamp, entries, filterRawList(listRaw, (n) => !keepWhy(n)), dropped);
	return 0;
}

// --- selftest -----------------------------------------------------------------------------------------------------

function selftest() {
	const fails = [];
	const ok = (c, m) => {
		if (!c) fails.push(m);
	};
	const base = mkdtempSync(join(tmpdir(), 'toolset-dump-selftest-'));
	try {
		const proj = join(base, 'Proj');
		mkdirSync(join(proj, 'Plugins', 'Mine', 'Source', 'MyToolset'), { recursive: true });
		writeFileSync(join(proj, 'Plugins', 'Mine', 'Source', 'MyToolset', 'MyToolset.Build.cs'), '');
		mkdirSync(join(proj, 'Plugins', 'Py', 'Content', 'Python', 'my_py_toolset'), { recursive: true });
		const src = join(base, 'src');
		mkdirSync(src);
		const raw = '- EditorToolset.EditorAppToolset: Tools for the editor.\nsecond line\n- MyToolset.MyToolset: Ours.\nours line 2\n- my_py_toolset.tools.X: py.\n- UMGToolSet.UMGToolSet: UMG.';
		const names = toolsetNamesOf(raw);
		ok(names.length === 4, `names from markdown (${names})`);
		writeFileSync(join(src, 'index.json'), JSON.stringify({ version: '5.8.3', changelist: 1, home: 'X:\\UE', dumpedAt: 'd', toolsets: names, raw }));
		for (const n of names) writeFileSync(join(src, fileOf(n)), JSON.stringify({ version: '5.8.3', home: 'X:\\UE', toolset: n, schema: '{}' }));
		const keep = makeFilter({ root: proj, exclude: 'UMG' });
		const out = join(base, 'out');
		const log = console.log;
		console.log = () => {};
		try {
			fromDir(src, out, keep);
		} finally {
			console.log = log;
		}
		const idx = JSON.parse(readFileSync(join(out, 'index.json'), 'utf8'));
		ok(JSON.stringify(idx.toolsets) === '["EditorToolset.EditorAppToolset"]', `only the Epic toolset kept (${idx.toolsets})`);
		ok(idx.raw === '- EditorToolset.EditorAppToolset: Tools for the editor.\nsecond line', `raw filtered with its continuation lines (${JSON.stringify(idx.raw)})`);
		ok(idx.home === undefined && !readdirSync(out).some((f) => /MyToolset|my_py|UMG/.test(f)), 'no machine path, no dropped files');
		ok(checkSet(out, keep).length === 0, `the filtered set checks clean (${checkSet(out, keep)})`);
		ok(checkSet(src, keep).length >= 4, 'the unfiltered set fails the check');
		ok(toolsetNamesOf(JSON.stringify([{ toolset_name: 'A.B' }, { name: 'C.D' }, 'nodot'])).join() === 'A.B,C.D', 'names from JSON');
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
	if (fails.length) {
		console.log(`dump-toolset-schemas selftest FAILED:\n  ${fails.join('\n  ')}`);
		return 1;
	}
	console.log('dump-toolset-schemas selftest: ok');
	return 0;
}

// --- CLI ----------------------------------------------------------------------------------------------------------

const Usage = `usage: node dump-toolset-schemas.mjs [--url URL] [--project DIR] [--out DIR] [--exclude REGEX]   (live, warm editor)
       node dump-toolset-schemas.mjs --from SRCDIR [--project DIR] [--out DIR] [--exclude REGEX]
       node dump-toolset-schemas.mjs --check [DIR] [--project DIR] [--exclude REGEX]
       node dump-toolset-schemas.mjs --selftest
Default --out / --check DIR: ${DefaultOut}`;

async function main(argv) {
	const at = (f) => {
		const i = argv.indexOf(f);
		return i >= 0 ? argv[i + 1] : null;
	};
	if (argv.includes('--help') || argv.includes('-h')) {
		console.log(Usage);
		return 0;
	}
	if (argv.includes('--selftest')) return selftest();
	const projectArg = at('--project');
	const uproject = projectArg ? (projectArg.toLowerCase().endsWith('.uproject') ? resolve(projectArg) : findProjectUproject(resolve(projectArg))) : findProjectUproject();
	const root = uproject ? dirname(uproject) : null;
	const keepWhy = makeFilter({ root, exclude: at('--exclude') });
	if (argv.includes('--check')) {
		const next = at('--check');
		const dir = next && !next.startsWith('--') ? resolve(next) : DefaultOut;
		const problems = checkSet(dir, keepWhy);
		if (problems.length) {
			console.log(`check FAILED for ${dir}:\n  ${problems.join('\n  ')}`);
			return 1;
		}
		const n = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')).toolsets.length;
		console.log(`check ok: ${n} toolsets in ${dir}${root ? ` (project ${root})` : ' (no project: --exclude only)'}`);
		return 0;
	}
	const out = resolve(at('--out') ?? DefaultOut);
	if (at('--from')) return fromDir(resolve(at('--from')), out, keepWhy);
	let url = at('--url');
	if (!url) {
		if (!uproject) {
			console.log('ERROR: no project to read the MCP port from; pass --url or --project');
			return 2;
		}
		url = projectInfo(uproject, process.env, { withEngine: false }).url;
	}
	return live(url, out, keepWhy, uproject);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
	main(process.argv.slice(2)).then(
		(code) => {
			process.exitCode = code;
		},
		(e) => {
			console.log(`ERROR: ${e.message}`);
			process.exitCode = 1;
		},
	);
}
