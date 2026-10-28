// ue-project.mjs — what the unreal-editor scripts need to know about the project, read OFFLINE from its files:
// where the project and its live log are, whether the editor will host Epic's MCP server (unreal-mcp) and on which
// port/path, and whether python can reach it (Python Remote Execution). Nothing here talks to the editor.
//
//   node ue-project.mjs [--project <dir|.uproject>] [--json] [--field <name>]
//   node ue-project.mjs preflight [--project ...] [--json] [--no-probe]
//   node ue-project.mjs --selftest
//
// Port, first hit wins (the engine's own order, ModelContextProtocolSettings.cpp:17-29 in UE 5.8):
//   1. UE_MCP_PORT (env)                         — this machine's override for scripts and the bridge
//   2. Saved/Config/WindowsEditor/EditorPerProjectUserSettings.ini   (Editor Preferences writes here)
//   3. Config/DefaultEditorPerProjectUserSettings.ini                 (the tracked project baseline)
//      both: [/Script/ModelContextProtocolEngine.ModelContextProtocolSettings] ServerPortNumber=
//   4. 8000 (UModelContextProtocolSettings::ServerPortNumber default)
// A `-ModelContextProtocolPort=N` on the editor command line beats all of them and is invisible to files; the
// last "Starting MCP server on port N" line of the project log shows what the last run REALLY used (`logPort`).
//
// Log: Saved/Logs/<uproject name>.log — the running editor's log (older runs are <name>-backup-<date>.log).

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findProjectUproject, resolveEngine } from './ue-engine.mjs';
import { remoteSettings } from './ue-pyremote.mjs';

const McpSection = '/Script/ModelContextProtocolEngine.ModelContextProtocolSettings';
const DefaultPort = 8000;
const DefaultUrlPath = '/mcp';

// --- small readers ---------------------------------------------------------------------------------------

/** INI → { section: { key: value } }; later duplicates win, `+Key=` / `-Key=` array syntax is ignored. */
export function parseIni(text) {
	const out = {};
	let section = null;
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith(';') || line.startsWith('#')) continue;
		const sec = /^\[(.+)\]$/.exec(line);
		if (sec) {
			section = sec[1].trim();
			out[section] ??= {};
			continue;
		}
		if (!section || /^[+\-!.]/.test(line)) continue;
		const eq = line.indexOf('=');
		if (eq <= 0) continue;
		out[section][line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
	}
	return out;
}

function readText(file) {
	try {
		return readFileSync(file, 'utf8').replace(/^﻿/, '');
	} catch {
		return null;
	}
}

function readJson(file) {
	const t = readText(file);
	if (t === null) return null;
	try {
		return JSON.parse(t);
	} catch {
		return null;
	}
}

/** Saved/Autosaves/PackageRestoreData.json is UTF-16LE WITHOUT a BOM — read it as such. */
export function readRestoreData(file) {
	let buf;
	try {
		buf = readFileSync(file);
	} catch {
		return null;
	}
	let text;
	if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) text = buf.subarray(2).toString('utf16le');
	else if (buf.length >= 2 && buf[1] === 0x00) text = buf.toString('utf16le');
	else text = buf.toString('utf8').replace(/^﻿/, '');
	try {
		const d = JSON.parse(text);
		return { restoreEnabled: !!d.RestoreEnabled, packages: Array.isArray(d.Packages) ? d.Packages.length : 0 };
	} catch (e) {
		return { error: `unparsable (${e.message})` };
	}
}

/** The port the last editor run of this project actually served on, from its log; null when not found. */
export function logPortOf(logFile) {
	const t = readText(logFile);
	if (t === null) return null;
	const all = [...t.matchAll(/LogModelContextProtocol: Starting MCP server on port (\d+)/g)];
	return all.length ? Number(all[all.length - 1][1]) : null;
}

/** Every *.uplugin under `dir` (bounded depth), as { name, file }. */
function findUplugins(dir, depth = 4) {
	const out = [];
	const walk = (d, left) => {
		let names;
		try {
			names = readdirSync(d);
		} catch {
			return;
		}
		for (const n of names) {
			const p = join(d, n);
			if (n.toLowerCase().endsWith('.uplugin')) out.push({ name: n.slice(0, -8), file: p });
			else if (left > 0 && !/^(Binaries|Intermediate|Content|Source|Resources|Saved|Config|docs|\..*)$/i.test(n)) {
				try {
					if (statSync(p).isDirectory()) walk(p, left - 1);
				} catch {
					/* vanished */
				}
			}
		}
	};
	walk(dir, depth);
	return out;
}

