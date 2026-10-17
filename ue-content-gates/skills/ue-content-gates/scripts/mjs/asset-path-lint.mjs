// asset-path-lint — the code a game ships does not name the game's own assets.
//
// It refuses, in every module the cooked game ships, a `"/Game/…"` (or `"/<PluginMount>/…"`) string that names
// an asset, and a `ConstructorHelpers` finder aimed at anything but the engine. The asset belongs where a
// designer and the cooker both see it — a config property, a Blueprint default, a data asset — and the code
// reads it from there.
//
// Usage: asset-path-lint.cmd <file...>              judge these files whole (paths relative to the project root)
//        asset-path-lint.cmd --staged [<file...>]   only the lines the git index adds (pre-commit); no files =
//                                                   every staged C++ file
//        asset-path-lint.cmd --all                  every shipped module: the debt inventory
//        asset-path-lint.cmd --root <dir>           the project root (default: nearest .uproject up from cwd)
//        asset-path-lint.cmd --selftest
// Exit: 0 clean · 1 findings · 2 usage/setup error (the gate could not run — a pre-commit hook must block on it).
//
// WHY. The cooker follows references it can see in packages and config; a `TEXT("/Game/…")` handed to
// `LoadObject` at run time is not one, so the asset is cooked only while something else happens to pull it in,
// and the shipped game loses it the day that something moves. The editor's rename fixes packages and
// redirectors, never a string in C++. Nothing fails loudly in the editor, where `LoadObject` finds the uncooked
// file on disk every time.
//
// WHAT IS GAME CODE — derived from the descriptors, never listed: the `.uproject` and every `.uplugin` under
// `Plugins/` carry each module's `Type`. Editor, developer and UncookedOnly modules never reach the cooked game
// (editor tooling manipulates `/Game/` paths by design) and are outside. Tests (a `Tests/` folder or a
// `…Test(s).cpp/.h` file) are outside too: a test that finds its asset by path breaks loudly when it moves.
//
// A PATH IS AN ASSET WHEN IT NAMES ONE: `TEXT("/Game/")` and `TEXT("/Game/L10N/")` end in `/` and are folders
// the code does arithmetic with; they pass. `ConstructorHelpers` is refused whole unless every string on its
// line is an `/Engine/` or `/Script/` path; a finder fed from a variable is refused too.
//
// THE DELIBERATE PATH HAS A FORM: `// asset-path-ok: <why>` on the line or the line above it.

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findUproject } from './ue-engine.mjs';

// The module types that reach a cooked game (UBT's ModuleHostType). Everything else — Editor*, Developer*,
// UncookedOnly, Program — is built only into the editor or a tool.
const ShippedTypes = new Set(['Runtime', 'RuntimeNoCommandlet', 'RuntimeAndProgram', 'CookedOnly', 'ClientOnly', 'ClientOnlyNoCommandlet', 'ServerOnly']);
const SourceExtensions = ['.cpp', '.h', '.inl'];
const AllowMarker = /\/\/\s*asset-path-ok:\s*\S/;
const TestFile = /(^|[\\/])Tests?[\\/]|Tests?\.(cpp|h|inl)$/;
const EngineOwned = /^\/(Engine|Script)\//;

/** `{name, type}` for every module a descriptor declares. A descriptor that does not parse throws: a gate that
 *  cannot tell what ships must not answer «nothing ships». */
function descriptorModules(path) {
	const json = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
	return (json.Modules ?? []).map((m) => ({ name: m.Name, type: m.Type }));
}

/** The `Source/<Module>` dirs (root-relative, `/`-separated) of every shipped module, and the content mounts
 *  (`/Game/` plus `/<Plugin>/` for each plugin with a Content folder). */
export function projectLayout(root) {
	const dirs = [];
	const mounts = ['/Game/'];
	const add = (base, descriptor) => {
		for (const m of descriptorModules(descriptor)) {
			if (ShippedTypes.has(m.type)) dirs.push(relative(root, join(base, 'Source', m.name)).split(sep).join('/'));
		}
	};
	const project = readdirSync(root).find((f) => f.toLowerCase().endsWith('.uproject'));
	if (!project) throw new Error(`no .uproject in ${root}`);
	add(root, join(root, project));
	const walk = (dir, depth) => {
		if (!existsSync(dir)) return;
		for (const entry of readdirSync(dir)) {
			const full = join(dir, entry);
			if (entry.toLowerCase().endsWith('.uplugin')) {
				add(dir, full);
				if (existsSync(join(dir, 'Content'))) mounts.push(`/${basename(entry, '.uplugin')}/`);
			} else if (depth > 0 && statSync(full).isDirectory()) walk(full, depth - 1);
		}
	};
	walk(join(root, 'Plugins'), 3);
	return { dirs, mounts };
}

/** Whether a root-relative source file is game code this gate judges. Pure. */
export function inScope(file, moduleDirs) {
	const p = file.split(/[\\/]/).join('/');
	if (!SourceExtensions.some((e) => p.endsWith(e))) return false;
	if (TestFile.test(p)) return false;
	return moduleDirs.some((d) => p.startsWith(d + '/'));
}

