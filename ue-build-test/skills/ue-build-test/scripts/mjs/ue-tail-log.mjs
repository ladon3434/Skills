// ue-tail-log — the tail of this project's editor log, optionally filtered, without re-deriving its path.
//
// Usage: ue-tail-log.cmd [pattern] [lines=40] [--project p] [--tests | --headless | --file <log>]
//   default log  Saved/Logs/<Name>.log (a GUI editor's; with a GUI open, a second editor writes <Name>_2.log)
//   --tests      Saved/Logs/<Name>-Tests.log  (ue-test.cmd's own log; UE_TEST_LOG_DIR moves it)
//   --headless   Saved/Logs/<Name>-Headless.log (ue-run-editor-headless.cmd's own log)
//   pattern      case-insensitive regex (plain substring when it is not a valid regex)
// For a big log to triage, hand it to the log-triage agent instead of reading it in the main context.

import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { locateProject, parseArgs } from './ue-tools.mjs';

const args = parseArgs(process.argv.slice(2), { project: {}, tests: { type: 'bool' }, headless: { type: 'bool' }, file: {}, help: { type: 'bool' } });
if (args.help) {
	console.log('usage: ue-tail-log.cmd [pattern] [lines=40] [--project p] [--tests | --headless | --file <log>]');
	process.exit(0);
}
let log = args.file;
if (!log) {
	const loc = locateProject({ project: args.project });
	if (loc.error) {
		console.error(loc.error);
		process.exit(1);
	}
	const name = basename(loc.uproject).replace(/\.uproject$/i, '');
	const logs = join(dirname(loc.uproject), 'Saved', 'Logs');
	if (args.tests) log = join(process.env.UE_TEST_LOG_DIR || logs, `${name}-Tests.log`);
	else if (args.headless) log = join(logs, `${name}-Headless.log`);
	else log = join(logs, `${name}.log`);
}
if (!existsSync(log)) {
	console.error(`ERROR: ${log} not found - that editor/run has not written it yet.`);
	process.exit(1);
}

const pattern = args._[0] ?? '';
const lines = Number.parseInt(args._[1] ?? '', 10) || 40;
let out = readFileSync(log, 'utf8').split(/\r?\n/);
if (out.length && out[out.length - 1] === '') out.pop();
if (pattern) {
	let re = null;
	try {
		re = new RegExp(pattern, 'i');
	} catch {
		re = null;
	}
	out = out.filter((l) => (re ? re.test(l) : l.toLowerCase().includes(pattern.toLowerCase())));
}
out = out.slice(-lines);
console.log(`== ${log} (${out.length} line(s)${pattern ? `, /${pattern}/i` : ''})`);
if (out.length) process.stdout.write(out.join('\n') + '\n');
