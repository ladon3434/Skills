// ue-test-log.mjs — reads an automation run's log into a verdict. Pure functions + a CLI for a saved log.
//
// The automation controller writes, per test (AutomationControllerManager.cpp):
//   LogAutomationController: Display: Test Started. Name={N} Path={Suite.Sub.N}
//   LogAutomationController: Display|Error: Test Completed. Result={Success|Fail|Skipped|Not Run} Name={N} Path={P}
//   LogAutomationController: BeginEvents: P   ...the test's Error/Warning/Info entries...   EndEvents: P
// and at the end of a -TestExit run:
//   LogAutomationCommandLine: Display: ...Automation Test Queue Empty N tests performed.
//   LogAutomationCommandLine: Display: **** TEST COMPLETE. EXIT CODE: 0|-1 ****
//
// Why the log and not the exit code alone:
//   - a cold boot after a rebuild can run RunTests before late-registering (editor-module / plugin) tests
//     exist: a subset runs, the queue empties, exit 0 — a silent under-run. Coverage per filter token catches it.
//   - a quarantined (known-flaky) test must still run but not decide the verdict; only per-test results
//     can separate it from the rest.
//   - a crash mid-run leaves a started test with no result and no TEST COMPLETE line.
//
//   node ue-test-log.mjs <log> <filter> [--quarantine <json>]   -> prints the analysis, exit 0 ok / 1 not ok

import { existsSync, readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** @returns {{started: string[], results: Map<string,string>, events: Map<string,string[]>, complete: boolean, exitMarker: number|null, performed: number|null}} */
export function parseRunLog(text) {
	const started = [];
	const results = new Map();
	const events = new Map();
	let current = null;
	let complete = false;
	let exitMarker = null;
	let performed = null;
	for (const line of String(text).split(/\r?\n/)) {
		let m;
		if ((m = line.match(/Test Started\. Name=\{[^}]*\} Path=\{([^}]+)\}/))) {
			if (!started.includes(m[1])) started.push(m[1]);
		} else if ((m = line.match(/Test Completed\. Result=\{([^}]*)\} Name=\{[^}]*\} Path=\{([^}]+)\}/))) {
			results.set(m[2], m[1]);
		} else if ((m = line.match(/LogAutomationController: BeginEvents: (.+?)\s*$/))) {
			current = m[1];
			if (!events.has(current)) events.set(current, []);
		} else if ((m = line.match(/LogAutomationController: EndEvents: /))) {
			current = null;
		} else if (current && /LogAutomationController: (Error|Warning): /.test(line)) {
			events.get(current).push(line.replace(/^.*?LogAutomationController: /, '').trim());
		} else if ((m = line.match(/Automation Test Queue Empty (\d+) tests performed/))) {
			performed = Number(m[1]);
		} else if ((m = line.match(/\*\*\*\* TEST COMPLETE\. EXIT CODE: (-?\d+) \*\*\*\*/))) {
			complete = true;
			exitMarker = Number(m[1]);
		}
	}
	return { started, results, events, complete, exitMarker, performed };
}

const startsWithCI = (path, token) => path.toLowerCase().startsWith(token.toLowerCase());

/** Filter tokens that selected ZERO tests in this run. Pure. */
export function missingTokens(run, filter) {
	const ran = new Set([...run.started, ...run.results.keys()]);
	const tokens = String(filter).split('+').map((t) => t.trim()).filter(Boolean);
	return tokens.filter((tok) => ![...ran].some((p) => startsWithCI(p, tok)));
}

/**
 * Validates the quarantine file's entries: {token, reason, since} — a token without a reason and a date is an
 * eternal, ownerless exemption, which is exactly what quarantine must not become.
 * @returns {{entries: {token: string, reason: string, since: string}[], problems: string[]}}
 */
export function readQuarantine(json) {
	const problems = [];
	const list = Array.isArray(json?.quarantined) ? json.quarantined : [];
	const entries = [];
	for (const e of list) {
		if (!e || typeof e.token !== 'string' || !e.token.trim()) {
			problems.push(`entry without a token: ${JSON.stringify(e)}`);
			continue;
		}
		if (!e.reason || !e.since) problems.push(`${e.token}: needs "reason" and "since" (YYYY-MM-DD)`);
		entries.push({ token: e.token.trim(), reason: String(e.reason ?? ''), since: String(e.since ?? '') });
	}
	return { entries, problems };
}

