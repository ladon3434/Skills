// doctor.mjs — read-only machine + project check for Claude Code work on an Unreal project. Probes every external
// tool the kit silently depends on, so a missing one fails LOUDLY here instead of as "a guard hook that never
// fired". Changes nothing.
//
//   node doctor.mjs [--project <dir>] [--ports 18000,8000]
//
// --ports: loopback ports the project's own services listen on (MCP servers, bridges); each must sit OUTSIDE
// Windows' dynamic TCP range — WinNAT/Hyper-V reserve blocks inside it at boot and a reserved port refuses
// listen() with EACCES, which every caller reads as "already running". Without --ports the ports of the
// project's .mcp.json URLs are checked.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { engineVersion, projectInfo, resolveEngine } from './ue-engine.mjs';

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
	console.log('usage: doctor [--project <dir>] [--ports <p1,p2,...>]   (read-only)');
	process.exit(0);
}
const argOf = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const IsWindows = process.platform === 'win32';

let failed = 0;
let warned = 0;
const ok = (m) => console.log(`[ OK ] ${m}`);
const warn = (m) => { warned++; console.log(`[warn] ${m}`); };
const bad = (m) => { failed++; console.log(`[FAIL] ${m}`); };

function onPath(exe) {
	try {
		execFileSync(IsWindows ? 'where' : 'which', [exe], { stdio: 'ignore', windowsHide: true });
		return true;
	} catch {
		return false;
	}
}
function run(exe, args, cwd) {
	try {
		return execFileSync(exe, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, cwd, timeout: 20000 }).trim();
	} catch {
		return '';
	}
}
const probe = (exe, why) => (onPath(exe) ? ok(`${exe} - ${why}`) : bad(`${exe} MISSING - ${why}`));
const probeOpt = (exe, why) => (onPath(exe) ? ok(`${exe} - ${why}`) : warn(`${exe} missing (optional) - ${why}`));

const project = projectInfo(argOf('--project') ?? process.cwd());
console.log('=== ue-workstation doctor (read-only) ===\n');

// -- node
const major = Number(process.versions.node.split('.')[0]);
if (major < 18) bad(`node ${process.version} is too old - the scripts and hooks need Node 18+`);
else ok(`node ${process.version} - runs every hook and script of the kit`);

// -- git and its configuration
probe('git', 'version control');
if (IsWindows) {
	const gitBash = [join(process.env.ProgramFiles || '', 'Git', 'bin', 'bash.exe'), join(process.env.LocalAppData || '', 'Programs', 'Git', 'bin', 'bash.exe')].find(existsSync);
	if (gitBash) ok(`Git Bash at ${gitBash} - Claude Code runs its Bash tool and hook commands there (a bare "bash" on PATH may be WSL)`);
	else warn('Git Bash not found in the usual places - Claude Code on Windows needs Git for Windows');
}
const cwdForGit = project?.root ?? process.cwd();
const email = run('git', ['config', 'user.email'], cwdForGit);
if (email) ok(`git user.email set (${email})`);
else bad('git user.email is not set - commits fail. git config --global user.email "<you@example.com>"');
if (!onPath('git-lfs')) {
	bad('git-lfs MISSING - Unreal repositories keep .uasset/.umap in LFS; without it a clone holds 130-byte pointer files that look like corrupt assets. winget install GitHub.GitLFS, then git lfs install');
} else if (!run('git', ['config', '--get', 'filter.lfs.smudge'])) {
	bad('git-lfs is installed but not wired into git config - run `git lfs install` once, then `git lfs pull`');
} else {
	ok('git-lfs installed and wired');
}

// -- tools the kit and the neighbouring skills spawn by name
probe('rg', 'ripgrep - engine and project search (the copy inside Claude Code is invisible to scripts)');
probe('clang-format', 'the format-after-edit hook formats C++ with it (LLVM); without it the hook silently does nothing');
probeOpt('ctags', 'universal-ctags - the engine index of code-analysis; without it engine lookups fall back to slow ripgrep');
probeOpt('python', 'editor-side Python tooling and offline asset readers');
probeOpt('jq', 'handy in the shell; the hooks of this kit do NOT need it (they parse JSON with node)');

// -- engine and project
if (!project) {
	warn('no .uproject above the current directory (or --project / CLAUDE_PROJECT_DIR) - project checks skipped');
} else {
	ok(`project ${project.uproject}`);
}

