// SubagentStart: tells every subagent where THIS machine's Unreal Engine lives (and which project it works in),
// so engine readers search the right tree on any machine instead of guessing a drive letter.
//
// The root comes from ue-engine.mjs: UNREAL_HOME, else the version (UE_VERSION / the .uproject's
// EngineAssociation) looked up in the installer's record. Fail-open: nothing found -> nothing said; a subagent's
// instructions should say to report a missing engine root, never to guess one.

import { readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addContext, readPayload } from './hook-io.mjs';
import { engineVersion, projectInfo, resolveEngine } from '../scripts/mjs/ue-engine.mjs';

/** "5.8" read from Engine/Build/Build.version (exact for UNREAL_HOME and source builds), else null. */
function buildVersion(unrealHome) {
	try {
		const v = JSON.parse(readFileSync(join(unrealHome, 'Engine', 'Build', 'Build.version'), 'utf8'));
		return `${v.MajorVersion}.${v.MinorVersion}.${v.PatchVersion}`;
	} catch {
		return null;
	}
}

/** PURE-ish: the context line, or '' when the engine is not found. */
export function engineContext(start, env = process.env) {
	const engine = resolveEngine(env, start);
	if (!engine.unrealHome) return '';
	const version = buildVersion(engine.unrealHome) ?? engineVersion(env, start).version;
	const project = projectInfo(start, env);
	return `Unreal Engine ${version} root on this machine: ${engine.unrealHome} (engine source under Engine/Source, engine plugins under Engine/Plugins).`
		+ (project ? ` Project: ${project.uproject}.` : '');
}

function main() {
	const payload = readPayload();
	const start = process.env.CLAUDE_PROJECT_DIR || payload?.cwd || process.cwd();
	const text = engineContext(start);
	if (text) addContext('SubagentStart', text);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