/** Loads a quarantine file; absent file = empty quarantine. */
export function loadQuarantine(file) {
	if (!file || !existsSync(file)) return { entries: [], problems: [] };
	try {
		return readQuarantine(JSON.parse(readFileSync(file, 'utf8')));
	} catch (e) {
		return { entries: [], problems: [`${file}: not valid JSON (${e.message})`] };
	}
}

/** Is this test path quarantined? A token matches by prefix, the way RunTests filters. Pure. */
export function isQuarantined(path, entries) {
	return entries.some((e) => startsWithCI(path, e.token));
}

/**
 * Splits a parsed run into what gates the verdict and what does not. Pure.
 * failed      — Result={Fail} outside quarantine (gates)
 * incomplete  — started, never completed (crash / hang) outside quarantine (gates)
 * quarantined — failed or incomplete inside quarantine (reported, never gates)
 */
export function classify(run, entries) {
	const failed = [];
	const incomplete = [];
	const quarantined = [];
	let passed = 0;
	let skipped = 0;
	for (const [path, result] of run.results) {
		if (result === 'Success') passed++;
		else if (result === 'Fail') (isQuarantined(path, entries) ? quarantined : failed).push(path);
		else skipped++;
	}
	for (const path of run.started) {
		if (run.results.has(path)) continue;
		(isQuarantined(path, entries) ? quarantined : incomplete).push(path);
	}
	return { passed, skipped, failed, incomplete, quarantined };
}

/**
 * The verdict of one run. Pure.
 * @param {{exitCode: number, run: object, filter: string, entries: object[]}} o
 * @returns {{ok: boolean, retryable: boolean, reasons: string[], cls: object, missing: string[]}}
 */
export function judgeRun({ exitCode, run, filter, entries }) {
	const cls = classify(run, entries);
	const missing = missingTokens(run, filter);
	const reasons = [];
	if (!run.complete) reasons.push('the run never reached "TEST COMPLETE" - the editor crashed, hung or quit early');
	if (cls.failed.length) reasons.push(`${cls.failed.length} test(s) failed`);
	if (cls.incomplete.length) reasons.push(`${cls.incomplete.length} test(s) started and never finished: ${cls.incomplete.join(', ')}`);
	const onlyQuarantineFailed = exitCode !== 0 && run.complete && !cls.failed.length && !cls.incomplete.length && cls.quarantined.length > 0;
	if (exitCode !== 0 && !onlyQuarantineFailed && !cls.failed.length && !cls.incomplete.length) reasons.push(`the editor exited ${exitCode} with no failing test in the log`);
	if (missing.length) reasons.push(`0 tests ran for filter token(s): ${missing.join(', ')}`);
	// A coverage under-run on an otherwise clean, complete run is the cold-boot discovery race: retry warm once.
	const retryable = missing.length > 0 && run.complete && !cls.failed.length && !cls.incomplete.length;
	return { ok: reasons.length === 0, retryable, reasons, cls, missing };
}

/** Lines to print for each gating failure: the test path and its first error entries. Pure. */
export function failureReport(run, paths, perTest = 3) {
	const out = [];
	for (const p of paths) {
		out.push(`FAIL ${p}`);
		for (const e of (run.events.get(p) ?? []).filter((l) => l.startsWith('Error')).slice(0, perTest)) out.push(`     ${e}`);
	}
	return out;
}

