// ue-check-blueprints — compile the project's Blueprints with the CompileAllBlueprints commandlet and sum up.
//
// A C++ build does not see Blueprints: rename or remove a UPROPERTY/UFUNCTION a Blueprint uses and the build is
// green while the Blueprint breaks. This runs UnrealEditor-Cmd -run=CompileAllBlueprints (one-shot, headless) over
// an allow list and reports what failed.
//
//   (default)        every Blueprint under Content/ (/Game; engine and plugin content is skipped)
//   --changed        only assets that mention a reflected type declared in a header changed since HEAD
//   --type A,B       only assets that mention these types (the U/A/F/E/I prefix is optional)
//
// "Mention" = the type's name without its prefix appears in the .uasset bytes (a package's name table stores
// AMyActor as MyActor). Data assets are not compiled by the commandlet: a field removed from C++ is dropped from
// them silently on the next save, so the list of matched assets is printed for a look.
//
// Same gates as ue-test: refuses next to an editor of this project, waits for what is not ours (ue-owner), and
// refuses stale binaries (sources newer than the module DLLs) unless --allow-stale.
// Usage: ue-check-blueprints.cmd [--changed | --type A,B] [--list-only] [--allow-stale] [--project p] [--wait s]
//        [--timeout min] [--dry-run] [-- <commandlet switches, e.g. -IgnoreFolder=/Game/A,/Game/B>]
// Ends with: RESULT: blueprints <OK|FAILED|DEFERRED|DRY-RUN> (exit N)

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exitWith, gate, gatePlan, renderCommand, Verdict } from './ue-gate.mjs';
import { editorsOfProject } from './ue-proc.mjs';
import { binariesStale, parseArgs, resolveTools } from './ue-tools.mjs';

const Kind = 'blueprints';
const ReflectedType = /^\s*(?:UCLASS|USTRUCT|UENUM|UINTERFACE)\s*\([^)]*\)\s*(?:\n\s*)*(?:class|struct|enum\s+class|enum)\s+(?:\w+_API\s+)?([A-Z]\w+)/gm;
const TypePrefix = /^[UAFEI](?=[A-Z])/;
const AllowListRel = 'Saved/ue-build-test/BlueprintAllowList.txt';

/** AMyActor -> MyActor: the spelling a package's name table carries. Pure. */
export const bareName = (type) => type.trim().replace(TypePrefix, '');

/** Reflected type names declared in a header's text, prefix stripped. Pure. */
export function reflectedTypes(text) {
	return [...text.matchAll(ReflectedType)].map((m) => bareName(m[1]));
}

/** Content/Maps/Foo.uasset -> /Game/Maps/Foo.Foo (the object path the allow list takes). Pure. */
export function objectPath(contentRoot, file) {
	const pkg = '/Game/' + relative(contentRoot, file).replace(/\\/g, '/').replace(/\.uasset$/i, '');
	return `${pkg}.${pkg.slice(pkg.lastIndexOf('/') + 1)}`;
}

/** What the commandlet log says. Pure over the text. */
export function parseCompileLog(text) {
	let summary = null;
	let current = null;
	let compiled = 0;
	const failed = [];
	const messages = [];
	const flagged = []; // the commandlet's own list of assets with errors or warnings (-SimpleAssetList)
	let inList = false;
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.replace(/^\[[\d.\-:]+\]\[\s*\d+\]/, '');
		if (line.includes('Assets With Errors or Warnings:')) {
			inList = true;
			continue;
		}
		if (inList) {
			if (line.includes('End of Asset List')) inList = false;
			else {
				const m = line.match(/LogCompileAllBlueprintsCommandlet: Warning: (\/\S+)/);
				if (m) flagged.push(m[1]);
			}
			continue;
		}
		let m = line.match(/LogCompileAllBlueprintsCommandlet: Display: Loading and Compiling: '([^']+)'/);
		if (m) {
			current = m[1];
			compiled++;
			continue;
		}
		m = line.match(/Compiling Completed with (\d+) errors and (\d+) warnings and (\d+) blueprints that failed to load/);
		if (m) {
			summary = { errors: Number(m[1]), warnings: Number(m[2]), failedLoads: Number(m[3]) };
			current = null;
			continue;
		}
		if (/Compile of \S+ failed/.test(line) || line.includes('Failed to Load')) {
			failed.push(current ?? line.trim());
			continue;
		}
		if (current && /(^|\s)(Error|error)[: ]/.test(line) && !line.includes('LogInit')) messages.push({ asset: current, text: line.trim() });
	}
	return { summary, compiled, failed: [...new Set(failed)], messages, flagged: [...new Set(flagged)] };
}

