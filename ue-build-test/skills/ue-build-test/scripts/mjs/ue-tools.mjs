// ue-tools.mjs — the toolchain and the project identity every ue-build-test script needs.
//
// What it assumes about the project:
//   - the project is the nearest .uproject walking up from the cwd, else from CLAUDE_PROJECT_DIR, or the one
//     named by --project; never a path computed from where this script lives;
//   - the engine version comes from the project's EngineAssociation (ue-engine.mjs), not a constant;
//   - the build targets are read from Source/*.Target.cs (TargetType.Editor / TargetType.Game), so a project
//     whose editor target is not literally <Name>Editor still builds.
// Machine configuration only through env: UNREAL_HOME, UE_VERSION, UE_MAX_PARALLEL_ACTIONS.
//
// Run directly (ue-info.cmd) -> prints what was resolved.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nearestUprojects, resolveEngine } from './ue-engine.mjs';

const IsWindows = process.platform === 'win32';

/** The UE platform of this machine — UBT's second argument and the engine's binaries folder name. */
export const HostPlatform = IsWindows ? 'Win64' : process.platform === 'darwin' ? 'Mac' : 'Linux';

/**
 * Locates the project's .uproject.
 * @param {{project?: string, cwd?: string, env?: object}} [opts] project = a .uproject file or a folder
 * @returns {{uproject: string}|{error: string}}
 */
export function locateProject({ project, cwd = process.cwd(), env = process.env } = {}) {
	const tryFrom = (start, label) => {
		const found = nearestUprojects(start);
		if (found.length === 1) return { uproject: found[0] };
		if (found.length > 1) {
			return { error: `ERROR: several .uproject files next to each other (${found.map((f) => basename(f)).join(', ')}) - pass --project <file.uproject>.` };
		}
		return { error: `ERROR: no .uproject found walking up from ${label} "${start}".` };
	};
	if (project) {
		const abs = resolve(cwd, project);
		if (abs.toLowerCase().endsWith('.uproject')) {
			return existsSync(abs) ? { uproject: abs } : { error: `ERROR: --project "${abs}" does not exist.` };
		}
		return tryFrom(abs, '--project');
	}
	const fromCwd = tryFrom(cwd, 'the current directory');
	if (fromCwd.uproject || !env.CLAUDE_PROJECT_DIR) return fromCwd;
	const fromEnv = tryFrom(env.CLAUDE_PROJECT_DIR, 'CLAUDE_PROJECT_DIR');
	return fromEnv.uproject ? fromEnv : fromCwd;
}

/**
 * The build targets a project declares: every Source/*.Target.cs with its class name minus `Target` and its
 * TargetType. Pure over the file system, no engine needed.
 * @returns {{name: string, type: string, file: string}[]}
 */
export function readTargets(projectDir) {
	const src = join(projectDir, 'Source');
	let files = [];
	try {
		files = readdirSync(src).filter((f) => f.toLowerCase().endsWith('.target.cs'));
	} catch {
		return [];
	}
	const out = [];
	for (const f of files.sort()) {
		let body = '';
		try {
			body = readFileSync(join(src, f), 'utf8');
		} catch {
			continue;
		}
		const cls = body.match(/class\s+(\w+?)Target\s*:\s*TargetRules/);
		const type = body.match(/Type\s*=\s*TargetType\.(\w+)/);
		out.push({ name: cls ? cls[1] : f.replace(/\.target\.cs$/i, ''), type: type ? type[1] : 'Unknown', file: join(src, f) });
	}
	return out;
}

/** Picks the target of one type; the conventional name wins when several are declared. */
export function pickTarget(targets, type, projectName) {
	const ofType = targets.filter((t) => t.type === type);
	const conventional = type === 'Editor' ? `${projectName}Editor` : projectName;
	return (ofType.find((t) => t.name === conventional) ?? ofType[0])?.name ?? null;
}

/**
 * Full toolchain + project resolution.
 * @param {{project?: string, cwd?: string, env?: object}} [opts]
 * @returns {{ok: true, [k: string]: any}|{ok: false, error: string}}
 */