/** Each line with its comments cut away (one left-to-right pass that knows strings and comments together:
 *  a `//` inside a string is data, an apostrophe inside a comment is prose). Pure. */
export function codeLines(text) {
	let inBlock = false;
	return text.split(/\r?\n/).map((line) => {
		let out = '';
		let i = 0;
		if (inBlock) {
			const end = line.indexOf('*/');
			if (end < 0) return '';
			inBlock = false;
			i = end + 2;
		}
		while (i < line.length) {
			const ch = line[i];
			if (ch === '"' || ch === "'") {
				const start = i;
				i++;
				while (i < line.length && line[i] !== ch) i += line[i] === '\\' ? 2 : 1;
				i++;
				out += line.slice(start, i);
				continue;
			}
			if (ch === '/' && line[i + 1] === '/') break;
			if (ch === '/' && line[i + 1] === '*') {
				const end = line.indexOf('*/', i + 2);
				if (end < 0) { inBlock = true; break; }
				i = end + 2;
				out += ' ';
				continue;
			}
			out += ch;
			i++;
		}
		return out;
	});
}

const literals = (code) => [...code.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1] ?? '');

/** Every asset path this file's code names. `only` narrows the verdict to those line numbers. Pure. */
export function scanText(file, text, mounts = ['/Game/'], only = null) {
	const found = [];
	const raw = text.split(/\r?\n/);
	const assetMount = new RegExp(`^(${mounts.map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`);
	codeLines(text).forEach((code, index) => {
		const line = index + 1;
		if (only && !only.has(line)) return;
		if (AllowMarker.test(raw[index] ?? '') || (index > 0 && AllowMarker.test(raw[index - 1] ?? ''))) return;
		if (/^\s*#\s*include\b/.test(code)) return;
		const strings = literals(code);
		const shown = (raw[index] ?? '').trim();
		if (/\bConstructorHelpers::/.test(code) && !(strings.length && strings.every((s) => EngineOwned.test(s)))) {
			found.push({ file, line, text: shown, why: 'ConstructorHelpers aimed at a project asset' });
			return;
		}
		const path = strings.find((s) => assetMount.test(s) && !s.endsWith('/'));
		if (path) found.push({ file, line, text: shown, why: `names the asset ${path}` });
	});
	return found;
}

/** Line numbers a unified diff with `-U0` adds on the new side. Pure. */
export function addedLines(diff) {
	const lines = new Set();
	for (const m of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
		const start = Number(m[1]);
		const count = m[2] === undefined ? 1 : Number(m[2]);
		for (let i = 0; i < count; i++) lines.add(start + i);
	}
	return lines;
}

/** The lines the index adds to one file. Run from the file's own folder, so a plugin that is its own git
 *  repository (a submodule) answers from its own index. */
function stagedAddedLines(full) {
	const diff = execFileSync('git', ['diff', '--cached', '-U0', '--', basename(full)], { cwd: dirname(full), encoding: 'utf8', windowsHide: true });
	return addedLines(diff);
}

function stagedFiles(root) {
	const out = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], { cwd: root, encoding: 'utf8', windowsHide: true });
	return out.split(/\r?\n/).filter(Boolean);
}

function walkSources(root, dir, out) {
	const full = join(root, dir);
	if (!existsSync(full)) return;
	for (const entry of readdirSync(full)) {
		const rel = `${dir}/${entry}`;
		if (statSync(join(root, rel)).isDirectory()) walkSources(root, rel, out);
		else out.push(rel);
	}
}

