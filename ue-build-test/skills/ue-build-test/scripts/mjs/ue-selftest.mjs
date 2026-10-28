// ue-selftest — every offline check of the skill in one run. Starts no editor, no build, no test run.
// Usage: ue-selftest.cmd [--project <dir or .uproject>]  (a real project is read, read-only, for suite discovery)

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { moduleOf, unbuilt } from '../../hooks/unbuilt-cpp.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
import { buildSteps, editorVerdict, singleFileArgs } from './ue-build-flow.mjs';
import { bareName, objectPath, parseCompileLog, reflectedTypes } from './ue-check-blueprints.mjs';
import { cleanPlan } from './ue-clean.mjs';
import { parseValidationLog } from './ue-validate-data.mjs';
import { selftest as gateSelftest } from './ue-gate.mjs';
import { selftest as procSelftest } from './ue-proc.mjs';
import { selftest as ownerSelftest } from './ue-owner.mjs';
import { selftest as pyRemoteSelftest } from './ue-pyremote.mjs';
import { askToClose, mcpBody, mcpPort, pendingRestore } from './ue-stop-editor.mjs';
import { selftest as logSelftest } from './ue-test-log.mjs';
import { selftest as suitesSelftest } from './ue-test-suites.mjs';
import { locateProject, parseArgs, pickTarget, readTargets } from './ue-tools.mjs';

const args = parseArgs(process.argv.slice(2), { project: {} });
const results = [];
const record = (name, fails) => {
	results.push([name, fails]);
	console.log(`${fails.length ? 'FAIL' : 'ok  '} ${name}${fails.length ? '' : ''}`);
	for (const f of fails) console.log(`       ${f}`);
};
const eq = (fails, a, b, m) => {
	if (JSON.stringify(a) !== JSON.stringify(b)) fails.push(`${m}: got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`);
};