// --- the detector ------------------------------------------------------------------------------------------

/**
 * Everything offline about one project. `uproject` is a .uproject path; `env` is process.env by default.
 * Never throws for a missing file: absent config is an answer (the engine default), not an error.
 */
export function projectInfo(uproject, env = process.env, { withEngine = true } = {}) {
	const root = dirname(uproject);
	const name = basename(uproject).replace(/\.uproject$/i, '');
	const warnings = [];
	const up = readJson(uproject) ?? {};
	const upPlugins = Array.isArray(up.Plugins) ? up.Plugins : [];
	const upEntry = (n) => upPlugins.find((p) => String(p?.Name).toLowerCase() === n.toLowerCase()) ?? null;

	// Plugins shipped inside the project, and which of them are on (a project plugin is on unless the .uproject
	// says Enabled:false or the plugin says EnabledByDefault:false and the .uproject does not switch it on).
	const projectPlugins = findUplugins(join(root, 'Plugins')).map((p) => {
		const desc = readJson(p.file) ?? {};
		const entry = upEntry(p.name);
		const enabled = entry ? entry.Enabled !== false : desc.EnabledByDefault !== false;
		return { ...p, desc, enabled };
	});
	const enabledPlugin = (n) => {
		const entry = upEntry(n);
		if (entry) return entry.Enabled !== false ? `${basename(uproject)}` : null;
		const local = projectPlugins.find((p) => p.name.toLowerCase() === n.toLowerCase());
		if (local?.enabled) return `Plugins/${local.name}`;
		// Pulled in as a dependency of an enabled project plugin (a tools plugin that lists ModelContextProtocol).
		for (const p of projectPlugins) {
			if (!p.enabled) continue;
			const dep = (p.desc.Plugins ?? []).find((d) => String(d?.Name).toLowerCase() === n.toLowerCase() && d.Enabled !== false);
			if (dep) return `dependency of ${p.name}`;
		}
		return null;
	};

	const mcp = { enabled: enabledPlugin('ModelContextProtocol') };
	const allToolsets = { enabled: enabledPlugin('AllToolsets') };
	const liveCoding = { enabled: enabledPlugin('LiveCodingToolset') };
	// Python in the editor: PythonScriptPlugin (ToolsetRegistry depends on it, so Epic's MCP server brings it), and
	// Remote Execution, which ue-launch-editor and the bridge switch on from the command line.
	const remote = remoteSettings(root, env);
	const pythonRemote = {
		plugin: enabledPlugin('PythonScriptPlugin') ?? (mcp.enabled ? 'dependency of ToolsetRegistry (ModelContextProtocol)' : null),
		setting: remote.enabled ?? null,
		endpoint: `${remote.group}:${remote.port} via ${remote.bind}`,
	};

	// Settings: Saved (per machine) over Config/Default (tracked), the engine's own layering.
	const layers = [
		{ from: 'Saved/Config/WindowsEditor/EditorPerProjectUserSettings.ini', file: join(root, 'Saved', 'Config', 'WindowsEditor', 'EditorPerProjectUserSettings.ini') },
		{ from: 'Config/DefaultEditorPerProjectUserSettings.ini', file: join(root, 'Config', 'DefaultEditorPerProjectUserSettings.ini') },
	];
	const setting = (key) => {
		for (const l of layers) {
			const t = readText(l.file);
			if (t === null) continue;
			const v = parseIni(t)[McpSection]?.[key];
			if (v !== undefined && v !== '') return { value: v, from: l.from };
		}
		return null;
	};

	let port = DefaultPort;
	let portFrom = 'engine default';
	const envPort = Number(env.UE_MCP_PORT);
	const iniPort = setting('ServerPortNumber');
	if (env.UE_MCP_PORT && Number.isInteger(envPort) && envPort > 0 && envPort < 65536) {
		port = envPort;
		portFrom = 'UE_MCP_PORT';
	} else {
		if (env.UE_MCP_PORT) warnings.push(`UE_MCP_PORT="${env.UE_MCP_PORT}" is not a port - ignored`);
		if (iniPort && Number(iniPort.value) > 0) {
			port = Number(iniPort.value);
			portFrom = iniPort.from;
		}
	}
	const pathSetting = setting('ServerUrlPath');
	let urlPath = pathSetting ? pathSetting.value.replace(/^"|"$/g, '') : DefaultUrlPath;
	if (!urlPath.startsWith('/')) urlPath = `/${urlPath}`;
	const autoStart = setting('bAutoStartServer');
	const toolSearch = setting('bEnableToolSearch');
	const truthy = (s) => /^(true|1|yes)$/i.test(String(s?.value ?? ''));

	const url = env.UE_MCP_URL || `http://127.0.0.1:${port}${urlPath}`;
	const log = join(root, 'Saved', 'Logs', `${name}.log`);
	const logExists = existsSync(log);
	const logPort = logExists ? logPortOf(log) : null;
	if (logPort && logPort !== port && !env.UE_MCP_URL) {
		warnings.push(`the last editor run served MCP on port ${logPort}, the settings say ${port} (a -ModelContextProtocolPort override, or settings changed since) - set UE_MCP_PORT=${logPort} if that editor is the one you mean`);
	}

	// What the project's own .mcp.json points Claude Code at, if anything.
	const mcpJson = readJson(join(root, '.mcp.json'));
	const registered = [];
	for (const [k, v] of Object.entries(mcpJson?.mcpServers ?? {})) {
		const u = v?.url ?? (Array.isArray(v?.args) ? v.args.find((a) => /^https?:\/\//.test(String(a))) : null);
		registered.push({ name: k, type: v?.type ?? (v?.command ? 'stdio' : '?'), url: u ?? null });
		if (u) {
			try {
				const p = Number(new URL(u).port || 80);
				// A port equal to the last run's is already covered by the settings-drift warning above.
				if (/127\.0\.0\.1|localhost/.test(u) && p !== port && p !== logPort) {
					warnings.push(`.mcp.json server "${k}" points at port ${p}, the editor settings say ${port}`);
				}
			} catch {
				/* not a URL */
			}
		}
	}

	// Which server the editor will host.
	const serverKind = mcp.enabled ? 'epic' : 'none';
	if (!pythonRemote.plugin) warnings.push('PythonScriptPlugin is not on: no python in the editor (enable it, or ModelContextProtocol, which brings it)');
	if (serverKind === 'epic' && !allToolsets.enabled) {
		warnings.push('ModelContextProtocol is on but AllToolsets is not: the server may start with no toolsets (enable AllToolsets, or individual toolset plugins)');
	}
	if (serverKind !== 'none' && !truthy(autoStart)) {
		warnings.push('bAutoStartServer=True is not in the project settings files: unless a user-level setting turns it on, the server starts only with -ModelContextProtocolStartServer or the console command ModelContextProtocol.StartServer');
	}

	const info = {
		project: root,
		uproject,
		name,
		engineAssociation: up.EngineAssociation ?? null,
		log,
		logExists,
		logPort,
		serverKind,
		modelContextProtocol: mcp,
		allToolsets,
		liveCoding,
		pythonRemote,
		port,
		portFrom,
		urlPath,
		url,
		urlFrom: env.UE_MCP_URL ? 'UE_MCP_URL' : 'port + ServerUrlPath',
		autoStart: autoStart ? { value: truthy(autoStart), from: autoStart.from } : { value: false, from: 'engine default' },
		toolSearch: toolSearch ? { value: truthy(toolSearch), from: toolSearch.from } : { value: true, from: 'engine default' },
		mcpJson: registered,
		stateDir: stateDir(env),
		sidFile: join(stateDir(env), `sid-${port}.txt`),
		warnings,
	};
	if (withEngine) {
		const eng = resolveEngine(env, uproject);
		info.engine = eng.error ? { error: eng.error } : { unrealHome: eng.unrealHome };
	}
	return info;
}

/** Where runtime state (MCP session ids) lives: UE_MCP_STATE_DIR, else <temp>/unreal-editor-mcp. Never the skill folder. */
export function stateDir(env = process.env) {
	return env.UE_MCP_STATE_DIR || join(tmpdir(), 'unreal-editor-mcp');
}

// --- preflight: the modal-window signs, read before a launch --------------------------------------------

function probePort(port, timeoutMs = 800) {
	return new Promise((r) => {
		const s = net.connect(port, '127.0.0.1');
		s.setTimeout(timeoutMs);
		s.on('connect', () => {
			s.destroy();
			r(true);
		});
		s.on('timeout', () => {
			s.destroy();
			r(false);
		});
		s.on('error', () => r(false));
	});
}

export async function preflight(info, { probe = true } = {}) {
	const root = info.project;
	const restore = readRestoreData(join(root, 'Saved', 'Autosaves', 'PackageRestoreData.json'));
	let newestCrash = null;
	try {
		const dir = join(root, 'Saved', 'Crashes');
		for (const n of readdirSync(dir)) {
			const at = statSync(join(dir, n)).mtimeMs;
			if (!newestCrash || at > newestCrash.at) newestCrash = { dir: join(dir, n), at };
		}
	} catch {
		/* no crashes folder */
	}
	let logAgeSec = null;
	let logSize = null;
	if (info.logExists) {
		const st = statSync(info.log);
		logAgeSec = Math.round((Date.now() - st.mtimeMs) / 1000);
		logSize = st.size;
	}
	const listening = probe ? await probePort(info.port) : null;
	const verdicts = [];
	// FPackageAutoSaver::HasPackagesToRestore: the panel needs at least one package; RestoreEnabled alone (left by any
	// unclean exit) shows nothing, and -unattended never shows it.
	if (restore && !restore.error && restore.packages > 0) {
		verdicts.push(`RESTORE PANEL: PackageRestoreData.json lists ${restore.packages} package(s) - the next GUI launch stops on "restore unsaved assets?" which only a person can close. Tell the person BEFORE launching.`);
	}
	if (newestCrash) {
		const ago = Math.round((Date.now() - newestCrash.at) / 60000);
		verdicts.push(`last crash report ${ago} min ago: ${newestCrash.dir}${ago < 60 && info.logExists ? ' (a recent unclean exit)' : ''}`);
	}
	if (!verdicts.length) verdicts.push('clean: no restore data, no crash reports');
	return {
		restore: restore ?? { missing: true },
		newestCrash: newestCrash ? { dir: newestCrash.dir, minutesAgo: Math.round((Date.now() - newestCrash.at) / 60000) } : null,
		log: { file: info.log, exists: info.logExists, size: logSize, secondsSinceWrite: logAgeSec },
		port: info.port,
		listening,
		verdicts,
	};
}

// --- CLI ---------------------------------------------------------------------------------------------------

function usage() {
	return `usage: node ue-project.mjs [--project <dir|.uproject>] [--json] [--field <name>]
       node ue-project.mjs preflight [--project <dir|.uproject>] [--json] [--no-probe]
       node ue-project.mjs --selftest

Reads the project offline: server kind (epic | none), MCP port/url, python remote execution, log path.
Fields: project uproject name log logExists logPort serverKind pythonRemote port portFrom url urlPath sidFile stateDir
Env: UE_MCP_PORT (port override), UE_MCP_URL (full URL override), UE_MCP_STATE_DIR (session ids),
     CLAUDE_PROJECT_DIR (project when cwd has none), UNREAL_HOME / UE_VERSION (engine).`;
}

function resolveUproject(arg) {
	if (!arg) return findProjectUproject();
	const p = resolve(arg);
	if (p.toLowerCase().endsWith('.uproject')) return existsSync(p) ? p : null;
	return findProjectUproject(p);
}

function printHuman(i) {
	const kind = { epic: 'Epic stock unreal-mcp (toolsets via call_tool)', none: 'none - the ModelContextProtocol plugin is off' }[i.serverKind];
	const py = i.pythonRemote;
	console.log(`project      : ${i.name}  (${i.uproject})`);
	console.log(`server       : ${kind}`);
	console.log(`  Epic MCP   : ${i.modelContextProtocol.enabled ? `on (${i.modelContextProtocol.enabled})` : 'off'};  AllToolsets: ${i.allToolsets.enabled ? `on (${i.allToolsets.enabled})` : 'off'};  LiveCodingToolset: ${i.liveCoding.enabled ? 'on' : 'off'}`);
	console.log(`python       : ${py.plugin ? `PythonScriptPlugin on (${py.plugin})` : 'PythonScriptPlugin OFF'}; Remote Execution in the project config: ${py.setting ?? 'not set (off)'} (editors started by ue-launch-editor or the bridge have it on anyway); ${py.endpoint}`);
	console.log(`url          : ${i.url}  (port from ${i.portFrom})`);
	console.log(`auto start   : ${i.autoStart.value} (${i.autoStart.from});  tool search: ${i.toolSearch.value} (${i.toolSearch.from})`);
	console.log(`log          : ${i.log}${i.logExists ? '' : '  (not there yet)'}${i.logPort ? `  [last run served port ${i.logPort}]` : ''}`);
	if (i.mcpJson.length) console.log(`.mcp.json    : ${i.mcpJson.map((s) => `${s.name}=${s.type}${s.url ? ` ${s.url}` : ''}`).join(', ')}`);
	if (i.engine) console.log(`engine       : ${i.engine.unrealHome ?? i.engine.error}`);
	for (const w of i.warnings) console.log(`WARNING: ${w}`);
}

async function main(argv) {
	if (argv.includes('--help') || argv.includes('-h')) {
		console.log(usage());
		return 0;
	}
	if (argv.includes('--selftest')) return selftest();
	const at = (f) => {
		const k = argv.indexOf(f);
		return k >= 0 ? argv[k + 1] : null;
	};
	const uproject = resolveUproject(at('--project'));
	if (!uproject) {
		console.log('ERROR: no .uproject found walking up from here (or CLAUDE_PROJECT_DIR); pass --project <dir>');
		return 2;
	}
	const info = projectInfo(uproject);
	if (argv.includes('preflight')) {
		const pf = await preflight(info, { probe: !argv.includes('--no-probe') });
		if (argv.includes('--json')) console.log(JSON.stringify(pf, null, 2));
		else {
			console.log(`restore data : ${pf.restore.missing ? 'none' : pf.restore.error ?? `RestoreEnabled=${pf.restore.restoreEnabled}, packages=${pf.restore.packages}`}`);
			console.log(`log          : ${pf.log.exists ? `${pf.log.size} bytes, written ${pf.log.secondsSinceWrite}s ago` : 'none yet'}`);
			if (pf.listening !== null) console.log(`port ${pf.port}   : ${pf.listening ? 'something is listening' : 'nothing listens'}`);
			for (const v of pf.verdicts) console.log(`=> ${v}`);
		}
		return pf.verdicts.some((v) => v.startsWith('RESTORE PANEL')) ? 1 : 0;
	}
	const field = at('--field');
	if (field) {
		const v = info[field];
		if (v === undefined) {
			console.log(`ERROR: unknown field "${field}"`);
			return 2;
		}
		console.log(typeof v === 'object' ? JSON.stringify(v) : String(v));
		return 0;
	}
	if (argv.includes('--json')) console.log(JSON.stringify(info, null, 2));
	else printHuman(info);
	return 0;
}

// --- selftest: synthetic projects in a temp folder ----------------------------------------------------------

function selftest() {
	const fails = [];
	const ok = (c, m) => {
		if (!c) fails.push(m);
	};
	const base = mkdtempSync(join(tmpdir(), 'ue-project-selftest-'));
	const mk = (rel, content) => {
		const p = join(base, rel);
		mkdirSync(dirname(p), { recursive: true });
		writeFileSync(p, content);
		return p;
	};
	try {
		// A: stock Epic, port in the tracked ini, overridden by Saved, log names the real port.
		const a = mk('A/Game.uproject', JSON.stringify({ EngineAssociation: '5.8', Plugins: [{ Name: 'ModelContextProtocol', Enabled: true }, { Name: 'AllToolsets', Enabled: true }] }));
		mk('A/Config/DefaultEditorPerProjectUserSettings.ini', `[${McpSection}]\nServerPortNumber=18900\nbAutoStartServer=True\n`);
		let i = projectInfo(a, {}, { withEngine: false });
		ok(i.serverKind === 'epic', `A: epic kind (${i.serverKind})`);
		ok(i.port === 18900 && /Default/.test(i.portFrom), `A: tracked ini port (${i.port} ${i.portFrom})`);
		ok(i.autoStart.value === true, 'A: autostart read');
		ok(i.log.endsWith(join('Saved', 'Logs', 'Game.log')), `A: log path (${i.log})`);
		mk('A/Saved/Config/WindowsEditor/EditorPerProjectUserSettings.ini', `[Other]\nServerPortNumber=1\n[${McpSection}]\nServerPortNumber=18950\nServerUrlPath=mcp2\n`);
		i = projectInfo(a, {}, { withEngine: false });
		ok(i.port === 18950 && /Saved/.test(i.portFrom), `A: Saved overrides Default (${i.port})`);
		ok(i.url === 'http://127.0.0.1:18950/mcp2', `A: url path normalised (${i.url})`);
		i = projectInfo(a, { UE_MCP_PORT: '19001' }, { withEngine: false });
		ok(i.port === 19001 && i.portFrom === 'UE_MCP_PORT', 'A: env beats ini');
		i = projectInfo(a, { UE_MCP_PORT: 'abc' }, { withEngine: false });
		ok(i.port === 18950 && i.warnings.some((w) => /not a port/.test(w)), 'A: a bad env port is ignored with a warning');
		mk('A/Saved/Logs/Game.log', 'x\n[0]LogModelContextProtocol: Starting MCP server on port 18000 (override with -ModelContextProtocolPort=N).\n[1]LogModelContextProtocol: Starting MCP server on port 18977 (override with -ModelContextProtocolPort=N).\n');
		i = projectInfo(a, {}, { withEngine: false });
		ok(i.logPort === 18977 && i.warnings.some((w) => /18977/.test(w)), `A: last log port wins and drift is warned (${i.logPort})`);

		// B: a project tools plugin pulls in ModelContextProtocol; no settings -> 8000, no autostart warning.
		const b = mk('B/Tools.uproject', JSON.stringify({ Plugins: [{ Name: 'MyTools', Enabled: true }] }));
		mk('B/Plugins/MyTools/MyTools.uplugin', JSON.stringify({ Plugins: [{ Name: 'ModelContextProtocol', Enabled: true }] }));
		mk('B/.mcp.json', JSON.stringify({ mcpServers: { 'unreal-mcp': { type: 'http', url: 'http://127.0.0.1:8001/mcp' } } }));
		i = projectInfo(b, {}, { withEngine: false });
		ok(i.serverKind === 'epic', `B: epic kind through a dependency (${i.serverKind})`);
		ok(/dependency of MyTools/.test(String(i.modelContextProtocol.enabled)), `B: Epic MCP on through the plugin (${i.modelContextProtocol.enabled})`);
		ok(/ToolsetRegistry/.test(String(i.pythonRemote.plugin)), `B: python comes with the MCP server (${i.pythonRemote.plugin})`);
		ok(i.port === 8000 && i.portFrom === 'engine default', 'B: default port 8000');
		ok(i.warnings.some((w) => /bAutoStartServer/.test(w)), 'B: missing autostart is warned');
		ok(i.warnings.some((w) => /\.mcp\.json.*8001/.test(w)), 'B: .mcp.json port drift is warned');

		// C: the tools plugin is present but disabled in .uproject -> it pulls in nothing; no python either.
		const c = mk('C/X.uproject', JSON.stringify({ Plugins: [{ Name: 'MyTools', Enabled: false }] }));
		mk('C/Plugins/Vendor/MyTools/MyTools.uplugin', JSON.stringify({ Plugins: [{ Name: 'ModelContextProtocol', Enabled: true }] }));
		mk('C/Config/DefaultEngine.ini', '[/Script/PythonScriptPlugin.PythonScriptPluginSettings]\nbRemoteExecution=True\n');
		i = projectInfo(c, {}, { withEngine: false });
		ok(i.serverKind === 'none', `C: a disabled plugin pulls nothing in (${i.serverKind})`);
		ok(i.pythonRemote.setting === 'True' && i.warnings.some((w) => /PythonScriptPlugin is not on/.test(w)), `C: the setting is read, the missing plugin warned (${JSON.stringify(i.pythonRemote)})`);

		// Restore data: UTF-16LE without BOM, and a clean one.
		const rd = join(base, 'restore.json');
		writeFileSync(rd, Buffer.from(JSON.stringify({ RestoreEnabled: true, Packages: [{ a: 1 }, { b: 2 }] }), 'utf16le'));
		const r = readRestoreData(rd);
		ok(r && r.restoreEnabled === true && r.packages === 2, `restore data UTF-16LE no BOM (${JSON.stringify(r)})`);
		writeFileSync(rd, Buffer.from(JSON.stringify({ RestoreEnabled: false, Packages: [] }), 'utf16le'));
		ok(readRestoreData(rd).packages === 0, 'clean restore data');

		ok(parseIni('[S]\nK = V\n+Arr=1\n;c\nK=W\n').S.K === 'W', 'ini: later key wins, array lines skipped');
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
	if (fails.length) {
		console.log(`ue-project selftest FAILED:\n  ${fails.join('\n  ')}`);
		return 1;
	}
	console.log('ue-project selftest: ok');
	return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
	main(process.argv.slice(2)).then((code) => {
		process.exitCode = code;
	});
}
