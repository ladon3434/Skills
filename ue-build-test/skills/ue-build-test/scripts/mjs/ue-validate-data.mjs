// ue-validate-data — run the DataValidation commandlet (Tools > Validate Project Data, headless) and sum up.
//
// Every asset's IsDataValid and every UEditorValidatorBase validator run over the project's content. Exit codes of
// the commandlet (UE 5.8, DataValidationCommandlet.cpp): 0 clean, 2 data validation errors, 1 = some OTHER system
// logged an error during the run (the engine turns any logged error into 1) — that is reported, not counted as a
// data failure.
//
// Same gates as ue-test: refuses next to an editor of this project, waits for what is not ours (ue-owner), and
// warns when sources are newer than the binaries (validators in C++ would run old code).
// Usage: ue-validate-data.cmd [--asset-type <Class>] [--project p] [--wait s] [--timeout min] [--dry-run]
// Ends with: RESULT: validation <OK|FAILED|DEFERRED|DRY-RUN> (exit N)

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exitWith, gate, gatePlan, renderCommand, Verdict } from './ue-gate.mjs';
import { editorsOfProject } from './ue-proc.mjs';
import { binariesStale, parseArgs, resolveTools } from './ue-tools.mjs';

const Kind = 'validation';

/**
 * What the commandlet log says. Pure over the text. Findings are the message-log lines `AssetCheck: Error: …` /
 * `AssetCheck: Warning: …` (and Log*Validation errors); the run finished when the validator summary
 * `LogContentValidation: Validated asset counts for N validators` is there (the "Successfully finished" line is
 * logged at Log verbosity and usually absent).
 */
export function parseValidationLog(text) {
	const errors = [];
	const warnings = [];
	let finished = false;
	let failedBanner = false;
	let validators = 0;
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.replace(/^\[[\d.\-:]+\]\[\s*\d+\]/, '');
		let m = line.match(/^LogContentValidation: Validated asset counts for (\d+) validators/);
		if (m || /LogDataValidation: Successfully finished running/.test(line)) {
			finished = true;
			if (m) validators = Number(m[1]);
			continue;
		}
		if (/LogDataValidation: Warning: Errors occurred while validating data/.test(line)) {
			failedBanner = true;
			continue;
		}
		m = line.match(/^(?:AssetCheck|Log(?:Content|Data)Validation): (Error|Warning): (.*)$/);
		if (m) (m[1] === 'Error' ? errors : warnings).push(m[2].trim());
	}
	return { errors: [...new Set(errors)], warnings: [...new Set(warnings)], finished, failedBanner, validators };
}