record('ue-gate (verdict line, exits, .bat under a space, error lines, gate plan)', gateSelftest());
record('ue-owner (ownership states, launch/stop/build verdicts, markers)', ownerSelftest().fails);
record('ue-pyremote (Python Remote Execution against a fake editor node; copies match)', (await pyRemoteSelftest()).fails);
{
	const f = [];
	eq(f, mcpBody('event: message\ndata: {"result":{"x":1}}\n\n'), { result: { x: 1 } }, 'an event-stream MCP answer is read from its data line');
	eq(f, mcpBody('{"id":1}'), { id: 1 }, 'a plain JSON MCP answer');
	const dir = mkdtempSync(join(tmpdir(), 'ue-port-'));
	try {
		eq(f, mcpPort(dir, {}), 8000, 'no settings -> port 8000');
		mkdirSync(join(dir, 'Config'), { recursive: true });
		writeFileSync(join(dir, 'Config', 'DefaultEditorPerProjectUserSettings.ini'), '[/Script/ModelContextProtocolEngine.ModelContextProtocolSettings]\r\nServerPortNumber=19100\r\n');
		eq(f, mcpPort(dir, {}), 19100, 'the project default settings name the port');
		eq(f, mcpPort(dir, { UE_MCP_PORT: '18000' }), 18000, 'UE_MCP_PORT wins');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	record('ue-stop-editor (MCP port of a project, MCP answer reader)', f);
}
record('ue-test-log (results, coverage, quarantine, crash)', logSelftest());
let real;
if (args.project) {
	const loc = locateProject({ project: args.project });
	real = loc.uproject ? dirname(loc.uproject) : undefined;
	if (!real) console.log(`  (no project at ${args.project}: ${loc.error})`);
}
record('ue-test-suites (declarations, covering set, fixture)', suitesSelftest({ realProject: real }));
record('ue-proc (attribution by command line)', await procSelftest());

// Targets, the editor guard and the build steps — pure.
{
	const f = [];
	const root = mkdtempSync(join(tmpdir(), 'ue-tools-'));
	try {
		mkdirSync(join(root, 'Source'), { recursive: true });
		writeFileSync(join(root, 'Game.uproject'), '{"EngineAssociation":"5.8"}');
		writeFileSync(join(root, 'Source', 'Game.Target.cs'), 'public class GameTarget : TargetRules { public GameTarget(TargetInfo T) : base(T) { Type = TargetType.Game; } }');
		writeFileSync(join(root, 'Source', 'GameEd.Target.cs'), 'public class GameEdTarget : TargetRules { public GameEdTarget(TargetInfo T) : base(T) { Type = TargetType.Editor; } }');
		const t = readTargets(root);
		eq(f, t.map((x) => `${x.name}:${x.type}`), ['Game:Game', 'GameEd:Editor'], 'targets read from Target.cs');
		eq(f, pickTarget(t, 'Editor', 'Game'), 'GameEd', 'an unconventional editor target name is found');
		eq(f, locateProject({ cwd: join(root, 'Source') }).uproject, join(root, 'Game.uproject'), 'nearest .uproject walking up');
		writeFileSync(join(root, 'Other.uproject'), '{}');
		eq(f, Boolean(locateProject({ cwd: root }).error), true, 'two .uproject side by side is an error, not a guess');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
	const none = { gui: [], headless: [], pids: [], precise: true, opaque: 0 };
	eq(f, editorVerdict(none, { editorBlocks: true, destructive: true }).blockers.length, 0, 'no editor: nothing blocks');
	eq(f, editorVerdict({ ...none, gui: [1], pids: [1] }, { editorBlocks: true }).blockers.length, 1, 'a GUI editor blocks an editor build');
	eq(f, editorVerdict({ ...none, gui: [1], pids: [1] }, { editorBlocks: false }).blockers.length, 0, 'but not a game build');
	eq(f, editorVerdict({ ...none, opaque: 2 }, { editorBlocks: true, destructive: false }).blockers.length, 0, 'an unattributable editor only warns a compile');
	eq(f, editorVerdict({ ...none, opaque: 2 }, { editorBlocks: true, destructive: true }).blockers.length, 1, 'and blocks a rebuild');
	const tools = { hostPlatform: 'Win64', project: 'C:\\p\\G.uproject', unrealBuild: 'B.bat', unrealClean: 'C.bat', parallelArgs: ['-MaxParallelActions=10'] };
	const rb = buildSteps({ kind: 'rebuild' }, tools, { target: 'GEditor', config: 'Development' });
	eq(f, rb.map((s) => s.file), ['C.bat', 'B.bat'], 'rebuild = clean then build');
	eq(f, rb[1].args.includes('-DisableUnity'), true, 'rebuild builds with -DisableUnity');
	eq(f, buildSteps({ kind: 'compile' }, { ...tools, parallelArgs: [] }, { target: 'GEditor', config: 'Development' })[0].args.some((a) => a.startsWith('-MaxParallel')), false, 'UE_MAX_PARALLEL_ACTIONS=0 passes no cap');
	const one = buildSteps({ kind: 'compile' }, tools, { target: 'GEditor', config: 'Development', files: ['C:\\p\\Source\\G\\A.cpp'] })[0].args;
	eq(f, [one.includes('-SingleFile=C:\\p\\Source\\G\\A.cpp'), one.includes('-SingleFileBuildDependents')], [true, false], 'a .cpp compiles alone');
	eq(f, singleFileArgs(['C:\\p\\Source\\G\\A.h', 'C:\\p\\Source\\G\\B.cpp']), ['-SingleFile=C:\\p\\Source\\G\\A.h', '-SingleFile=C:\\p\\Source\\G\\B.cpp', '-SingleFileBuildDependents'], 'a header brings its includers');
	record('ue-tools / ue-build-flow (targets, project lookup, editor guard, steps)', f);
}

// Clean plan on a fixture: what goes, what stays.
{
	const f = [];
	const root = mkdtempSync(join(tmpdir(), 'ue-clean-'));
	try {
		const mk = (rel) => mkdirSync(join(root, rel), { recursive: true });
		['Binaries/Win64', 'Intermediate', 'Saved/Logs', 'Build/Windows', 'Plugins/Src/Source', 'Plugins/Src/Binaries/ThirdParty', 'Plugins/Src/Binaries/Win64', 'Plugins/Bin/Binaries/Win64'].forEach(mk);
		writeFileSync(join(root, 'Plugins/Src/Src.uplugin'), '{}');
		writeFileSync(join(root, 'Plugins/Bin/Bin.uplugin'), '{}');
		writeFileSync(join(root, 'G.sln'), '');
		const rel = (p) => p.slice(root.length + 1).replace(/\\/g, '/');
		const plan = cleanPlan(root).map(rel).sort();
		eq(f, plan, ['Binaries', 'G.sln', 'Intermediate', 'Plugins/Src/Binaries/Win64'].sort(), 'clean plan');
		eq(f, cleanPlan(root, { saved: true }).map(rel).includes('Saved'), true, '--saved adds Saved');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
	record('ue-clean (keeps Saved, Build, ThirdParty, binary-only plugins)', f);
}

// The graceful console close, against a throwaway node process in its own hidden console — never an editor.
if (process.platform === 'win32') {
	const f = [];
	const dir = mkdtempSync(join(tmpdir(), 'ue-ctrlc-'));
	const marker = join(dir, 'got-break');
	const code = `process.on('SIGBREAK',()=>{require('fs').writeFileSync(${JSON.stringify(marker)},'1');process.exit(0)});setTimeout(()=>{},30000)`;
	// Its OWN console, hidden: Node's `detached` gives a process no console at all (DETACHED_PROCESS), and a
	// shared console would deliver the Ctrl+C to this self-test as well. Start-Process makes a new one.
	const script = join(dir, 'idle.js');
	writeFileSync(script, code);
	const pidText = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
		`(Start-Process -FilePath '${process.execPath.replace(/'/g, "''")}' -ArgumentList '"${script}"' -WindowStyle Hidden -PassThru).Id`],
		{ encoding: 'utf8', windowsHide: true }).trim();
	const kid = { pid: Number(pidText), kill: () => { try { process.kill(Number(pidText)); } catch { /* gone */ } } };
	try {
		await sleep(1500);
		const said = askToClose(kid.pid, { headless: true });
		for (let i = 0; i < 20 && !existsSync(marker); i++) await sleep(250);
		eq(f, said, 'ctrl-break sent', 'a windowless console process gets a console Ctrl+Break');
		eq(f, existsSync(marker), true, 'and handles it in its own handler (SIGBREAK), not as an outside kill');
	} finally {
		try {
			kid.kill();
		} catch {
			/* gone */
		}
		rmSync(dir, { recursive: true, force: true });
	}
	eq(f, pendingRestore(join(tmpdir(), 'ue-no-project')), null, 'no restore file -> null');
	record('ue-stop-editor (console Ctrl+Break on a throwaway process; restore-list reader)', f);
}

// Blueprint check: what a header declares, how an asset is named for the allow list, what the log says.
{
	const f = [];
	const header = 'UCLASS(Blueprintable)\nclass GAME_API AMyDoor : public AActor\n{};\nUSTRUCT(BlueprintType)\nstruct FDoorState\n{};\nUENUM()\nenum class EDoorMode : uint8 {};\nclass FPlain {};';
	eq(f, reflectedTypes(header), ['MyDoor', 'DoorState', 'DoorMode'], 'reflected types, prefix stripped, plain classes ignored');
	eq(f, [bareName('AMyDoor'), bareName('Unit'), bareName('IDoor')], ['MyDoor', 'Unit', 'Door'], 'prefix only before a capital');
	eq(f, objectPath('C:\\p\\Content', 'C:\\p\\Content\\Maps\\BP_Door.uasset'), '/Game/Maps/BP_Door.BP_Door', 'object path');
	const log = [
		"[2026.10.11-10.00.00:000][  0]LogCompileAllBlueprintsCommandlet: Display: Loading and Compiling: '/Game/A/BP_Ok.BP_Ok'...",
		"[2026.10.11-10.00.01:000][  0]LogCompileAllBlueprintsCommandlet: Display: Loading and Compiling: '/Game/A/BP_Bad.BP_Bad'...",
		'[2026.10.11-10.00.01:000][  0]LogCompileAllBlueprintsCommandlet: Display: [Compiler] Error: In use pin Speed no longer exists on node Set',
		'[2026.10.11-10.00.02:000][  0]LogCompileAllBlueprintsCommandlet: Warning: Compile of /Game/A/BP_Bad.BP_Bad failed',
		'LogCompileAllBlueprintsCommandlet: Display: Compiling Completed with 1 errors and 0 warnings and 0 blueprints that failed to load.',
		'[2026.10.11-10.00.02:000][  0]LogCompileAllBlueprintsCommandlet: Warning: ',
		'===================================================================================',
		'Assets With Errors or Warnings:',
		'===================================================================================',
		'',
		'[2026.10.11-10.00.02:000][  0]LogCompileAllBlueprintsCommandlet: Warning: /Game/A/BP_Bad.BP_Bad',
		'[2026.10.11-10.00.02:000][  0]LogCompileAllBlueprintsCommandlet: Warning: /Game/A/BP_Noisy.BP_Noisy',
		'[2026.10.11-10.00.02:000][  0]LogCompileAllBlueprintsCommandlet: Warning: ',
		'===================================================================================',
		'End of Asset List',
	].join('\n');
	const r = parseCompileLog(log);
	eq(f, [r.compiled, r.summary, r.failed, r.messages.length], [2, { errors: 1, warnings: 0, failedLoads: 0 }, ['/Game/A/BP_Bad.BP_Bad'], 1], 'log: count, summary, failed asset, message');
	eq(f, r.flagged, ['/Game/A/BP_Bad.BP_Bad', '/Game/A/BP_Noisy.BP_Noisy'], "the commandlet's list of assets with warnings");
	eq(f, parseCompileLog('').summary, null, 'no log -> no summary (an unfinished run is a failure)');
	record('ue-check-blueprints (header types, allow-list path, commandlet log)', f);
}

// unbuilt-cpp hook: a session's C++ newer than its module's DLL holds the Stop, a built one does not.
{
	const f = [];
	const dir = mkdtempSync(join(tmpdir(), 'ue-unbuilt-'));
	try {
		const t0 = Date.now() - 3600_000;
		const touch = (rel, ms) => {
			mkdirSync(dirname(join(dir, rel)), { recursive: true });
			writeFileSync(join(dir, rel), '');
			utimesSync(join(dir, rel), ms / 1000, ms / 1000);
			return join(dir, rel);
		};
		const built = touch('G/Source/Game/A.cpp', t0);
		touch('G/Binaries/Win64/UnrealEditor-Game.dll', t0 + 60_000);
		const stale = touch('G/Plugins/Kit/Source/Kit/B.h', t0 + 120_000);
		touch('G/Plugins/Kit/Binaries/Win64/UnrealEditor-Kit.dll', t0);
		eq(f, moduleOf(join(dir, 'G', 'Source', 'Game', 'Private', 'X.cpp').replace(/\\/g, '/'))?.name, 'Game', 'module from the path');
		eq(f, [moduleOf('C:/p/Intermediate/Source/Game/a.cpp'), moduleOf('C:/p/Source/Game/a.txt')], [null, null], 'generated trees and non-C++ ignored');
		eq(f, unbuilt([built, stale, stale]), [stale], 'only the file newer than its module binary, once');
		const hook = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'hooks', 'unbuilt-cpp.mjs');
		const run = (payload, env = {}) => spawnSync(process.execPath, [hook], { input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, ...env } });
		const sid = `selftest-${process.pid}`;
		run({ hook_event_name: 'PostToolUse', session_id: sid, tool_input: { file_path: stale } });
		run({ hook_event_name: 'PostToolUse', session_id: sid, tool_input: { file_path: join(dir, 'notes.md') } });
		let r = run({ hook_event_name: 'Stop', session_id: sid });
		eq(f, [r.status, r.stderr.includes('B.h'), r.stderr.includes('notes.md')], [2, true, false], 'Stop blocked by the unbuilt file only');
		eq(f, run({ hook_event_name: 'Stop', session_id: sid, stop_hook_active: true }).status, 0, 'second Stop in the same turn passes');
		eq(f, run({ hook_event_name: 'Stop', session_id: sid }).status, 0, 'the same unbuilt files at the next turn: reminded once, now silent');
		utimesSync(stale, (t0 + 150_000) / 1000, (t0 + 150_000) / 1000);
		eq(f, run({ hook_event_name: 'Stop', session_id: sid }).status, 2, 'the file edited again: reminded again');
		eq(f, run({ hook_event_name: 'Stop', session_id: sid }, { UE_BT_STOP_CHECK: '0' }).status, 0, 'UE_BT_STOP_CHECK=0 turns it off');
		utimesSync(join(dir, 'G/Plugins/Kit/Binaries/Win64/UnrealEditor-Kit.dll'), (t0 + 180_000) / 1000, (t0 + 180_000) / 1000);
		eq(f, run({ hook_event_name: 'Stop', session_id: sid }).status, 0, 'after the build the Stop passes');
		eq(f, run({ hook_event_name: 'Stop', session_id: 'never-edited' }).status, 0, 'a session that edited nothing passes');
		rmSync(join(tmpdir(), `ue-build-test-edits-${sid}.txt`), { force: true });
		rmSync(join(tmpdir(), `ue-build-test-edits-${sid}.told.txt`), { force: true });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	record('unbuilt-cpp hook (module of a file, Stop gate)', f);
}

