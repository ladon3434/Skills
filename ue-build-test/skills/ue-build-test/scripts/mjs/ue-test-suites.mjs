// ue-test-suites — which automation suites THIS project declares, read from its source tree.
//
// Why derived and not written down: a hand-kept list of suites drifts from the code (a suite gets added, the
// list does not, its tests never run under a full pass that still prints PASS). The source tree cannot drift:
// every test declares its full path, and the first segment of that path is its suite.
//
// Recognised declarations (the first string literal inside the macro is the test path):
//   IMPLEMENT_SIMPLE_AUTOMATION_TEST(Class, "Suite.Sub.Name", Flags)
//   IMPLEMENT_COMPLEX_AUTOMATION_TEST(Class, "Suite.Sub.Name", Flags)
//   IMPLEMENT_CUSTOM_SIMPLE_AUTOMATION_TEST(Class, Base, "Suite.Sub.Name", Flags)   (and _COMPLEX_)
//   BEGIN_DEFINE_SPEC(Class, "Suite.Sub", Flags) / DEFINE_SPEC(Class, "Suite.Sub", Flags)
//   TEST_CLASS(Class, "Suite.Sub") / TEST_CLASS_WITH_*(Class, "Suite.Sub", ...)   (CQTest: a directory; the class name follows)
// Scanned: Source/ and Plugins/ (plugins with Source only), skipping generated trees.
//
//   node ue-test-suites.mjs [--project p]            suites, one per line
//   node ue-test-suites.mjs [--project p] --filter   the covering set joined with '+', as RunTests wants it
//   node ue-test-suites.mjs --selftest

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The path literal may sit inside TEXT("..."); CQTest's one-method TEST(Name, "Path") declares a class as well.
const DeclRe = /\b(?:IMPLEMENT_[A-Z_]*AUTOMATION_TEST|BEGIN_DEFINE_SPEC|DEFINE_SPEC|TEST_CLASS(?:_[A-Z_]+)?|TEST)\s*\((?:[^"();]|TEXT\s*\()*"([A-Za-z_][A-Za-z0-9_]*)([."])/g;
// A CQTest class whose folder the engine derives from the source path: its suite is not in the text.
const GeneratedDirRe = /\b(?:TEST_CLASS(?:_[A-Z_]+)?|TEST)\s*\([^"();]*\bGenerateTestDirectory\b/;
const SkipRe = /(^|[\\/])(Binaries|Intermediate|Saved|DerivedDataCache|ThirdParty)[\\/]/;

/** Suite prefixes declared in one file's text. Pure. */
export function suitesInText(text) {
	const found = new Set();
	// Comments out first: a commented-out test is not a test. A wrapper macro is kept on purpose -
	// `#define MY_TEST(N) IMPLEMENT_SIMPLE_AUTOMATION_TEST(F##N, "Suite." #N, ...)` declares Suite for every use;
	// one whose path is a macro parameter carries no literal and yields nothing.
	const code = String(text).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
	for (const m of code.matchAll(DeclRe)) found.add(m[1]);
	return [...found];
}

const stripComments = (text) => String(text).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

/** Suites whose every declaration in the text is a ONE-segment path (`"Solo"`): `StartsWith:Solo` would miss them. Pure. */
export function oneSegmentSuites(text) {
	const dotted = new Set();
	const bare = new Set();
	for (const m of stripComments(text).matchAll(DeclRe)) (m[2] === '.' ? dotted : bare).add(m[1]);
	return [...bare].filter((s) => !dotted.has(s));
}

/** Does the text declare a CQTest class with `GenerateTestDirectory` (a suite this scan cannot name)? Pure. */
export const declaresGeneratedDir = (text) => GeneratedDirRe.test(stripComments(text));

/** Walks the project's test sources once: {suites, bare (one-segment only), generated (files with GenerateTestDirectory)}. */
export function scanSuites(projectDir) {
	const suites = new Set();
	const bare = new Set();
	const dotted = new Set();
	const generated = [];
	const declared = {}; // suite -> number of declarations in the source
	for (const top of ['Source', 'Plugins']) {
		const abs = join(projectDir, top);
		if (!existsSync(abs)) continue;
		let entries = [];
		try {
			entries = readdirSync(abs, { recursive: true, encoding: 'utf8' });
		} catch {
			continue;
		}
		for (const rel of entries) {
			if (SkipRe.test(rel) || !/\.(cpp|h|inl)$/i.test(rel)) continue;
			let body;
			try {
				body = readFileSync(join(abs, rel), 'utf8');
			} catch {
				continue;
			}
			if (!/AUTOMATION_TEST|DEFINE_SPEC|TEST_CLASS|\bTEST\s*\(/.test(body)) continue;
			const all = suitesInText(body);
			const one = new Set(oneSegmentSuites(body));
			for (const s of all) { suites.add(s); (one.has(s) ? bare : dotted).add(s); }
			for (const m of stripComments(body).matchAll(DeclRe)) declared[m[1]] = (declared[m[1]] ?? 0) + 1;
			if (declaresGeneratedDir(body)) generated.push(join(top, rel));
		}
	}
	return { suites: [...suites].sort(), bare: [...bare].filter((s) => !dotted.has(s)).sort(), generated, declared };
}

/**
 * Suites that ran FEWER tests than the source declares. A declaration is at least one test (a complex test or a
 * spec is many), so the count of declarations is a floor: fewer tests than that means some never registered -
 * the cold-start race, an old DLL, a module that did not load. Tests excluded by their flags make it a warning,
 * not a verdict. `ranPaths` - every test path of the run. Pure.
 * @returns {{suite: string, declared: number, ran: number}[]}
 */
export function shortSuites(declared, ranPaths) {
	const out = [];
	for (const [suite, n] of Object.entries(declared)) {
		const prefix = `${suite.toLowerCase()}.`;
		const ran = ranPaths.filter((p) => p.toLowerCase() === suite.toLowerCase() || p.toLowerCase().startsWith(prefix)).length;
		if (ran > 0 && ran < n) out.push({ suite, declared: n, ran });
	}
	return out.sort((a, b) => a.suite.localeCompare(b.suite));
}

/** Every suite prefix declared under Source/ or Plugins/ of `projectDir`, sorted. */
export function declaredSuites(projectDir) {
	return scanSuites(projectDir).suites;
}

/**
 * Suites not already selected by another one when tokens match by PREFIX (`Vehicle` covers `VehicleTools`). Pure.
 * Only for plain tokens: a `StartsWith:` token ends at the dot and covers nothing but its own suite.
 */
export function coveringSet(suites) {
	return suites.filter((s) => !suites.some((o) => o !== s && s.startsWith(o)));
}

/**
 * RunTests tokens that select exactly the declared suites. A plain token matches as a SUBSTRING of the test path
 * (`Game` would also run the engine's `...GameplayTags...` tests), so each suite goes as `StartsWith:<Suite>`,
 * which the engine matches as the prefix `<Suite>.`. A suite declared only as a one-segment path (`"Solo"`) has
 * no dot to match and stays a plain token. Pure.
 */
export function filterTokens(suites, bare = []) {
	return suites.map((s) => (bare.includes(s) ? s : `StartsWith:${s}`));
}

/** The full-pass filter for a project, or '' when it declares no suite. */
export function fullPassFilter(projectDir) {
	const { suites, bare } = scanSuites(projectDir);
	return filterTokens(suites, bare).join('+');
}

export function selftest({ realProject } = {}) {
	const fail = [];
	const eq = (a, b, m) => {
		if (JSON.stringify(a) !== JSON.stringify(b)) fail.push(`${m}: got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`);
	};

	eq(suitesInText('IMPLEMENT_SIMPLE_AUTOMATION_TEST(FA, "Game.Inventory.Add", EAutomationTestFlags::EditorContext)'), ['Game'], 'simple test');
	eq(suitesInText('IMPLEMENT_CUSTOM_SIMPLE_AUTOMATION_TEST(FB, FMyBase, "GameTools.Import", F)'), ['GameTools'], 'custom test: path is the third argument');
	eq(suitesInText('BEGIN_DEFINE_SPEC(FSpec, "Combat.Damage", F)\nEND_DEFINE_SPEC(FSpec)'), ['Combat'], 'spec');
	eq(suitesInText('IMPLEMENT_COMPLEX_AUTOMATION_TEST(FC, "Solo", F)'), ['Solo'], 'a one-segment path');
	eq(suitesInText('TEST_CLASS(InventoryTests, "Game.Inventory")'), ['Game'], 'CQTest class');
	eq(suitesInText('TEST_CLASS_WITH_FLAGS(NetTests, "Net.Replication", EAutomationTestFlags::EditorContext)'), ['Net'], 'CQTest class with flags');
	eq(suitesInText('#define IMPLEMENT_MY_AUTOMATION_TEST(C, P) IMPLEMENT_SIMPLE_AUTOMATION_TEST(C, P, F)'), [], 'a wrapper whose path is a parameter declares nothing');
	eq(suitesInText('    #define COMBAT_TEST(Name) IMPLEMENT_SIMPLE_AUTOMATION_TEST(FCombat##Name##Test, "Combat." #Name, F)'), ['Combat'], 'a wrapper with a literal prefix declares its suite');
	eq(suitesInText('/* IMPLEMENT_SIMPLE_AUTOMATION_TEST(FX, "Block.Commented", F) */'), [], 'a block-commented test is not a test');
	eq(suitesInText('// IMPLEMENT_SIMPLE_AUTOMATION_TEST(FD, "Commented.Out", F)'), [], 'a commented-out test is not a test');
	eq(suitesInText('IMPLEMENT_SIMPLE_AUTOMATION_TEST(FE, "WorldAuthoring.X", F)'), ['WorldAuthoring'], 'a long name survives whole');
	eq(coveringSet(['Game', 'GameTools', 'Combat']), ['Game', 'Combat'], 'a prefix covers its extension');
	eq(suitesInText('TEST(SmokeTest, "Game.Smoke")'), ['Game'], 'CQTest one-method TEST');
	eq(suitesInText('IMPLEMENT_SIMPLE_AUTOMATION_TEST(FT, TEXT("Game.Text"), F)'), ['Game'], 'a path inside TEXT()');
	eq(suitesInText('TEST_METHOD(DoesThing)'), [], 'a TEST_METHOD declares no suite');
	eq(declaresGeneratedDir('TEST_CLASS(InvTests, GenerateTestDirectory)'), true, 'a generated test directory is noticed');
	eq(declaresGeneratedDir('TEST_CLASS(InvTests, "Game.Inv")'), false, 'a literal directory is not');
	eq(oneSegmentSuites('IMPLEMENT_COMPLEX_AUTOMATION_TEST(FC, "Solo", F)\nTEST(A, "Game.X")'), ['Solo'], 'a one-segment path is told apart');
	eq(filterTokens(['Game', 'GameTools', 'Solo'], ['Solo']), ['StartsWith:Game', 'StartsWith:GameTools', 'Solo'], 'suites go as StartsWith tokens, a one-segment suite as a plain one');

	// Fixture tree: suites under Source and a plugin, generated trees ignored.
	const root = mkdtempSync(join(tmpdir(), 'ue-suites-'));
	try {
		const put = (rel, text) => {
			mkdirSync(dirname(join(root, rel)), { recursive: true });
			writeFileSync(join(root, rel), text);
		};
		put('Source/Game/Private/Tests/A.cpp', 'IMPLEMENT_SIMPLE_AUTOMATION_TEST(FA, "Game.A", F)');
		put('Source/Game/Private/Other.cpp', 'BEGIN_DEFINE_SPEC(FS, "Combat.Spec", F)');
		put('Plugins/Kit/Source/Kit/Private/K.cpp', 'IMPLEMENT_SIMPLE_AUTOMATION_TEST(FK, "GameKit.K", F)');
		put('Plugins/Kit/Intermediate/Build/Gen.cpp', 'IMPLEMENT_SIMPLE_AUTOMATION_TEST(FG, "Generated.G", F)');
		eq(declaredSuites(root), ['Combat', 'Game', 'GameKit'], 'fixture: declared suites');
		put('Source/Game/Private/Tests/Gen.cpp', 'TEST_CLASS(GenTests, GenerateTestDirectory)\n{\n};');
		eq(fullPassFilter(root), 'StartsWith:Combat+StartsWith:Game+StartsWith:GameKit', 'fixture: full-pass filter');
		eq(scanSuites(root).generated.length, 1, 'fixture: the file with a generated test directory is reported');
		eq(Object.entries(scanSuites(root).declared).sort(), [['Combat', 1], ['Game', 1], ['GameKit', 1]], 'fixture: declarations counted per suite');
		eq(shortSuites({ Game: 3, Combat: 1, Net: 2 }, ['Game.A', 'Combat.X', 'Combat.Y']), [{ suite: 'Game', declared: 3, ran: 1 }],
			'a suite that ran fewer tests than it declares is short; one that ran none is the coverage check\'s business');
		eq(fullPassFilter(join(root, 'nope')), '', 'no source -> empty filter');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}

	// A real project, read-only, when given: it must declare something and the covering set must reach it all.
	if (realProject) {
		const suites = declaredSuites(realProject);
		const cover = coveringSet(suites);
		if (!suites.length) fail.push(`${realProject}: no suites found`);
		if (!suites.every((s) => cover.some((c) => s.startsWith(c)))) fail.push('covering set misses a declared suite');
		console.log(`  real project ${realProject}: ${suites.length} suites -> filter ${cover.join('+')}`);
	}
	return fail;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
	const { parseArgs, locateProject } = await import('./ue-tools.mjs');
	const args = parseArgs(process.argv.slice(2), { project: {}, filter: { type: 'bool' }, selftest: { type: 'bool' }, help: { type: 'bool' } });
	if (args.help) {
		console.log('usage: ue-test-suites.cmd [--project p] [--filter] | --selftest [--project p]');
		process.exit(0);
	}
	if (args.selftest) {
		const loc = args.project ? locateProject({ project: args.project }) : null;
		const fail = selftest({ realProject: loc?.uproject ? dirname(loc.uproject) : undefined });
		for (const f of fail) console.log(`  FAIL ${f}`);
		console.log(fail.length ? `ue-test-suites selftest: ${fail.length} failed` : 'ue-test-suites selftest: passed');
		process.exit(fail.length ? 1 : 0);
	}
	const loc = locateProject({ project: args.project });
	if (loc.error) {
		console.log(loc.error);
		process.exit(1);
	}
	const dir = dirname(loc.uproject);
	if (args.filter) console.log(fullPassFilter(dir));
	else for (const s of declaredSuites(dir)) console.log(s);
}
