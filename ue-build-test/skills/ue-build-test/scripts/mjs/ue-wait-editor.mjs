// ue-wait-editor — waits until this project's editor is up, and says WHY when it is not.
//
// Usage: ue-wait-editor.cmd [--project p] [--timeout s] [--port N] [--log file]
//   ready = the editor's log (written after this editor started) contains "Engine is initialized", or, with
//   --port, that TCP port on 127.0.0.1 accepts a connection (an MCP server inside the editor).
//   log default: Saved/Logs/<Name>-Headless.log when a headless editor of this project runs, else <Name>.log.
//
// Answers: READY (exit 0); DEAD - no editor of this project runs (crashed or never started; exit 1);
// TIMEOUT with a diagnosis from log growth (exit 1): a log still growing = still working, give it time;
// a log quiet for 60 s+ = standing on a modal dialog — do not relaunch, a second instance only takes the
// resource; tell the person which window hangs.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { editorsOfProject } from './ue-proc.mjs';
import { locateProject, parseArgs } from './ue-tools.mjs';

export const ReadyMarker = 'Engine is initialized';

function portOpen(port, ms = 1000) {
	return new Promise((done) => {
		const s = connect({ host: '127.0.0.1', port, timeout: ms });
		const end = (v) => {
			s.destroy();
			done(v);
		};
		s.on('connect', () => end(true));
		s.on('timeout', () => end(false));
		s.on('error', () => end(false));
	});
}

/** Ready by log: the marker is present AND the log was written after the editor started (not a stale log). Pure-ish. */
export function logSaysReady(logPath, editorStartMs) {
	if (!existsSync(logPath)) return false;
	const st = statSync(logPath);
	if (editorStartMs && st.mtimeMs + 2000 < editorStartMs) return false;
	return readFileSync(logPath, 'utf8').includes(ReadyMarker);
}

async function main() {
	const args = parseArgs(process.argv.slice(2), { project: {}, timeout: { default: '180' }, port: {}, log: {}, help: { type: 'bool' } });
	if (args.help) {
		console.log('usage: ue-wait-editor.cmd [--project p] [--timeout s] [--port N] [--log file]');
		return 0;
	}
	const loc = locateProject({ project: args.project });
	if (loc.error) {
		console.log(loc.error);
		return 1;
	}
	const projectDir = dirname(loc.uproject);
	const name = loc.uproject.replace(/^.*[\\/]/, '').replace(/\.uproject$/i, '');
	const timeout = Number(args.timeout) || 180;
	const port = args.port ? Number(args.port) : null;
	const started = Date.now();
	let lastSize = -1;
	let quietSince = Date.now();

	for (let tick = 0; ; tick++) {
		const e = editorsOfProject(projectDir);
		const logPath = args.log ?? join(projectDir, 'Saved', 'Logs', e.headless.length ? `${name}-Headless.log` : `${name}.log`);
		const startMs = Math.max(0, ...[...e.start.values()].filter((v) => typeof v === 'number'));
		if (port ? await portOpen(port) : logSaysReady(logPath, startMs)) {
			console.log(`READY after ${Math.round((Date.now() - started) / 1000)}s${port ? ` (port ${port})` : ` (${logPath})`}`);
			return 0;
		}
		if (tick >= 5 && e.precise && e.pids.length === 0 && e.opaque === 0) {
			console.log(`DEAD: no editor of this project is running - it crashed or never started. Read ${logPath} (ue-tail-log.cmd).`);
			return 1;
		}
		let size = 0;
		try {
			size = statSync(logPath).size;
		} catch {
			size = 0;
		}
		if (size !== lastSize) {
			lastSize = size;
			quietSince = Date.now();
		}
		if (Date.now() - started >= timeout * 1000) {
			const quiet = Math.round((Date.now() - quietSince) / 1000);
			console.log(`TIMEOUT after ${timeout}s; ${logPath} has not grown for ${quiet}s.`);
			console.log(quiet >= 60 ? 'The editor stands on a modal dialog - do not relaunch it; tell the person which window hangs.' : 'The editor is still working (shaders, DDC) - give it more time.');
			return 1;
		}
		await sleep(2000);
	}
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) process.exit(await main());
