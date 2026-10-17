// unbuilt-cpp.mjs — do not let a session finish with C++ it edited but never built.
//
//   PostToolUse (Edit|Write|MultiEdit)  remember each project C++ source this session wrote
//   Stop                                 any of them newer than its module's editor DLL -> exit 2, the list on stderr
//
// Only this session's files count, so a person's unbuilt work does not hold the agent. A module counts as built when
// its UnrealEditor-<Module>*.dll in <owner>/Binaries/<Platform>/ is newer than the file (UBT relinks the DLL whenever
// an object of it was recompiled). A file outside a module (no /Source/<Module>/ in its path) is ignored.
// ONE reminder per state of the edits: once a list was reported, the same files at the same times stay silent —
// the person may have said "do not build", or a header nothing includes leaves the DLL as it is. A new edit (or a
// new file) reminds again. Off with UE_BT_STOP_CHECK=0. Fails open on anything unreadable.

import { appendFileSync, existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CppExt = /\.(h|hh|hpp|hxx|inl|ipp|c|cc|cpp|cxx)$/i;
const Generated = /\/(Binaries|Intermediate|Saved|DerivedDataCache|\.vs|ThirdParty)\//i;
const Platform = process.platform === 'win32' ? 'Win64' : process.platform === 'darwin' ? 'Mac' : 'Linux';
const LibExt = process.platform === 'win32' ? '.dll' : process.platform === 'darwin' ? '.dylib' : '.so';

/** PURE: the module a project source belongs to — {owner: dir holding Source/, name} — or null. */
export function moduleOf(path) {
	const p = String(path).replace(/\\/g, '/');
	if (!CppExt.test(p) || Generated.test(p)) return null;
	const m = p.match(/^(.*)\/Source\/([^/]+)\/.+$/);
	return m ? { owner: m[1], name: m[2] } : null;
}

/** Newest editor binary of the module (ms epoch), 0 when it was never built. */
export function moduleBuiltAt(mod) {
	const dir = join(mod.owner, 'Binaries', Platform);
	const prefix = `unrealeditor-${mod.name.toLowerCase()}`;
	let newest = 0;
	let names = [];
	try {
		names = readdirSync(dir);
	} catch {
		return 0;
	}
	for (const n of names) {
		const l = n.toLowerCase();
		if ((l === `${prefix}${LibExt}` || (l.startsWith(`${prefix}-`) && l.endsWith(LibExt))) && !l.endsWith(`-debuggame${LibExt}`)) {
			newest = Math.max(newest, statSync(join(dir, n)).mtimeMs);
		}
	}
	return newest;
}

/** Files of `paths` that are newer than their module's binary (or whose module was never built). */
export function unbuilt(paths) {
	const out = [];
	for (const path of new Set(paths)) {
		const mod = moduleOf(path);
		if (!mod || !existsSync(path)) continue;
		if (statSync(path).mtimeMs > moduleBuiltAt(mod)) out.push(path);
	}
	return out;
}

const listFile = (sid) => join(tmpdir(), `ue-build-test-edits-${String(sid).replace(/[^\w-]/g, '')}.txt`);
const toldFile = (sid) => `${listFile(sid).slice(0, -4)}.told.txt`;

/** The state of the stale files — their paths and modification times — as one string. */
export function staleKey(paths) {
	return [...paths].sort().map((p) => { try { return `${p}|${statSync(p).mtimeMs}`; } catch { return p; } }).join('\n');
}

function main() {
	if (process.env.UE_BT_STOP_CHECK === '0') return;
	let payload;
	try {
		payload = JSON.parse(readFileSync(0, 'utf8'));
	} catch {
		return;
	}
	const sid = payload.session_id;
	if (!sid) return;

	if (payload.hook_event_name === 'Stop' || payload.hook_event_name === 'SubagentStop') {
		if (payload.stop_hook_active) return; // already sent back once this turn: let it end, the agent reported
		let edited = [];
		try {
			edited = readFileSync(listFile(sid), 'utf8').split(/\r?\n/).filter(Boolean);
		} catch {
			return;
		}
		const stale = unbuilt(edited);
		if (!stale.length) return;
		const key = staleKey(stale);
		let told = '';
		try { told = readFileSync(toldFile(sid), 'utf8'); } catch { /* never reported */ }
		if (told === key) return; // reported already, nothing changed since: the agent answered for it
		try { writeFileSync(toldFile(sid), key); } catch { /* fail open: remind again next time */ }
		process.stderr.write(
			'unbuilt-cpp: C++ this session edited is newer than its built module:\n' +
				stale.map((p) => `- ${p}`).join('\n') +
				"\nBuild it the way the project prescribes (ue-build-test: ue-compile.cmd) and fix every error before finishing. " +
				'If the build is impossible right now (an editor holds the DLLs, another build runs) or the person said not to ' +
				'build, say so explicitly - this reminder is not repeated until these files change again. ' +
				'Off on this machine: UE_BT_STOP_CHECK=0.\n',
		);
		process.exit(2);
	}

	const path = payload.tool_input?.file_path;
	if (path && moduleOf(path)) appendFileSync(listFile(sid), `${path}\n`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