// ue-validate-data: findings and the finished line of the DataValidation commandlet log.
{
	const f = [];
	const ok = [
		'[2026.10.11-10.00.00:000][  0]LogDataValidation: Running DataValidationCommandlet Commandlet',
		'[2026.10.11-10.00.09:000][  0]LogContentValidation: Warning: /Game/A/DA_Item.DA_Item: Icon is empty',
		"[2026.10.11-10.00.10:000][  0]AssetCheck: Warning: /Script/Engine.World'/Game/Maps/M.M' Warnings loading asset X",
		'[2026.10.11-10.00.10:000][  0]LogInit: Display: AssetCheck: Warning: duplicate summary line, not counted',
		'[2026.10.11-10.00.10:000][  0]LogContentValidation: Validated asset counts for 12 validators:',
	].join('\n');
	let r = parseValidationLog(ok);
	eq(f, [r.finished, r.errors.length, r.warnings.length, r.failedBanner], [true, 0, 2, false], 'clean run: finished by the validator summary, AssetCheck and LogContentValidation warnings, the LogInit echo skipped');
	const bad = [
		'LogContentValidation: Error: /Game/A/BP_Door.BP_Door: Mesh is not set',
		'LogContentValidation: Error: /Game/A/BP_Door.BP_Door: Mesh is not set',
		'LogDataValidation: Warning: Errors occurred while validating data',
	].join('\n');
	r = parseValidationLog(bad);
	eq(f, [r.finished, r.errors, r.failedBanner, r.warnings.length], [false, ['/Game/A/BP_Door.BP_Door: Mesh is not set'], true, 0], 'failed run: errors deduplicated, the banner is not a finding');
	record('ue-validate-data (DataValidation log)', f);
}

const failed = results.filter(([, f]) => f.length).length;
console.log(failed ? `ue-selftest: ${failed} group(s) failed` : `ue-selftest: all ${results.length} groups passed`);
process.exit(failed ? 1 : 0);
