// cook-check — does the cooked game carry every asset a reference set needs?
//
// Usage: cook-check.cmd [--map /Game/Maps/X]... [--asset /Game/A/B]... [--dir /Game/Always/]...
//                       [--platform Windows] [--cooked <dir>] [--out <dir>] [--editor-closure] [--cook] [--plan]
//        cook-check.cmd --selftest
//
// WHAT IT ANSWERS. The editor finds any asset on disk, so an asset reached by a path the cooker cannot see — a
// string in code, a config slot nothing loads at cook time, a soft reference the cook skipped — works in every
// editor session and is simply absent from the shipped game. The honest check is to cook and count:
//   1. EXPECTED — the dependency closure (hard + soft, game references only) of the reference set: the maps and
//      assets named here or in .claude/content-gates.json `cookCheck`, every object path Config/DefaultGame.ini
//      and DefaultEngine.ini name (settings slots), and the packaging settings' MapsToCook /
//      DirectoriesToAlwaysCook;
//   2. COOKED — the cooker's own list (Saved/Cooked/<Platform>/<Project>/Metadata/ReferencedSet.txt, written by a
//      Zen-store cook) or the package files of a loose cook;
//   3. MISSING = expected, on disk, not cooked. UNRESOLVED = referenced but not on disk even for the editor.
// Each missing row carries its class and one referencer, so an editor-only tool (an editor utility, a
// thumbnail source) is told from a real loss at a glance.
//
// MODES. The default is fully OFFLINE: the closure is read from package headers (py/offline_closure.py) and the
// cooked set from the last cook on disk — no editor, no lock, nothing written into the project except the report.
// When no cook is present it says so and exits 2 («cannot tell», never «clean»).
//   --editor-closure  the closure from the editor's asset registry instead (py/cook-closure.py through
//                     `UnrealEditor-Cmd -run=pythonscript`); starts a headless editor process.
//   --cook            cook first (`UnrealEditor-Cmd -run=cook -targetplatform=<P>`); starts a headless editor.
//   --plan            print the roots and the command lines it would run, and stop.
// Anything that starts an editor process first checks the machine rule (ue-owner.mjs): it refuses while an editor
// of this project runs, an editor of another project that this session did not start runs, or a build that is
// not ours runs. The commandlet runs inside this call, so it needs no ownership marker.
// Output: <project>/Saved/ContentGates/cook-check/<stamp>.md + .json (or --out), a summary on stdout, and a last
// line `RESULT: cook-check OK|FAILED|UNKNOWN (exit N)`.

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findUproject, resolveEngine } from './ue-engine.mjs';
import { canLaunch, snapshot, whoAmI } from './ue-owner.mjs';

const PyDir = join(dirname(dirname(fileURLToPath(import.meta.url))), 'py');

/** `/Game/A/B.B` or `/Game/A/B.B_C` → `/Game/A/B`; a bare package name stays. Git Bash's
 *  `C:/Program Files/Git/Game/X` rewrite is undone. Pure. */
export const packageOf = (raw) => {
	const m = raw.match(/^[A-Za-z]:[\\/].*?[\\/]Git[\\/](.+)$/);
	const objectPath = m ? `/${m[1].replace(/\\/g, '/')}` : raw;
	const last = objectPath.lastIndexOf('/');
	const dot = objectPath.indexOf('.', last);
	return dot < 0 ? objectPath : objectPath.slice(0, dot);
};

/** Every object path a config file names under a content mount, with its `[section] key`; plus the packaging
 *  settings' MapsToCook (a package) and DirectoriesToAlwaysCook (a folder, kept with a trailing `/`). Pure. */