function* walk(dir, re) {
	let entries = [];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const e of entries) {
		const p = join(dir, e.name);
		if (e.isDirectory()) yield* walk(p, re);
		else if (re.test(e.name)) yield p;
	}
}

function changedHeaders(projectDir) {
	const git = (args) => {
		try {
			return execFileSync('git', args, { cwd: projectDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split(/\r?\n/);
		} catch {
			return null;
		}
	};
	const tracked = git(['diff', '--name-only', 'HEAD', '--', 'Source', 'Plugins']);
	const untracked = git(['ls-files', '--others', '--exclude-standard', '--', 'Source', 'Plugins']);
	if (tracked === null || untracked === null) return null;
	return [...tracked, ...untracked].filter((p) => /\.(h|hpp)$/i.test(p)).map((p) => join(projectDir, p)).filter((p) => existsSync(p));
}

function assetsMentioning(contentRoot, names) {
	const needles = names.map((n) => Buffer.from(n, 'latin1'));
	const found = [];
	for (const file of walk(contentRoot, /\.uasset$/i)) {
		const data = readFileSync(file);
		if (needles.some((n) => data.includes(n))) found.push(file);
	}
	return found;
}

async function main() {
	const args = parseArgs(process.argv.slice(2), {
		project: {},
		changed: { type: 'bool' },
		type: {},
		'list-only': { type: 'bool' },
		'allow-stale': { type: 'bool' },
		wait: { default: '600' },
		timeout: { default: '30' },
		'dry-run': { type: 'bool' },
		help: { type: 'bool' },
	});
	if (args.help) {
		console.log('usage: ue-check-blueprints.cmd [--changed | --type A,B] [--list-only] [--allow-stale] [--project p] [--wait s] [--timeout min] [--dry-run] [-- <commandlet switches>]');
		console.log('  after --: passed to CompileAllBlueprints, e.g. -IgnoreFolder=/Game/ThirdParty,/Game/Demo');
		console.log('  default: every Blueprint under Content/; --changed: assets mentioning types from headers changed since HEAD');
		console.log('  log: <project>/Saved/Logs/CompileAllBlueprints.log');
		process.exit(0); // verdict-exempt: help
	}
	const dry = Boolean(args['dry-run']);
	const wait = Number(args.wait);
	const timeoutMin = Number(args.timeout);
	if (args.changed && args.type) {
		console.log('ERROR: --changed and --type are exclusive.');
		exitWith(Kind, Verdict.Failed, 2);
	}
	if (!Number.isFinite(wait) || !Number.isFinite(timeoutMin) || timeoutMin <= 0) exitWith(Kind, Verdict.Failed, 2);

	const tools = resolveTools({ project: args.project });
	if (!tools.ok) {
		console.log(tools.error);
		exitWith(Kind, Verdict.Failed, 1);
	}
	const contentRoot = join(tools.projectDir, 'Content');
	console.log(`Project : ${tools.project}`);

	let assets;
	if (args.changed || args.type) {
		let names;
		if (args.changed) {
			const headers = changedHeaders(tools.projectDir);
			if (headers === null) {
				console.log('ERROR: git could not list the changed headers (not a git checkout?). Use --type A,B instead.');
				exitWith(Kind, Verdict.Failed, 2);
			}
			names = [...new Set(headers.flatMap((h) => reflectedTypes(readFileSync(h, 'utf8'))))].sort();
			console.log(`Changed headers: ${headers.length}, reflected types in them: ${names.join(', ') || 'none'}`);
		} else {
			names = [...new Set(args.type.split(',').filter((s) => s.trim()).map(bareName))].sort();
		}
		if (!names.length) {
			console.log('No reflected type changed - no Blueprint can be affected, nothing to compile.');
			exitWith(Kind, Verdict.Ok, 0);
		}
		assets = assetsMentioning(contentRoot, names);
		console.log(`Assets mentioning ${names.join(', ')}: ${assets.length}`);
		for (const a of assets) console.log(`  ${relative(tools.projectDir, a)}`);
		if (!assets.length) {
			console.log('No asset under Content/ mentions these types - nothing to compile.');
			exitWith(Kind, Verdict.Ok, 0);
		}
		console.log('Data assets in this list are not compiled by the commandlet: a field removed from C++ is lost in them silently - look at them.');
	} else {
		assets = [...walk(contentRoot, /\.uasset$/i)];
		console.log(`Whole Content/: ${assets.length} assets in the allow list (engine and plugin Blueprints are skipped).`);
	}
	if (args['list-only']) exitWith(Kind, Verdict.DryRun, 0);

	const logPath = join(tools.logsDir, 'CompileAllBlueprints.log');
	if (/\s/.test(logPath)) {
		console.log(`ERROR: the log path has a space: "${logPath}" - the editor ignores -ABSLOG= then.`);
		exitWith(Kind, Verdict.Failed, 2);
	}
	const editorArgs = [
		tools.project,
		'-run=CompileAllBlueprints',
		`-AllowListFile=${AllowListRel}`, // read relative to the project dir by the commandlet
		'-SimpleAssetList',
		'-unattended',
		'-nopause',
		'-nosplash',
		'-nullrhi',
		'-nosound',
		'-SCCProvider=None',
		`-ABSLOG=${logPath}`,
		...args.rest, // e.g. -IgnoreFolder=/Game/ThirdParty,/Game/Demo (the commandlet's own switches)
	];

	const blockers = [];
	const editors = editorsOfProject(tools.projectDir);
	if (editors.gui.length) blockers.push(`a GUI editor of this project is open (pid ${editors.gui.join(', ')}): a second editor process next to it fights over the same packages. Ask the person to close it, or compile the Blueprints in it (File > Refresh All / Compile Blueprints).`);
	if (editors.headless.length) blockers.push(`a headless editor of this project runs (pid ${editors.headless.join(', ')}). If this session started it, stop it with ue-stop-editor.cmd (separate tool call); otherwise wait for its owner.`);
	if (binariesStale(tools).stale && !args['allow-stale']) {
		console.log('ERROR: C++ sources are newer than the module binaries - the Blueprints would be checked against OLD code. Build first (ue-compile.cmd), or pass --allow-stale.');
		exitWith(Kind, Verdict.Failed, 3);
	}

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
		console.log('No Blueprint was compiled.');
		exitWith(Kind, Verdict.Deferred, 1);
	}
	const owner = gate('launch', tools.projectDir, { wait });
	if (!owner.ok) {
		console.log(`DEFERRED: ${owner.reason}`);
		console.log('No Blueprint was compiled. An editor or a build this session did not start is not ours: wait or ask, never stop it.');
		exitWith(Kind, Verdict.Deferred, 1);
	}

	const allowList = join(tools.projectDir, AllowListRel);
	mkdirSync(join(allowList, '..'), { recursive: true });
	writeFileSync(allowList, assets.map((a) => objectPath(contentRoot, a)).join('\n') + '\n', 'latin1');
	mkdirSync(tools.logsDir, { recursive: true });
	if (existsSync(logPath)) writeFileSync(logPath, ''); // an earlier run's log must not be read as this one's

	console.log(`Running the commandlet (one-shot headless, minutes)... log: ${logPath}`);
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

	const log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
	const { summary, compiled, failed, messages, flagged } = parseCompileLog(log);
	console.log(`Commandlet exit ${code ?? 'timeout'}, ${seconds}s, Blueprints loaded: ${compiled}`);
	if (summary) console.log(`Errors: ${summary.errors}, warnings: ${summary.warnings}, failed loads: ${summary.failedLoads}`);
	else console.log('No summary line in the log - the commandlet did not finish; read the log.');
	for (const a of failed) console.log(`FAILED: ${a}`);
	for (const a of flagged.filter((x) => !failed.includes(x))) console.log(`WARNINGS/ERRORS: ${a}`);
	const shown = new Set();
	for (const { asset, text } of messages) {
		const line = `  ${asset.slice(asset.lastIndexOf('.') + 1)}: ${text.replace(/^.*?\[Compiler\]\s*/, '').slice(0, 200)}`;
		if (shown.size < 40 && !shown.has(line)) {
			shown.add(line);
			console.log(line);
		}
	}
	if (!summary || code !== 0 || failed.length || summary.errors || summary.failedLoads) {
		console.log(`Blueprints FAILED. Full log: ${logPath}`);
		exitWith(Kind, Verdict.Failed, 1);
	}
	console.log(`Every Blueprint compiled (${compiled}).`);
	exitWith(Kind, Verdict.Ok, 0);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) await main();