async function main() {
	const args = parseArgs(process.argv.slice(2), {
		project: {},
		'asset-type': {},
		wait: { default: '600' },
		timeout: { default: '30' },
		'dry-run': { type: 'bool' },
		help: { type: 'bool' },
	});
	if (args.help) {
		console.log('usage: ue-validate-data.cmd [--asset-type <Class>] [--project p] [--wait s] [--timeout min] [--dry-run]');
		console.log('  log: <project>/Saved/Logs/DataValidation.log');
		process.exit(0); // verdict-exempt: help
	}
	const dry = Boolean(args['dry-run']);
	const wait = Number(args.wait);
	const timeoutMin = Number(args.timeout);
	if (!Number.isFinite(wait) || !Number.isFinite(timeoutMin) || timeoutMin <= 0) exitWith(Kind, Verdict.Failed, 2);

	const tools = resolveTools({ project: args.project });
	if (!tools.ok) {
		console.log(tools.error);
		exitWith(Kind, Verdict.Failed, 1);
	}
	const logPath = join(tools.logsDir, 'DataValidation.log');
	if (/\s/.test(logPath)) {
		console.log(`ERROR: the log path has a space: "${logPath}" - the editor ignores -ABSLOG= then.`);
		exitWith(Kind, Verdict.Failed, 2);
	}
	const editorArgs = [
		tools.project,
		'-run=DataValidation',
		...(args['asset-type'] ? [`-AssetType=${args['asset-type']}`] : []),
		'-unattended',
		'-nopause',
		'-nosplash',
		'-nullrhi',
		'-nosound',
		'-NoShaderCompile',
		'-SCCProvider=None',
		`-ABSLOG=${logPath}`,
		...args.rest,
	];

	console.log(`Project : ${tools.project}`);
	const blockers = [];
	const editors = editorsOfProject(tools.projectDir);
	if (editors.gui.length) blockers.push(`a GUI editor of this project is open (pid ${editors.gui.join(', ')}): validate in it (Tools > Validate Project Data), or ask the person to close it.`);
	if (editors.headless.length) blockers.push(`a headless editor of this project runs (pid ${editors.headless.join(', ')}). If this session started it, stop it with ue-stop-editor.cmd (separate tool call); otherwise wait for its owner.`);
	if (binariesStale(tools).stale) console.log('WARNING: C++ sources are newer than the module binaries - C++ validators would run OLD code. Build first (ue-compile.cmd).');

	if (dry) {
		for (const b of blockers) console.log(`WOULD DEFER: ${b}`);
		console.log('Gate    :');
		for (const l of gatePlan('launch', { wait })) console.log(`  ${l}`);
		console.log(`Log     : ${logPath}`);
		console.log(`Command : ${renderCommand(tools.unrealEditorCli, editorArgs)}`);
		exitWith(Kind, Verdict.DryRun, 0);
	}
	if (blockers.length) {
		for (const b of blockers) console.log(`DEFERRED: ${b}`);
		console.log('Nothing was validated.');
		exitWith(Kind, Verdict.Deferred, 1);
	}
	const owner = gate('launch', tools.projectDir, { wait });
	if (!owner.ok) {
		console.log(`DEFERRED: ${owner.reason}`);
		console.log('Nothing was validated. An editor or a build this session did not start is not ours: wait or ask, never stop it.');
		exitWith(Kind, Verdict.Deferred, 1);
	}

	mkdirSync(tools.logsDir, { recursive: true });
	if (existsSync(logPath)) writeFileSync(logPath, ''); // an earlier run's log must not be read as this one's
	console.log(`Running the DataValidation commandlet (one-shot headless, minutes)... log: ${logPath}`);
	const started = Date.now();
	const code = await new Promise((done) => {
		const child = spawn(tools.unrealEditorCli, editorArgs, { stdio: 'ignore', windowsHide: true, cwd: tools.projectDir });
		const timer = setTimeout(() => {
			console.log(`ERROR: no exit after ${timeoutMin} min - killing this run's own commandlet (pid ${child.pid}).`);
			child.kill();
			done(null);
		}, timeoutMin * 60 * 1000);
		child.on('error', (e) => {
			clearTimeout(timer);
			console.log(`ERROR: could not start ${tools.unrealEditorCli}: ${e.message}`);
			done(1);
		});
		child.on('close', (c) => {
			clearTimeout(timer);
			done(c ?? 1);
		});
	});
	const seconds = Math.round((Date.now() - started) / 1000);
	const log = parseValidationLog(existsSync(logPath) ? readFileSync(logPath, 'utf8') : '');
	console.log(`Commandlet exit ${code ?? 'timeout'}, ${seconds}s; validator errors ${log.errors.length}, warnings ${log.warnings.length}`);
	for (const e of log.errors.slice(0, 40)) console.log(`ERROR   ${e.slice(0, 220)}`);
	for (const w of log.warnings.slice(0, 20)) console.log(`WARNING ${w.slice(0, 220)}`);
	if (code === 0 && log.finished) {
		console.log('Project data is valid.');
		exitWith(Kind, Verdict.Ok, 0);
	}
	if (code === 1 && log.finished && !log.errors.length) {
		console.log('Data validation passed; exit 1 comes from an error another system logged during the run - read the log, it is not a data failure.');
		exitWith(Kind, Verdict.Ok, 0);
	}
	if (code === 2 || log.failedBanner) console.log('Data validation found errors.');
	else console.log(`The commandlet did not finish cleanly${log.finished ? '' : ' (no validator summary in the log)'}.`);
	console.log(`Full log: ${logPath}`);
	exitWith(Kind, Verdict.Failed, 1);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) await main();