// -- the kit's hooks: shipped by the ue-workstation plugin (hooks/hooks.json), live while the plugin is enabled.
// enabledPlugins is read the way Claude Code merges it: user < project < local, the last file that names the
// plugin wins. A hand-wired editor-guard in settings.json (the pre-plugin install) still counts.
const readText = (p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const userSettingsPath = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.claude', 'settings.json');
const projectSettingsPath = project ? join(project.root, '.claude', 'settings.json') : null;
const localSettingsPath = project ? join(project.root, '.claude', 'settings.local.json') : null;
function pluginState(name) {
	let state = null;
	for (const p of [userSettingsPath, projectSettingsPath, localSettingsPath]) {
		if (!p) continue;
		for (const [id, on] of Object.entries(readJson(p)?.enabledPlugins ?? {})) {
			if (id.split('@')[0] === name) state = { on: on === true, where: p };
		}
	}
	return state;
}
const kitPlugin = pluginState('ue-workstation');
if (kitPlugin?.on) ok(`ue-workstation plugin enabled (${kitPlugin.where}) - its hooks are live: editor-guard, no-tree-git-editor-open, format-after-edit, subagent-engine-root`);
else if (readText(userSettingsPath).includes('editor-guard')) ok(`editor-guard hook wired by hand in ${userSettingsPath}`);
else if (projectSettingsPath && readText(projectSettingsPath).includes('editor-guard')) ok(`editor-guard hook wired by hand in ${projectSettingsPath}`);
else warn(`ue-workstation plugin ${kitPlugin ? 'disabled' : 'not installed'} - no editor-guard: nothing stops a session from stopping an editor it did not start. claude plugin install ue-workstation@ue-skills --scope local`);
if (process.env.UE_WS_PROJECT_WRITES === '1') ok('project-writes on (UE_WS_PROJECT_WRITES=1): writes inside the project go without a prompt');
const engine = resolveEngine(process.env, project?.root ?? process.cwd());
const { version, from } = engineVersion(process.env, project?.root ?? process.cwd());
if (engine.unrealHome) ok(`Unreal Engine ${version} (${from}) at "${engine.unrealHome}"`);
else bad(engine.error);

if (project) {
	if (existsSync(join(project.root, '.claude', 'ue-workstation'))) {
		warn('.claude/ue-workstation in the project is the pre-plugin kit copy - with the plugin enabled its hooks run twice; remove the copy and its hook entries from .claude/settings.json');
	}
	if (existsSync(join(project.root, '.clang-format'))) ok('.clang-format present - the hook formats with the project style');
	else warn('no .clang-format at the project root - the format hook leaves C++ files as written (no style to apply)');
	if (existsSync(join(project.root, 'compile_commands.json'))) {
		warn('compile_commands.json present at the project root - a clangd will background-index UE and eat tens of GB of commit charge; drop it with clean-clangd when done');
	}
	const declared = (() => {
		try { return readFileSync(join(project.root, '.gitmodules'), 'utf8').split(/\r?\n/).map((l) => l.match(/^\s*path\s*=\s*(.+?)\s*$/)?.[1]).filter(Boolean); } catch { return []; }
	})();
	for (const sub of declared) {
		if (existsSync(join(project.root, sub, '.git'))) ok(`submodule ${sub} initialised`);
		else bad(`submodule ${sub} not initialised - an empty folder where its source belongs. git submodule update --init --recursive`);
	}
}
if (engine.unrealHome && existsSync(join(engine.unrealHome, 'compile_commands.json'))) {
	warn(`compile_commands.json beside the engine (${engine.unrealHome}) - an editor LSP with --compile-commands-dir picks it; drop it with clean-clangd`);
}

// -- the kit's plugins: what is enabled, whether each one's dependencies are enabled too, and the tools only some
// of them need. Install paths come from Claude Code's own record of installed plugins.
const KitMarketplaces = new Set(['ue-skills', 'private-skills']);
const installed = readJson(join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.claude', 'plugins', 'installed_plugins.json'))?.plugins ?? {};
const kit = Object.entries(installed)
	.map(([id, rows]) => ({ id, name: id.split('@')[0], market: id.split('@')[1], path: rows?.at(-1)?.installPath }))
	.filter((p) => KitMarketplaces.has(p.market) && pluginState(p.name)?.on);
if (kit.length) ok(`kit plugins enabled: ${kit.map((p) => p.name).join(', ')}`);
const enabledNames = new Set(kit.map((p) => p.name));
for (const p of kit) {
	const deps = (p.path && readJson(join(p.path, '.claude-plugin', 'plugin.json'))?.dependencies) ?? [];
	const missing = deps.map((d) => (typeof d === 'string' ? d : d?.name)).filter((d) => d && !enabledNames.has(d));
	if (missing.length) bad(`${p.name} needs ${missing.join(', ')}, which is not enabled - claude plugin install ${missing[0]}@${p.market} --scope local`);
}
const bridge = kit.find((p) => p.name === 'ue-blender-bridge');
if (bridge?.path) {
	const where = run(process.execPath, [join(bridge.path, 'skills', 'ue-blender-bridge', 'scripts', 'mjs', 'blender-run.mjs'), '--where']);
	const exe = where.match(/^blender: (.+)$/m)?.[1];
	if (exe) ok(`Blender for ue-blender-bridge: ${exe} (gn-props needs 5.2+; BLENDER_ROOTS / BLENDER_EXE choose another)`);
	else warn('ue-blender-bridge is enabled but no Blender was found - blender.cmd --where shows where it looked');
}
if (enabledNames.has('doc-tts')) probeOpt('ffmpeg', 'doc-tts encodes MP3 with it');

// -- MCP servers of the project on this machine: a closed port is normal while no editor runs, so it only informs.
async function listening(port) {
	const { connect } = await import('node:net');
	return new Promise((done) => {
		const s = connect({ host: '127.0.0.1', port });
		const end = (v) => { s.destroy(); done(v); };
		s.once('connect', () => end(true));
		s.once('error', () => end(false));
		s.setTimeout(1500, () => end(false));
	});
}
if (project) {
	const servers = Object.entries(readJson(join(project.root, '.mcp.json'))?.mcpServers ?? {});
	for (const [name, s] of servers) {
		const port = Number(JSON.stringify(s).match(/(?:localhost|127\.0\.0\.1):(\d{2,5})/)?.[1]);
		if (!port) continue;
		ok(`MCP ${name} on port ${port}: ${(await listening(port)) ? 'answering' : 'not listening now (normal while its editor is closed)'}`);
	}
}

// -- ports vs the Windows dynamic TCP range
function portsToCheck() {
	const list = argOf('--ports');
	if (list) return list.split(',').map((s) => Number(s.trim())).filter(Number.isFinite).map((p) => [`port`, p]);
	if (!project) return [];
	try {
		const mcp = JSON.parse(readFileSync(join(project.root, '.mcp.json'), 'utf8'));
		return Object.entries(mcp.mcpServers ?? {}).flatMap(([name, s]) => {
			const text = JSON.stringify(s);
			return [...text.matchAll(/(?:localhost|127\.0\.0\.1):(\d{2,5})/g)].map((m) => [name, Number(m[1])]);
		});
	} catch {
		return [];
	}
}
if (IsWindows) {
	const ports = portsToCheck();
	const out = run('netsh', ['int', 'ipv4', 'show', 'dynamicport', 'tcp']);
	const start = Number(out.match(/Start Port\s*:\s*(\d+)/)?.[1]);
	const count = Number(out.match(/Number of Ports\s*:\s*(\d+)/)?.[1]);
	if (!Number.isFinite(start) || !Number.isFinite(count)) {
		warn('could not read the dynamic TCP port range (netsh) - ports unchecked');
	} else {
		const end = start + count - 1;
		if (!ports.length) ok(`dynamic TCP range is ${start}-${end}: keep every local service port outside it (no ports given to check)`);
		const inside = ports.filter(([, p]) => p >= start && p <= end);
		if (inside.length) bad(`ports inside the dynamic TCP range ${start}-${end}: ${inside.map(([n, p]) => `${n}=${p}`).join(', ')} - WinNAT can reserve them at any boot and listen() then fails with EACCES. Move them out of that range.`);
		else if (ports.length) ok(`ports ${ports.map(([, p]) => p).join(', ')} are outside the dynamic TCP range ${start}-${end}`);
		// Reserved right now (Hyper-V / WinNAT / Docker): a port in one of these blocks cannot be bound at all.
		const excluded = [...run('netsh', ['int', 'ipv4', 'show', 'excludedportrange', 'protocol=tcp']).matchAll(/^\s*(\d+)\s+(\d+)/gm)].map((m) => [Number(m[1]), Number(m[2])]);
		const reserved = ports.filter(([, p]) => excluded.some(([a, b]) => p >= a && p <= b));
		if (reserved.length) bad(`ports inside a reserved (excluded) port range right now: ${reserved.map(([n, p]) => `${n}=${p}`).join(', ')} - binding them fails with EACCES; see netsh int ipv4 show excludedportrange protocol=tcp`);
	}
}

console.log('');
if (failed) {
	console.log(`RESULT: ${failed} FAIL, ${warned} warn - fix the [FAIL] lines (CLI tools: <skill>\\scripts\\install-agent-tools.cmd).`);
	process.exit(1);
}
console.log(`RESULT: all prerequisites present (${warned} warn).`);