export function selftest() {
	const fail = [];
	const eq = (a, b, m) => {
		if (JSON.stringify(a) !== JSON.stringify(b)) fail.push(`${m}: got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`);
	};
	const L = (s) => `LogAutomationController: Display: ${s}`;
	const E = (s) => `LogAutomationController: Error: ${s}`;
	const log = [
		'LogInit: Display: Engine is initialized. Leaving FEngineLoop::Init()',
		L('Test Started. Name={Add} Path={Game.Inventory.Add}'),
		L('Test Completed. Result={Success} Name={Add} Path={Game.Inventory.Add}'),
		'LogAutomationController: BeginEvents: Game.Inventory.Add',
		'LogAutomationController: EndEvents: Game.Inventory.Add',
		L('Test Started. Name={Remove} Path={Game.Inventory.Remove}'),
		E('Test Completed. Result={Fail} Name={Remove} Path={Game.Inventory.Remove}'),
		'LogAutomationController: BeginEvents: Game.Inventory.Remove',
		E("Expected 'Count' to be 0, but it was 1. [InventoryTests.cpp(88)]"),
		'LogAutomationController: EndEvents: Game.Inventory.Remove',
		L('Test Started. Name={Timing} Path={Net.Flaky.Timing}'),
		E('Test Completed. Result={Fail} Name={Timing} Path={Net.Flaky.Timing}'),
		'LogAutomationCommandLine: Display: ...Automation Test Queue Empty 3 tests performed.',
		'LogAutomationCommandLine: Display: **** TEST COMPLETE. EXIT CODE: -1 ****',
	].join('\r\n');
	const run = parseRunLog(log);
	eq(run.started.length, 3, 'three tests started');
	eq(run.results.get('Game.Inventory.Remove'), 'Fail', 'the failure is read');
	eq(run.complete, true, 'TEST COMPLETE seen');
	eq(run.exitMarker, -1, 'exit marker read');
	eq(run.performed, 3, 'performed count read');
	eq(run.events.get('Game.Inventory.Remove').length, 1, 'the failing test keeps its error entry');

	const q = readQuarantine({ quarantined: [{ token: 'Net.Flaky', reason: 'timing on CI', since: '2026-10-01' }, { token: 'Bad' }] });
	eq(q.entries.length, 2, 'quarantine entries read');
	eq(q.problems.length, 1, 'an entry without reason/since is flagged');
	eq(isQuarantined('net.flaky.Timing', q.entries), true, 'quarantine matches by case-insensitive prefix');
	eq(isQuarantined('Net.Other', q.entries), false, 'and only by prefix');

	const v1 = judgeRun({ exitCode: 255, run, filter: 'Game+Net', entries: q.entries });
	eq(v1.ok, false, 'a real failure gates');
	eq(v1.cls.failed, ['Game.Inventory.Remove'], 'the real failure is named');
	eq(v1.cls.quarantined, ['Net.Flaky.Timing'], 'the flaky failure is quarantined');
	eq(failureReport(run, v1.cls.failed)[1].includes('Expected'), true, 'the report carries the first error');

	const onlyFlaky = parseRunLog(log.replace('Result={Fail} Name={Remove}', 'Result={Success} Name={Remove}'));
	const v2 = judgeRun({ exitCode: 255, run: onlyFlaky, filter: 'Game+Net', entries: q.entries });
	eq(v2.ok, true, 'only a quarantined failure: the run is OK despite the non-zero exit');

	const v3 = judgeRun({ exitCode: 0, run: onlyFlaky, filter: 'Game+Net+Combat', entries: q.entries });
	eq(v3.missing, ['Combat'], 'an unselected token is an under-run');
	eq(v3.retryable, true, 'an under-run on a clean run is retryable');

	const crashed = parseRunLog([L('Test Started. Name={A} Path={Game.A}')].join('\n'));
	const v4 = judgeRun({ exitCode: 3, run: crashed, filter: 'Game', entries: [] });
	eq(v4.ok, false, 'a crash fails');
	eq(v4.cls.incomplete, ['Game.A'], 'the in-flight test is named');
	eq(v4.retryable, false, 'a crash is not retried');
	return fail;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
	if (process.argv.includes('--selftest')) {
		const f = selftest();
		for (const x of f) console.log(`  FAIL ${x}`);
		console.log(f.length ? `ue-test-log selftest: ${f.length} failed` : 'ue-test-log selftest: passed');
		process.exit(f.length ? 1 : 0);
	}
	const [logPath, filter] = process.argv.slice(2);
	const qi = process.argv.indexOf('--quarantine');
	if (!logPath || filter === undefined || !existsSync(logPath)) {
		console.log('usage: node ue-test-log.mjs <run log> <filter> [--quarantine <json>]   (log must exist)');
		process.exit(2);
	}
	const run = parseRunLog(readFileSync(logPath, 'utf8'));
	const { entries } = loadQuarantine(qi > 0 ? process.argv[qi + 1] : null);
	const v = judgeRun({ exitCode: run.exitMarker ?? 0, run, filter, entries });
	console.log(`passed ${v.cls.passed}, failed ${v.cls.failed.length}, incomplete ${v.cls.incomplete.length}, quarantined ${v.cls.quarantined.length}, skipped ${v.cls.skipped}`);
	for (const l of failureReport(run, [...v.cls.failed, ...v.cls.incomplete])) console.log(l);
	for (const r of v.reasons) console.log(`- ${r}`);
	process.exit(v.ok ? 0 : 1);
}