function selftest() {
	let failed = 0;
	const eq = (actual, expected, what) => {
		const a = JSON.stringify(actual), b = JSON.stringify(expected);
		if (a !== b) { console.error(`FAIL: ${what}\n  expected ${b}\n  got      ${a}`); failed++; }
	};
	const lines = (src, only = null) => scanText('X.cpp', src, ['/Game/', '/MyPlugin/'], only).map((f) => f.line);

	eq(lines('auto M = LoadObject<UStaticMesh>(nullptr, TEXT("/Game/Props/SM_Gun.SM_Gun"));\n'), [1], 'a LoadObject by path is refused');
	eq(lines('const TCHAR* const P = TEXT("/Game/Assets/MPC_Look.MPC_Look");\n'), [1], 'a path held in a constant is refused as well');
	eq(lines('FSoftObjectPath P(TEXT("/MyPlugin/UI/T_Icon.T_Icon"));\n'), [1], 'a plugin content path is refused too');
	eq(lines('static ConstructorHelpers::FObjectFinder<UStaticMesh> F(TEXT("/Game/Props/SM_Gun"));\n'), [1], 'a finder on a project asset is refused');
	eq(lines('static ConstructorHelpers::FObjectFinder<UStaticMesh> F(TEXT("/Engine/BasicShapes/Cube.Cube"));\n'), [], 'a finder on an engine shape passes');
	eq(lines('static ConstructorHelpers::FClassFinder<APawn> F(*PawnPath);\n'), [1], 'a finder fed from a variable is refused');
	eq(lines('#include "UObject/ConstructorHelpers.h"\n'), [], 'the include is not a use');
	eq(lines('if(!Package.StartsWith(TEXT("/Game/")))\n'), [], 'the /Game/ root is a folder, not an asset');
	eq(lines('Excluded.Add(TEXT("/Game/Developers/"));\n'), [], 'any folder ending in / passes');
	eq(lines('// the look lives in "/Game/Assets/MPC_Look"\nint X;\n'), [], 'a path inside a comment is prose');
	eq(lines('/* "/Game/A.A"\n   "/Game/B.B" */\nint X;\n'), [], 'and inside a block comment on every line of it');
	eq(lines("/* the engine's \"/Game/A.A\" */ auto P = TEXT(\"/Game/B.B\");\n"), [1], 'code after a closed block comment is still judged');
	eq(lines('Log(TEXT("a // b")); auto P = TEXT("/Game/C.C");\n'), [1], 'a // inside a string does not hide the rest of the line');
	eq(lines('// asset-path-ok: the splash must load before config\nauto S = TEXT("/Game/Splash/T_Splash.T_Splash");\n'), [], 'a marker above lets it stay');
	eq(lines('auto S = TEXT("/Game/Splash/T_Splash.T_Splash"); // asset-path-ok: boot splash\n'), [], 'and on the same line');
	eq(lines('int A;\nauto M = TEXT("/Game/X/Y.Y");\nauto N = TEXT("/Game/X/Z.Z");\n', new Set([3])), [3], 'the staged mode judges only the added lines');
	eq(lines('Log(TEXT("see \\"/Game/X.X\\""));\n'), [], 'a path that is not the start of a string is not an asset reference');
	eq([...addedLines('@@ -1,0 +2,2 @@\n+a\n+b\n@@ -9 +11 @@\n')], [2, 3, 11], 'added lines from a -U0 diff');

	const dirs = ['Source/MyGame', 'Plugins/Kit/Source/KitRuntime'];
	eq(inScope('Source/MyGame/Private/Look.cpp', dirs), true, 'a runtime module file is game code');
	eq(inScope('Source/MyGameEditor/Private/Linter.cpp', dirs), false, 'an editor module is not');
	eq(inScope('Plugins/Kit/Source/KitRuntime/Private/A.cpp', dirs), true, 'a plugin runtime module is');
	eq(inScope('Source/MyGame/Private/Save/Tests/SaveTests.cpp', dirs), false, 'a test directory is outside');
	eq(inScope('Source/MyGame/Private/SaveTests.cpp', dirs), false, 'a …Tests.cpp file is outside');
	eq(inScope('Source/MyGame/Private/Look.cs', dirs), false, 'only C++ sources are judged');
	eq(inScope('Source/MyGameX/Private/A.cpp', dirs), false, 'a module whose name only starts like a shipped one is not it');

	if (failed) { console.error(`asset-path-lint selftest: ${failed} failure(s)`); return 1; }
	console.log('asset-path-lint selftest: ok');
	return 0;
}

function main(args) {
	if (args.includes('--selftest')) return selftest();
	const rootAt = args.indexOf('--root');
	const uproject = rootAt >= 0 ? null : findUproject(process.env.CLAUDE_PROJECT_DIR || process.cwd());
	const root = rootAt >= 0 ? resolve(args[rootAt + 1]) : uproject ? dirname(uproject) : null;
	if (!root) { console.error('asset-path-lint: no .uproject above the current directory - pass --root <project>'); return 2; }
	const { dirs, mounts } = projectLayout(root);
	const staged = args.includes('--staged');
	const given = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--root');
	let files;
	if (args.includes('--all')) {
		files = [];
		for (const d of dirs) walkSources(root, d, files);
	} else if (given.length) {
		files = given.map((f) => relative(root, resolve(f)));
	} else if (staged) {
		files = stagedFiles(root);
	} else {
		console.error('usage: asset-path-lint <file...> | --staged [file...] | --all [--root <dir>] | --selftest');
		return 2;
	}
	files = files.map((f) => f.split(/[\\/]/).join('/')).filter((f) => inScope(f, dirs));
	const findings = [];
	for (const f of files) {
		const full = join(root, f);
		if (!existsSync(full)) continue;
		findings.push(...scanText(f, readFileSync(full, 'utf8'), mounts, staged ? stagedAddedLines(full) : null));
	}
	if (!findings.length) {
		console.log(`asset-path-lint: ${files.length} game source file(s) in ${dirs.length} shipped module(s), no asset path in code.`);
		return 0;
	}
	for (const f of findings) console.log(`${f.file}:${f.line}: ${f.why}\n    ${f.text}`);
	console.log(`\nasset-path-lint: ${findings.length} asset path(s) in game code. The asset goes where the cooker and a designer`);
	console.log('see it - a config property, a Blueprint default or a data asset - and the code reads it from there, logging');
	console.log('an error when it is not set. A path that must stay carries `// asset-path-ok: <why>`.');
	return 1;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) process.exit(main(process.argv.slice(2)));
