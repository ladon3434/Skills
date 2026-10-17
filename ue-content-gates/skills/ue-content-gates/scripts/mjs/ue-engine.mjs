// ue-engine.mjs — finds the Unreal Engine install and the project. ONE file, copied byte for byte into every plugin
// that needs it (plugins are self-contained); the master is ue-workstation/skills/ue-workstation/scripts/mjs/ and
// skill-lint fails when a copy differs. Change the master, then copy it.
//
// Resolution order:
//   1. UNREAL_HOME, when it exists on disk and has an Engine folder.
//   2. The engine version: EngineAssociation of the project's .uproject (passed in, else the first found walking up
//      from the given folder, then from CLAUDE_PROJECT_DIR) — the project is authoritative — else UE_VERSION, else
//      DefaultVersion below.
//   3. Where the installer registered that version — the Epic registry key on Windows, the Launcher manifest
//      on macOS. No hardcoded-path guess: a wrong guess misreports where the engine «is».
// A source build (EngineAssociation is a GUID) is not in the registry key: set UNREAL_HOME.
//
// `at` below is a folder to search from or a .uproject itself; it defaults to the current directory.

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DefaultVersion = '5.8';
const IsWindows = process.platform === 'win32';

/** Every .uproject in the nearest folder holding one, walking up from `start`; [] when there is none. */
export function nearestUprojects(start = process.cwd()) {
	let dir = resolve(start);
	for (;;) {
		let hits;
		try {
			hits = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.uproject'));
		} catch {
			hits = [];
		}
		if (hits.length) return hits.map((h) => join(dir, h));
		const up = dirname(dir);
		if (up === dir) return [];
		dir = up;
	}
}

/** The .uproject nearest to `start`, walking up; null when there is none. */
export function findUproject(start = process.cwd()) {
	return nearestUprojects(start)[0] ?? null;
}

/** The project .uproject: nearest walking up from `start`, else from CLAUDE_PROJECT_DIR; null when neither has one. */
export function findProjectUproject(start = process.cwd(), env = process.env) {
	return findUproject(start) ?? (env.CLAUDE_PROJECT_DIR ? findUproject(env.CLAUDE_PROJECT_DIR) : null);
}

/** {uproject, root, name} of the project, or null. */
export function projectInfo(start = process.cwd(), env = process.env) {
	const uproject = findProjectUproject(start, env);
	if (!uproject) return null;
	return { uproject, root: dirname(uproject), name: basename(uproject).replace(/\.uproject$/i, '') };
}

/** The UBT platform word of this machine. */
export function hostPlatform() {
	return IsWindows ? 'Win64' : process.platform === 'darwin' ? 'Mac' : 'Linux';
}

/** UnrealBuildTool executable under an engine root (the file may be missing on a broken install). */
export function ubtPath(unrealHome) {
	return join(unrealHome, 'Engine', 'Binaries', 'DotNET', 'UnrealBuildTool', IsWindows ? 'UnrealBuildTool.exe' : 'UnrealBuildTool');
}

/** EngineAssociation of a .uproject, or null when unreadable. */
export function engineAssociation(uproject) {
	try {
		const assoc = JSON.parse(readFileSync(uproject, 'utf8')).EngineAssociation;
		return typeof assoc === 'string' ? assoc : null;
	} catch {
		return null;
	}
}

/** The .uproject `at` names: itself when it is one, else the project found from that folder. */
function uprojectAt(at, env) {
	if (!at) return findProjectUproject(process.cwd(), env);
	return String(at).toLowerCase().endsWith('.uproject') ? resolve(at) : findProjectUproject(at, env);
}

/** The engine version this run targets, and where that answer came from. */
export function engineVersion(env = process.env, at = process.cwd()) {
	const uproject = uprojectAt(at, env);
	const assoc = uproject ? engineAssociation(uproject) : null;
	if (assoc && /^\d+\.\d+$/.test(assoc)) return { version: assoc, from: uproject };
	if (env.UE_VERSION) return { version: env.UE_VERSION, from: 'UE_VERSION' };
	return { version: DefaultVersion, from: 'default' };
}

/** InstalledDirectory out of the Epic registry key (Windows); null when absent. */
function queryRegistry(version) {
	let out;
	try {
		out = execFileSync(
			'reg',
			['query', `HKLM\\SOFTWARE\\EpicGames\\Unreal Engine\\${version}`, '/v', 'InstalledDirectory'],
			{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
		);
	} catch {
		return null;
	}
	const match = out.match(/InstalledDirectory\s+REG_\w+\s+(.+)/);
	return match ? match[1].trim() : null;
}

/**
 * The macOS counterpart: LauncherInstalled.dat. Matched on ArtifactId `UE_<version>`, not on the location —
 * the Launcher lists plugins it installed INTO the engine folder under that same location.
 */
function queryLauncherManifest(version) {
	const manifest = join(homedir(), 'Library', 'Application Support', 'Epic', 'UnrealEngineLauncher', 'LauncherInstalled.dat');
	let parsed;
	try {
		parsed = JSON.parse(readFileSync(manifest, 'utf8'));
	} catch {
		return null;
	}
	const rows = Array.isArray(parsed?.InstallationList) ? parsed.InstallationList : [];
	const engine = rows.find((r) => r?.ArtifactId === `UE_${version}` && typeof r?.InstallLocation === 'string');
	return engine ? engine.InstallLocation : null;
}

/** @returns {{unrealHome: string, version: string, from: string}|{error: string}} */
export function resolveEngine(env = process.env, at = process.cwd()) {
	const { version, from } = engineVersion(env, at);
	if (env.UNREAL_HOME && existsSync(join(env.UNREAL_HOME, 'Engine'))) {
		return { unrealHome: env.UNREAL_HOME, version, from: 'UNREAL_HOME' };
	}
	const installed = IsWindows ? queryRegistry(version) : queryLauncherManifest(version);
	if (!installed) {
		const where = IsWindows
			? `registry key "HKLM\\SOFTWARE\\EpicGames\\Unreal Engine\\${version}" has no InstalledDirectory`
			: `the Epic Launcher manifest has no UE_${version} row`;
		return { error: `ERROR: Unreal Engine ${version} (from ${from}) not found - ${where}, and UNREAL_HOME is not set.` };
	}
	if (!existsSync(join(installed, 'Engine'))) {
		return { error: `ERROR: "${installed}" (from the installer's record) has no Engine folder - broken install?` };
	}
	return { unrealHome: installed, version, from };
}

// Run directly -> print what was resolved.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
	const { version, from } = engineVersion();
	const r = resolveEngine();
	console.log(`Engine version : ${version} (${from})`);
	console.log(r.error ? r.error : `Unreal Home    : ${r.unrealHome}`);
	const p = projectInfo();
	console.log(`Project        : ${p ? p.uproject : '(no .uproject above the current directory or CLAUDE_PROJECT_DIR)'}`);
	process.exit(r.error ? 1 : 0);
}