export function resolveTools(opts = {}) {
	const env = opts.env ?? process.env;
	const located = locateProject({ ...opts, env });
	if (located.error) return { ok: false, error: located.error };
	const project = located.uproject;
	const projectDir = dirname(project);
	const name = basename(project).replace(/\.uproject$/i, '');

	const engine = resolveEngine(env, project);
	if (engine.error) return { ok: false, error: engine.error, project, projectDir, name };
	const unrealHome = engine.unrealHome;

	const batchFiles = join(unrealHome, 'Engine', 'Build', 'BatchFiles');
	const binary = (base) => join(unrealHome, 'Engine', 'Binaries', HostPlatform, IsWindows ? `${base}.exe` : base);
	const targets = readTargets(projectDir);

	// UBA estimates ~1.5 GB per compile action; editor translation units take far more, so an uncapped build
	// over-schedules and churns on "Killed process ... Low on memory". 10 suits a 32-64 GB machine; lower it
	// when the editor stays open, raise it with RAM headroom. 0 = Unreal's own default (no flag passed).
	const maxParallelActions = String(env.UE_MAX_PARALLEL_ACTIONS ?? '10').trim();

	return {
		ok: true,
		unrealHome,
		ueVersion: engine.version,
		ueVersionFrom: engine.from,
		hostPlatform: HostPlatform,
		projectDir,
		name,
		project,
		targets,
		editorTarget: pickTarget(targets, 'Editor', name),
		gameTarget: pickTarget(targets, 'Game', name),
		uat: join(batchFiles, IsWindows ? 'RunUAT.bat' : 'RunUAT.sh'),
		unrealBuild: IsWindows ? join(batchFiles, 'Build.bat') : join(batchFiles, HostPlatform, 'Build.sh'),
		// Windows only: Clean.bat is the build entry point with UBT's -Clean; elsewhere pass -Clean to Build.sh.
		unrealClean: IsWindows ? join(batchFiles, 'Clean.bat') : null,
		unrealEditor: binary('UnrealEditor'),
		unrealEditorCli: binary('UnrealEditor-Cmd'),
		maxParallelActions,
		parallelArgs: maxParallelActions && maxParallelActions !== '0' ? [`-MaxParallelActions=${maxParallelActions}`] : [],
		logsDir: join(projectDir, 'Saved', 'Logs'),
	};
}

/** Newest mtime (ms) of files under `dir` whose name matches `re`, skipping generated trees; 0 when none. */
export function newestMtime(dir, re, skip = /(^|[\\/])(Binaries|Intermediate|Saved|DerivedDataCache|\.git)([\\/]|$)/) {
	let newest = 0;
	let entries = [];
	try {
		entries = readdirSync(dir, { recursive: true, encoding: 'utf8' });
	} catch {
		return 0;
	}
	for (const rel of entries) {
		if (skip && skip.test(rel)) continue;
		if (!re.test(rel)) continue;
		try {
			const m = statSync(join(dir, rel)).mtimeMs;
			if (m > newest) newest = m;
		} catch {
			/* vanished */
		}
	}
	return newest;
}

/**
 * Stale-binaries check: is any C++ source newer than every module binary? The editor (and a test run) loads
 * the binaries, so a source edit after the last green compile means the run tests old code.
 * @returns {{stale: boolean, newestSource: number, newestBinary: number}}
 */
export function binariesStale(tools) {
	const srcRe = /\.(h|hpp|cpp|inl|cs)$/i;
	const binRe = IsWindows ? /\.dll$/i : /\.(so|dylib)$/i;
	let newestSource = newestMtime(join(tools.projectDir, 'Source'), srcRe);
	let newestBinary = newestMtime(join(tools.projectDir, 'Binaries', tools.hostPlatform), binRe, null);
	const plugins = join(tools.projectDir, 'Plugins');
	if (existsSync(plugins)) {
		let pluginEntries = [];
		try {
			pluginEntries = readdirSync(plugins, { recursive: true, encoding: 'utf8' });
		} catch {
			pluginEntries = [];
		}
		for (const rel of pluginEntries) {
			if (!/\.uplugin$/i.test(rel)) continue;
			const pdir = join(plugins, dirname(rel));
			if (!existsSync(join(pdir, 'Source'))) continue; // a binary-only plugin is nobody's compile
			newestSource = Math.max(newestSource, newestMtime(join(pdir, 'Source'), srcRe));
			newestBinary = Math.max(newestBinary, newestMtime(join(pdir, 'Binaries', tools.hostPlatform), binRe, null));
		}
	}
	return { stale: newestSource > 0 && newestSource > newestBinary, newestSource, newestBinary };
}

/** `--name value` / `--flag` parser shared by the entry points. Unknown flags land in `rest`. */
export function parseArgs(argv, spec) {
	const out = { _: [], rest: [] };
	for (const [k, v] of Object.entries(spec)) out[k] = v.default;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--') {
			out.rest.push(...argv.slice(i + 1));
			break;
		}
		const key = a.startsWith('--') ? a.slice(2) : null;
		const def = key ? spec[key] : null;
		if (def) {
			if (def.type === 'bool') out[key] = true;
			else out[key] = argv[++i];
		} else if (a.startsWith('-')) out.rest.push(a);
		else out._.push(a);
	}
	return out;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
	const args = parseArgs(process.argv.slice(2), { project: {}, help: { type: 'bool' } });
	if (args.help) {
		console.log('usage: ue-info.cmd [--project <file.uproject|dir>]  - prints the resolved project, targets and engine');
		process.exit(0);
	}
	const t = resolveTools({ project: args.project });
	if (!t.ok) {
		console.log(t.error);
		process.exit(1);
	}
	console.log(`Project        : ${t.project}`);
	console.log(`Targets        : ${t.targets.map((x) => `${x.name} (${x.type})`).join(', ') || '(none - no Source/*.Target.cs)'}`);
	console.log(`Editor target  : ${t.editorTarget ?? '-'}`);
	console.log(`Game target    : ${t.gameTarget ?? '-'}`);
	console.log(`Engine         : ${t.unrealHome}  (UE ${t.ueVersion}, from ${t.ueVersionFrom})`);
	console.log(`Platform       : ${t.hostPlatform}`);
	console.log(`MaxParallel    : ${t.maxParallelActions} (UE_MAX_PARALLEL_ACTIONS)`);
}