export function configSlots(text, file) {
	const slots = [];
	let section = '';
	for (const line of text.split(/\r?\n/)) {
		const head = line.match(/^\s*\[(.+)\]\s*$/);
		if (head) { section = head[1]; continue; }
		if (/^\s*;/.test(line)) continue;
		const kv = line.match(/^\s*[+\-.!]?([^=]+)=(.*)$/);
		if (!kv) continue;
		const key = kv[1].trim();
		if (/ProjectPackagingSettings$/.test(section) && /^(MapsToCook|DirectoriesToAlwaysCook)$/.test(key)) {
			const m = kv[2].match(/(?:FilePath|Path)="([^"]+)"/);
			if (m && m[1].startsWith('/')) {
				const folder = key === 'DirectoriesToAlwaysCook';
				const path = folder ? m[1].replace(/\/?$/, '/') : m[1];
				slots.push({ file, section, key, path, package: folder ? path : packageOf(path) });
			}
			continue;
		}
		for (const m of kv[2].matchAll(/\/(?!Script\/|Engine\/)[A-Za-z0-9_]+\/[^"\s,)']+/g)) {
			const path = m[0];
			if (!path.slice(path.lastIndexOf('/')).includes('.')) continue;
			slots.push({ file, section, key, path, package: packageOf(path) });
		}
	}
	return slots;
}

/** A cooked file's package name: `<Project>/Content/X.uasset` → `/Game/X`, `Engine/Content/X` → `/Engine/X`,
 *  `…/Plugins/…/<Mount>/Content/X` → `/<Mount>/X`. Null for anything that is not a package header. Pure. */
export function cookedPackage(rel, project) {
	if (!/\.(uasset|umap)$/.test(rel)) return null;
	const parts = rel.replace(/\.(uasset|umap)$/, '').split(/[\\/]/);
	const content = parts.indexOf('Content');
	if (content < 1) return null;
	const rest = parts.slice(content + 1).join('/');
	if (parts[0] === project && content === 1) return `/Game/${rest}`;
	if (parts[0] === 'Engine' && content === 1) return `/Engine/${rest}`;
	return `/${parts[content - 1]}/${rest}`;
}

/** The cooked package set under a platform's cooked root; null when nothing was cooked there. */
export function readCookedSet(cookedRoot, project) {
	const referencedSet = join(cookedRoot, project, 'Metadata', 'ReferencedSet.txt');
	let names;
	if (existsSync(referencedSet)) {
		names = readFileSync(referencedSet, 'utf8').split(/\r?\n/).filter((l) => l.startsWith('/'));
	} else {
		const files = [];
		const walk = (dir) => {
			if (!existsSync(dir)) return;
			for (const entry of readdirSync(dir)) {
				const full = join(dir, entry);
				if (statSync(full).isDirectory()) walk(full);
				else files.push(full.slice(cookedRoot.length + 1));
			}
		};
		walk(cookedRoot);
		names = files.map((f) => cookedPackage(f, project)).filter(Boolean);
	}
	if (!names.length) return null;
	// Names compare case-blind: the Zen list is lower-cased.
	const lower = new Set(names.map((n) => n.toLowerCase()));
	return { size: lower.size, has: (name) => lower.has(name.toLowerCase()), source: existsSync(referencedSet) ? referencedSet : cookedRoot };
}

function findPython() {
	const candidates = [[process.env.PYTHON, []], ['python', []], ['py', ['-3']]].filter(([exe]) => exe);
	for (const [exe, pre] of candidates) {
		const r = spawnSync(exe, [...pre, '--version'], { encoding: 'utf8', windowsHide: true });
		if (r.status === 0 && /Python 3/.test(r.stdout + r.stderr)) return [exe, pre];
	}
	return null;
}

function verdict(kind, code) {
	console.log(`RESULT: cook-check ${kind} (exit ${code})`);
	process.exit(code);
}

/**
 * The machine rule for anything that starts an editor process (ue-owner.mjs): no editor of this project may run
 * (it holds the same packages), no editor of another project that is not ours (one editor per machine), no build
 * that is not ours. Refuses with the reason; nothing to release afterwards.
 */
function gate(root) {
	const snap = snapshot();
	if (!snap) {
		console.log('cook-check: the process query failed - cannot tell whether an editor or a build runs; not starting an editor process.');
		verdict('UNKNOWN', 2);
	}
	const v = canLaunch(snap, whoAmI(snap), root);
	if (!v.ok) {
		console.log(`cook-check: not starting an editor process - ${v.reason}`);
		verdict('UNKNOWN', 2);
	}
}

function selftest() {
	const eq = (a, b, what) => { if (JSON.stringify(a) !== JSON.stringify(b)) { console.error(`FAIL: ${what}\n  expected ${JSON.stringify(b)}\n  got      ${JSON.stringify(a)}`); process.exitCode = 1; } };
	eq(packageOf('/Game/UI/WBP_A.WBP_A_C'), '/Game/UI/WBP_A', 'a class path names its package');
	eq(packageOf('/Game/Maps/Boot'), '/Game/Maps/Boot', 'a package name stays');
	eq(packageOf('C:/Program Files/Git/Game/Maps/Boot'), '/Game/Maps/Boot', 'a Git Bash-mangled path is restored');
	const ini = [
		'[/Script/MyGame.MySettings]', '; a comment /Game/X.X', 'Look=/Game/M/MPC.MPC', '+Dirs=(Path="/Game/Always")',
		'Map=/Game/Maps/Boot.Boot', 'Cls=/Script/Engine.Actor',
		'[/Script/UnrealEd.ProjectPackagingSettings]', '+MapsToCook=(FilePath="/Game/Maps/Level_1")', '+DirectoriesToAlwaysCook=(Path="/Game/UI/Fonts")',
	].join('\n');
	eq(configSlots(ini, 'DefaultGame.ini').map((s) => s.package), ['/Game/M/MPC', '/Game/Maps/Boot', '/Game/Maps/Level_1', '/Game/UI/Fonts/'],
		'object paths and packaging lists are roots; folders elsewhere, comments and script paths are not');
	eq(cookedPackage('MyGame/Content/Maps/Boot.umap', 'MyGame'), '/Game/Maps/Boot', 'project content maps to /Game');
	eq(cookedPackage('Engine/Content/BasicShapes/Cube.uasset', 'MyGame'), '/Engine/BasicShapes/Cube', 'engine content to /Engine');
	eq(cookedPackage('MyGame/Plugins/Kit/Content/UI/T_A.uasset', 'MyGame'), '/Kit/UI/T_A', 'a plugin to its mount');
	eq(cookedPackage('MyGame/Content/Maps/Boot.uexp', 'MyGame'), null, 'a payload file is not a package');
	if (!process.exitCode) console.log('cook-check selftest: ok');
}

function main(args) {
	if (args.includes('--selftest')) { selftest(); process.exit(process.exitCode ?? 0); }
	const listArg = (flag) => args.flatMap((a, i) => (args[i - 1] === flag ? [a] : []));
	const oneArg = (flag) => listArg(flag)[0];
	const plan = args.includes('--plan');
	const doCook = args.includes('--cook');
	const editorClosure = args.includes('--editor-closure');

	const uproject = findUproject(process.env.CLAUDE_PROJECT_DIR || process.cwd());
	if (!uproject) { console.log('cook-check: no .uproject above the current directory'); verdict('UNKNOWN', 2); }
	const root = dirname(uproject);
	const project = uproject.slice(root.length + 1).replace(/\.uproject$/i, '');
	const platform = oneArg('--platform') ?? 'Windows';
	const cookedRoot = resolve(oneArg('--cooked') ?? join(root, 'Saved', 'Cooked', platform));
	const outDir = resolve(oneArg('--out') ?? join(root, 'Saved', 'ContentGates', 'cook-check'));

	let config = {};
	const configPath = join(root, '.claude', 'content-gates.json');
	if (existsSync(configPath)) config = JSON.parse(readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '')).cookCheck ?? {};
	const maps = [...listArg('--map'), ...(config.maps ?? [])].map(packageOf);
	const assets = [...listArg('--asset'), ...(config.assets ?? [])].map(packageOf);
	const dirs = [...listArg('--dir'), ...(config.dirs ?? [])].map((d) => packageOf(d).replace(/\/?$/, '/'));
	const ignore = (config.ignoreMissing ?? []).map((p) => p.toLowerCase());
	const configFiles = config.configFiles ?? ['DefaultGame.ini', 'DefaultEngine.ini'];
	const slots = configFiles.filter((f) => existsSync(join(root, 'Config', f)))
		.flatMap((f) => configSlots(readFileSync(join(root, 'Config', f), 'utf8'), f));
	const roots = [...new Set([...maps, ...assets, ...dirs, ...slots.map((s) => s.package)])];
	if (!roots.length) { console.log('cook-check: empty reference set - name --map/--asset or set cookCheck in .claude/content-gates.json'); verdict('UNKNOWN', 2); }

	const engine = resolveEngine();
	const editorCmd = engine.unrealHome ? join(engine.unrealHome, 'Engine', 'Binaries', 'Win64', 'UnrealEditor-Cmd.exe') : null;
	const editorLine = (commandletArgs) => [uproject, ...commandletArgs, '-unattended', '-nosplash', '-nullrhi', '-stdout', '-FullStdOutLogOutput', '-utf8output']
		.map((a) => (/\s/.test(a) && !a.includes('"') ? `"${a}"` : a)).join(' ');
	const fwd = (p) => p.split('\\').join('/');
	const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
	const closureFile = join(outDir, `${stamp}-closure.json`);
	const closureCommandlet = ['-run=pythonscript', `-script="${fwd(join(PyDir, 'cook-closure.py'))} ${fwd(closureFile)} ${roots.join(' ')}"`];
	const cookCommandlet = ['-run=cook', `-targetplatform=${platform}`, '-unversioned', ...(maps.length ? [`-map=${maps.join('+')}`] : [])];

	console.log(`cook-check: ${project}, ${platform}; ${roots.length} root(s) (${maps.length} map(s), ${assets.length} asset(s), ${dirs.length} dir(s), ${slots.length} config slot(s))`);
	if (plan) {
		for (const r of roots) console.log(`  root ${r}`);
		console.log(`closure: ${editorClosure ? `${editorCmd} ${editorLine(closureCommandlet)}` : `python ${join(PyDir, 'offline_closure.py')} <out.json> ${roots.join(' ')}`}`);
		if (doCook) console.log(`cook:    ${editorCmd} ${editorLine(cookCommandlet)}`);
		console.log(`cooked set: ${cookedRoot}`);
		verdict('UNKNOWN', 0);
	}

	// No cook on disk and none requested: say so before anything expensive runs.
	if (!doCook && !readCookedSet(cookedRoot, project)) {
		console.log(`cook-check: no cook present at ${cookedRoot} - nothing to compare.`);
		console.log('  Cook first (Platforms > Cook Content, or UAT BuildCookRun -cook) and rerun, or pass --cook to let this script cook.');
		verdict('UNKNOWN', 2);
	}

	mkdirSync(outDir, { recursive: true });
	if (doCook || editorClosure) {
		if (!editorCmd || !existsSync(editorCmd)) { console.log(`cook-check: ${engine.error ?? `no ${editorCmd}`}`); verdict('UNKNOWN', 2); }
		gate(root);
	}
	const runEditor = (commandletArgs, logName) => {
		const log = join(outDir, `${stamp}-${logName}.log`);
		// Verbatim: `-script="file.py a b"` must reach the engine's parser with the quotes after the `=`.
		const run = spawnSync(editorCmd, [editorLine(commandletArgs)], { encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 30, windowsVerbatimArguments: true });
		writeFileSync(log, (run.stdout ?? '') + (run.stderr ?? ''));
		return { status: run.status, log, text: (run.stdout ?? '') + (run.stderr ?? '') };
	};

	let cookLog = null;
	let cookIssues = [];
	if (doCook) {
		console.log(`cook-check: cooking ${platform}...`);
		const cook = runEditor(cookCommandlet, 'cook');
		cookLog = cook.log;
		cookIssues = cook.text.split(/\r?\n/).filter((l) => /(Warning|Error):/.test(l) && /(import|Unable to|missing|not found|Failed to load|Couldn't find)/i.test(l));
		if (cook.status !== 0) { console.log(`cook-check: the cook failed (exit ${cook.status}) - see ${cook.log}`); verdict('FAILED', 1); }
	}
	if (editorClosure) {
		console.log('cook-check: closure from the editor asset registry...');
		const run = runEditor(closureCommandlet, 'closure');
		if (!existsSync(closureFile)) { console.log(`cook-check: the closure commandlet wrote nothing (exit ${run.status}) - see ${run.log}`); verdict('UNKNOWN', 2); }
	}
	if (!editorClosure) {
		const py = findPython();
		if (!py) { console.log('cook-check: no Python 3 on PATH (set PYTHON) - the offline closure needs it'); verdict('UNKNOWN', 2); }
		const pyArgs = [...py[1], '-B', join(PyDir, 'offline_closure.py'), closureFile, '--project', root, ...(engine.unrealHome ? ['--engine', engine.unrealHome] : []), ...roots];
		const run = spawnSync(py[0], pyArgs, { encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 28 });
		if (run.status !== 0 || !existsSync(closureFile)) { console.log(`cook-check: offline closure failed:\n${run.stdout}${run.stderr}`); verdict('UNKNOWN', 2); }
		console.log(run.stdout.trim());
	}
	const closure = JSON.parse(readFileSync(closureFile, 'utf8'));
	const cooked = readCookedSet(cookedRoot, project);
	if (!cooked) { console.log(`cook-check: nothing cooked under ${cookedRoot}`); verdict('UNKNOWN', 2); }

	const ignored = (name) => ignore.some((p) => name.toLowerCase().startsWith(p));
	const expected = Object.entries(closure.packages).filter(([, p]) => p.class);
	const missing = expected.filter(([name]) => !cooked.has(name) && !ignored(name)).map(([name, p]) => ({ package: name, ...p }));
	const unresolved = closure.unresolved.filter((u) => !ignored(u.package));
	const slotRows = slots.filter((s) => !s.package.endsWith('/')).map((s) => ({ ...s, cooked: cooked.has(s.package), onDisk: !!closure.packages[s.package]?.class }));
	const rootRows = [...maps, ...assets].map((r) => ({ root: r, cooked: cooked.has(r) }));
	// A cook older than the content it is compared with reports every later addition as missing.
	const cookTime = statSync(cooked.source).mtimeMs;
	const newer = expected.filter(([, p]) => p.file && existsSync(p.file) && statSync(p.file).mtimeMs > cookTime).length;
	const byClass = {};
	for (const m of missing) byClass[m.class] = (byClass[m.class] ?? 0) + 1;

	const summary = {
		when: new Date().toISOString(), project, platform, closureMode: closure.mode ?? 'editor', cookedFrom: cooked.source, cookLog,
		cookedAt: new Date(cookTime).toISOString(), newerThanCook: newer,
		expected: expected.length, cookedPackages: cooked.size, missing: missing.length, unresolved: unresolved.length, cookIssues: cookIssues.length,
		roots: rootRows, slots: slotRows, missingByClass: byClass, missingList: missing, unresolvedList: unresolved, cookIssueLines: cookIssues.slice(0, 200),
	};
	const jsonOut = join(outDir, `${stamp}.json`);
	writeFileSync(jsonOut, JSON.stringify(summary, null, 1));
	const md = [
		`# Cook check — ${project}, ${platform}, ${summary.when.slice(0, 16)}`, '',
		`- closure: ${summary.closureMode}; cooked set: \`${cooked.source}\` (${summary.cookedAt.slice(0, 16)})`,
		...(newer ? [`- **${newer} expected package(s) changed after this cook** - recook before trusting MISSING`] : []),
		`- expected packages: **${expected.length}** · cooked packages: **${cooked.size}**`,
		`- missing from the cook: **${missing.length}** · referenced but not on disk: **${unresolved.length}** · cook-log issues: **${cookIssues.length}**`, '',
		'## Reference set', '', '| Asset | Cooked |', '| --- | --- |',
		...rootRows.map((r) => `| \`${r.root}\` | ${r.cooked ? 'yes' : '**NO**'} |`), '',
		'## Config slots', '', '| File | Key | Asset | Cooked |', '| --- | --- | --- | --- |',
		...slotRows.map((s) => `| ${s.file} | ${s.key} | \`${s.path}\` | ${s.cooked ? 'yes' : s.onDisk ? '**NO**' : '**not on disk**'} |`), '',
		'## Missing from the cook', '',
		...(missing.length ? ['| Package | Class | Referenced by |', '| --- | --- | --- |', ...missing.map((m) => `| \`${m.package}\` | ${m.class} | \`${m.from || '(root)'}\` |`)] : ['None.']), '',
		'## Referenced but not on disk', '',
		...(unresolved.length ? unresolved.map((u) => `- \`${u.package}\` ← \`${u.from || '(root)'}\``) : ['None.']), '',
	];
	const mdOut = join(outDir, `${stamp}.md`);
	writeFileSync(mdOut, md.join('\n'));

	console.log(`expected ${expected.length} · cooked ${cooked.size} · missing ${missing.length} · unresolved ${unresolved.length} · cook-log issues ${cookIssues.length}`);
	if (newer) console.log(`  WARNING ${newer} expected package(s) are newer than the cook (${summary.cookedAt.slice(0, 16)}) - recook before trusting MISSING`);
	for (const r of rootRows) console.log(`  ${r.cooked ? 'ok     ' : 'MISSING'} ${r.root}`);
	for (const s of slotRows) if (!s.cooked) console.log(`  MISSING slot ${s.file} ${s.key} = ${s.path}`);
	for (const [cls, n] of Object.entries(byClass).sort((a, b) => b[1] - a[1])) console.log(`  missing ${n} x ${cls}`);
	for (const u of unresolved.slice(0, 10)) console.log(`  UNRESOLVED ${u.package} <- ${u.from || '(root)'}`);
	console.log(`report: ${mdOut}`);
	const clean = !missing.length && !unresolved.length && rootRows.every((r) => r.cooked) && slotRows.every((s) => s.cooked);
	verdict(clean ? 'OK' : 'FAILED', clean ? 0 : 1);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main(process.argv.slice(2));
