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

const DeclRe = /\b(?:IMPLEMENT_[A-Z_]*AUTOMATION_TEST|BEGIN_DEFINE_SPEC|DEFINE_SPEC|TEST_CLASS(?:_[A-Z_]+)?)\s*\([^"();]*"([A-Za-z_][A-Za-z0-9_]*)[."]/g;
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

/** Every suite prefix declared under Source/ or Plugins/ of `projectDir`, sorted. */
export function declaredSuites(projectDir) {
	const found = new Set();
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
			if (!body.includes('AUTOMATION_TEST') && !body.includes('DEFINE_SPEC') && !body.includes('TEST_CLASS')) continue;
			for (const s of suitesInText(body)) found.add(s);
		}
	}
	return [...found].sort();
}

/**
 * The minimal set that still selects everything: RunTests matches by PREFIX, so a suite whose name starts
 * with another declared suite is already selected by it (`Vehicle` covers `VehicleTools`). Pure.
 */
export function coveringSet(suites) {
	return suites.filter((s) => !suites.some((o) => o !== s && s.startsWith(o)));
}

/** The full-pass filter for a project, or '' when it declares no suite. */
export function fullPassFilter(projectDir) {
	return coveringSet(declaredSuites(projectDir)).join('+');
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
		eq(fullPassFilter(root), 'Combat+Game', 'fixture: covering filter');
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
