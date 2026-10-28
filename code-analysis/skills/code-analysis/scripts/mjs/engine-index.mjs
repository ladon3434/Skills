// engine-index.mjs — the ctags index that sits BEHIND the engine selector.
//
// WHY THIS EXISTS. `engine-api.cmd` searched `Engine/Source` only, and reached `Engine/Plugins` solely
// through an explicit `--module`. The engine has 755 modules in `Engine/Source` and 1813 in
// `Engine/Plugins`: 71% of the corpus answered «no declaration» for symbols that exist. That is not a
// slow answer, it is a WRONG one — ChaosVehicles, RigVM, Water, Niagara, MassEntity and GAS all live in
// plugins, and the agent that believes «такого нет» pays a subagent to rediscover the class.
//
// So the index is bought for COVERAGE, not for speed. Speed is a side effect: `readtags` answers in
// 13–28 ms against a mmap'd index (peak working set 5.4 MB — it binary-searches the file, it does not
// load it), where the ripgrep fallback needs 1.5–2.1 s over both roots (measured on UE 5.8, Windows).
//
// WHAT THIS FILE IS. Two things that must not drift apart: the BUILDER (a CLI) and the LOOKUP the
// selector calls. One recipe, one stamp format, one staleness verdict — the reader of an index and its
// writer are the same module on purpose.
//
// The index lives beside the engine (<engine>/.engine-index), so every project on the machine shares it.
//
// Usage:
//   node engine-index.mjs                 -> build both indexes (engine + templates)
//   node engine-index.mjs --engine        -> engine only
//   node engine-index.mjs --templates     -> the Epic samples corpus only
//   node engine-index.mjs --status        -> where the indexes are and whether they may be trusted
//   node engine-index.mjs --selftest      -> the pure rules (parsing, ranking, staleness), no corpus

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { resolveEngine } from './ue-engine.mjs';

/** Where an index lives: beside the engine it indexes, on the same drive, never inside git.
 *
 * 250 MB of derived data has no business in the repository, and no business on the system drive either.
 * Keeping it under the engine root also gives it the right lifetime: an engine reinstall takes the index
 * with it, and a reinstall is exactly when the index must not survive. */
export function indexHome(unrealHome) {
	// ENGINE_INDEX_HOME moves every index to one shared folder (an engine under Program Files may not be
	// writable); each engine gets its own subfolder there, so two installs never overwrite each other.
	if (process.env.ENGINE_INDEX_HOME) return join(process.env.ENGINE_INDEX_HOME, basename(unrealHome));
	return join(unrealHome, '.engine-index');
}

/**
 * The Epic samples corpus. Machine-local and with no registry key for «where the samples are», so it is
 * UE_SAMPLES_ROOT or nothing — a guessed default would name a folder of one particular machine.
 * @returns {string|null} the root, or null when this machine has no samples checkout
 */
export function templatesRoot(env = process.env) {
	const candidate = env.UE_SAMPLES_ROOT;
	return candidate && existsSync(candidate) ? candidate : null;
}

/** The corpora this module knows how to build. Closed set — the CLI, the status report and the selector
 *  all read it from here. */
export const Corpora = ['engine', 'templates'];

/**
 * The recipe, in one place. Headers only and declaration kinds only: bodies are a subagent's job, so
 * indexing `.cpp` would triple the disk (723.7 MB against 249.6 MB) to answer a question this selector
 * never asks.
 *
 * KINDS. `c`lass `s`truct `e`num-value `g` enum `t`ypedef `d` macro `p`rototype `f`unction `n`amespace
 * `u`nion — the `namespace EFoo { enum Type }` wrapper UE uses for TEnumAsByte-able enums is why `n` is
 * here; without it such a symbol has no tag at all. Deliberately absent: `m` (class members) and `h`
 * (included-header references). Members would grow the index for a question the selector's recipes never
 * answered either, and `h` tags the name of every `#include` line — pure noise.
 *
 * A KIND THAT IS MISSING IS A PERFORMANCE PROBLEM, NOT A CORRECTNESS ONE, and only because of how the
 * selector uses this: an EMPTY index answer falls through to ripgrep instead of being reported as «no
 * such symbol». That fall-through is what makes it safe to index a narrow kind set.
 *
 * NO `--extras=+q`, MEASURED. Qualified extras emit a second `Owner::Member` tag for every member and
 * cost exactly double: 497.5 MB / 2.06 M tags against 255.6 MB / 1.13 M. They buy nothing here, because
 * every member tag already carries its owner in the `class:` field — `Owner::Member` is answered by an
 * exact lookup on the member plus a scope filter, which is the same one call and strictly more precise
 * than searching the owner's whole header.
 */
const CtagsRecipe = [
	'--languages=C++',
	'--kinds-C++=csegtdpfnu',
	'--fields=+n',
	'--exclude=*.cpp',
	'--exclude=Intermediate',
	'--exclude=Binaries',
	'--exclude=ThirdParty',
];

/**
 * Roots of one corpus.
 * @returns {string[]} absolute roots, empty when this machine does not have the corpus
 */
export function corpusRoots(corpus, unrealHome, env = process.env) {
	if (corpus === 'engine') {
		return [join(unrealHome, 'Engine', 'Source'), join(unrealHome, 'Engine', 'Plugins')];
	}
	const templates = templatesRoot(env);
	return templates ? [templates] : [];
}

export function tagsPathFor(corpus, unrealHome) {
	return join(indexHome(unrealHome), `${corpus}.tags`);
}

export function stampPathFor(corpus, unrealHome) {
	return join(indexHome(unrealHome), `${corpus}.stamp.json`);
}

/**
 * The engine's identity, as one comparable string. Patch AND changelist, because a hotfix bumps the
 * changelist while leaving 5.8 alone — and a hotfix moves headers.
 * @returns {string|null} null when the version file cannot be read (a broken install)
 */
export function engineVersionOf(unrealHome) {
	try {
		const v = JSON.parse(readFileSync(join(unrealHome, 'Engine', 'Build', 'Build.version'), 'utf8'));
		return `${v.MajorVersion}.${v.MinorVersion}.${v.PatchVersion}+${v.Changelist}`;
	} catch {
		return null;
	}
}

// #region Staleness

/** The one command that fixes every not-ok verdict below. Named once so the message and the shim agree. */
export const RebuildCommand = 'engine-index.cmd';

/**
 * MAY THIS INDEX BE TRUSTED? Pure, so the rule is testable without an index on disk.
 *
 * A stale index answering confidently is strictly worse than no index: it turns a slow-but-right answer
 * into a fast wrong one, with no signal that anything happened. So the verdict is fail-CLOSED — anything
 * other than a stamp that matches the live engine version means «do not answer from the index», and the
 * caller degrades to ripgrep.
 *
 * TEMPLATES ARE THE DOCUMENTED EXCEPTION, fail-open. The samples corpus has no version file and no
 * signal a refresh ever happened — the owner re-downloads a sample project by hand. Gating it on the
 * ENGINE's version would be a lie (they are unrelated corpora), and walking 1602 files on every selector
 * run to compare a file count would cost more than the lookup it guards. What is done instead: the
 * templates verdict carries its build date, and the selector prints it beside every templates hit, so a
 * human can judge an answer that looks wrong. Accepted cost: a sample signature can be stale and say so
 * only by its date.
 *
 * @param {{corpus: string, tagsExists: boolean, stamp: object|null, liveVersion: string|null}} facts
 * @returns {{ok: boolean, reason: string|null}}
 */
export function stampVerdict(facts) {
	const { corpus, tagsExists, stamp, liveVersion } = facts;
	if (!tagsExists) return { ok: false, reason: `no ${corpus} index built yet` };
	if (!stamp) return { ok: false, reason: `the ${corpus} index has no stamp — an interrupted build leaves exactly this` };
	if (corpus !== 'engine') return { ok: true, reason: null };
	if (!liveVersion) return { ok: false, reason: 'cannot read Engine/Build/Build.version — the engine version is unknown' };
	if (stamp.engineVersion !== liveVersion) {
		return { ok: false, reason: `index built against engine ${stamp.engineVersion}, this engine is ${liveVersion}` };
	}
	return { ok: true, reason: null };
}

/**
 * The verdict against what is actually on disk.
 * @returns {{ok: true, corpus: string, tagsPath: string, stamp: object}
 *          |{ok: false, corpus: string, reason: string, rebuild: string}}
 */
export function indexState(corpus, unrealHome, env = process.env) {
	const tagsPath = tagsPathFor(corpus, unrealHome);
	let stamp = null;
	try {
		stamp = JSON.parse(readFileSync(stampPathFor(corpus, unrealHome), 'utf8'));
	} catch {
		stamp = null;
	}
	const verdict = stampVerdict({
		corpus,
		tagsExists: existsSync(tagsPath),
		stamp,
		liveVersion: corpus === 'engine' ? engineVersionOf(unrealHome) : null,
	});
	if (!verdict.ok) return { ok: false, corpus, reason: verdict.reason, rebuild: RebuildCommand };
	return { ok: true, corpus, tagsPath, stamp };
}

// #endregion

// #region Lookup

/**
 * One readtags line -> a hit. The tag format is TAB-separated, but the middle field is an ex-command
 * holding a line of SOURCE — which can itself contain tabs. So the extension fields are read from the
 * END, while they still look like `name:value`; splitting on tabs positionally silently mis-parses every
 * declaration that happens to be indented with a tab, which in UE headers is most of them.
 * @returns {{name: string, path: string, line: number, kind: string, scope: string|null}|null}
 */
export function parseTagLine(line) {
	const fields = line.split('\t');
	if (fields.length < 3) return null;
	const name = fields[0];
	const path = fields[1];
	if (!name || !path) return null;

	const ext = {};
	for (let i = fields.length - 1; i >= 2; i--) {
		const m = /^([a-zA-Z]+):(.*)$/s.exec(fields[i]);
		if (!m) break;
		ext[m[1]] = m[2];
	}
	const lineNo = Number(ext.line);
	if (!Number.isFinite(lineNo) || lineNo <= 0) return null;
	const scope = ext.class ?? ext.struct ?? ext.namespace ?? ext.union ?? ext.enum ?? null;
	return { name, path: path.replaceAll('\\', '/'), line: lineNo, kind: ext.kind || '?', scope };
}

/** What each tag kind is, in the selector's words. The selector prints these, so they read like its own
 *  recipe names rather than like ctags jargon. */
export const KindLabel = {
	c: 'class declaration',
	s: 'struct declaration',
	g: 'enum declaration',
	e: 'enumerator',
	t: 'typedef/using',
	n: 'namespace',
	u: 'union declaration',
	d: 'macro',
	p: 'function declaration',
	f: 'function definition',
};

// A declaration beats a prototype beats a mention — the same precedence the selector's ripgrep recipes
// encode, so an index answer and a fallback answer rank the same symbol the same way. Anything unlisted
// sorts last.
const KindRank = ['c', 's', 'g', 'n', 'u', 't', 'd', 'p', 'f', 'e'];

/** Declaration-first ordering. Stable within a rank, so two headers declaring the same class keep the
 *  order the index gave them (which is alphabetical by path). */
export function rankHits(hits) {
	return [...hits].sort((a, b) => {
		const ra = KindRank.indexOf(a.kind);
		const rb = KindRank.indexOf(b.kind);
		return (ra === -1 ? KindRank.length : ra) - (rb === -1 ? KindRank.length : rb);
	});
}

/**
 * Does this hit belong to the named module? `--module` narrows by PATH, because that is what a module is
 * in the tags file: `.../Source/Runtime/Engine/...` or `.../Plugins/Experimental/ChaosVehiclesPlugin/...`.
 * Matched as a whole path segment — `Water` must not accept `WaterEditor`.
 */
export function inModule(hitPath, moduleName) {
	if (!moduleName) return true;
	const needle = `/${moduleName.toLowerCase()}/`;
	return hitPath.replaceAll('\\', '/').toLowerCase().includes(needle);
}

/**
 * Does this hit belong to the named owning type? This is how `Owner::Member` is answered without
 * qualified extras: the member's own tag carries `class:Owner` (or `struct:` / `namespace:`), which
 * `parseTagLine` normalises into `scope`.
 *
 * INHERITED MEMBERS ARE NOT FOUND BY THIS, and neither were they before: the ripgrep recipe searched the
 * owner's declaring header, where a base class's member also does not appear. An empty result falls
 * through to ripgrep, so the narrowing can only cost time, never an answer.
 */
export function inScope(hit, ownerType) {
	if (!ownerType) return true;
	return (hit.scope || '').split('::').pop() === ownerType;
}

/**
 * Ask the index. Exact by default, prefix when asked.
 * @returns {{ok: true, hits: object[]}|{ok: false, reason: string}}
 */
export function queryIndex(tagsPath, symbol, { prefix = false, limit = 400 } = {}) {
	const args = ['-t', tagsPath, '-ne'];
	if (prefix) args.push('-p');
	// `-` ends the option list: a symbol starting with `-` would otherwise be read as a flag.
	args.push('-', symbol);
	const run = spawnSync('readtags', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
	if (run.error) {
		return { ok: false, reason: `readtags is not on PATH (${run.error.code || run.error.message})` };
	}
	// readtags exits 0 with empty output when nothing matches — «no hits» is an answer, not a failure.
	if (run.status !== 0) {
		return { ok: false, reason: (run.stderr || '').trim().split('\n')[0] || `readtags exited ${run.status}` };
	}
	const hits = [];
	for (const line of (run.stdout || '').split('\n')) {
		if (!line.trim()) continue;
		const hit = parseTagLine(line);
		if (hit) hits.push(hit);
		if (hits.length >= limit) break;
	}
	return { ok: true, hits: rankHits(hits) };
}

// #endregion

// #region Build

function human(bytes) {
	return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`;
}

/** Builds one corpus. The tags file is written to a temp name and RENAMED into place, and the stamp is
 *  removed before the rename and written after it — so an interrupted build can only ever leave the
 *  «no stamp» state, which `stampVerdict` already refuses. A half-written index that looks complete is
 *  the one outcome this must never produce. */
function build(corpus, unrealHome, env) {
	const roots = corpusRoots(corpus, unrealHome, env);
	if (roots.length === 0) {
		console.log(`engine-index: ${corpus} — no corpus on this machine, skipped.`);
		console.log('  (the samples root is wherever UE_SAMPLES_ROOT points; unset means no samples corpus)');
		return true;
	}
	const missing = roots.filter((r) => !existsSync(r));
	if (missing.length > 0) {
		console.error(`engine-index: ${corpus} — root does not exist: ${missing.join(', ')}`);
		return false;
	}

	const home = indexHome(unrealHome);
	mkdirSync(home, { recursive: true });
	const finalPath = tagsPathFor(corpus, unrealHome);
	const tempPath = `${finalPath}.building`;
	const stampPath = stampPathFor(corpus, unrealHome);

	console.log(`engine-index: building ${corpus} from ${roots.length} root(s) — this takes from under a minute to ~5 minutes, by disk.`);
	for (const r of roots) console.log(`  ${r}`);

	const started = Date.now();
	const run = spawnSync('ctags', ['-R', ...CtagsRecipe, '-f', tempPath, ...roots], {
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024,
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	if (run.error) {
		console.error(`engine-index: ctags could not run (${run.error.code || run.error.message}).`);
		console.error('  Install it: winget install UniversalCtags.Ctags');
		return false;
	}
	if (run.status !== 0) {
		console.error(`engine-index: ctags exited ${run.status}.`);
		console.error((run.stderr || '').trim().split('\n').slice(0, 10).join('\n'));
		return false;
	}
	// ctags warns per unparsable construct; on a corpus this size that is thousands of lines about code
	// nobody asked us to index. The COUNT is the useful signal, the lines are not.
	const warnings = (run.stderr || '').split('\n').filter((l) => l.trim()).length;

	const seconds = ((Date.now() - started) / 1000).toFixed(1);
	const size = statSync(tempPath).size;
	// The pseudo-tag header lines (`!_TAG_...`) are not tags; counting them would inflate every report.
	let tags = 0;
	for (const line of readFileSync(tempPath, 'utf8').split('\n')) {
		if (line && !line.startsWith('!_TAG_')) tags++;
	}

	rmSync(stampPath, { force: true });
	rmSync(finalPath, { force: true });
	renameSync(tempPath, finalPath);
	writeFileSync(
		stampPath,
		`${JSON.stringify(
			{
				corpus,
				// null for anything but the engine, and deliberately so: the samples corpus is not versioned
				// by the engine, and a field carrying a number nothing compares against reads as a guarantee
				// that does not exist.
				engineVersion: corpus === 'engine' ? engineVersionOf(unrealHome) : null,
				roots,
				builtAt: new Date().toISOString(),
				tool: (spawnSync('ctags', ['--version'], { encoding: 'utf8' }).stdout || '').split('\n')[0]?.trim() || 'ctags',
				tags,
				seconds: Number(seconds),
			},
			null,
			2,
		)}\n`,
		'utf8',
	);

	console.log(`  done in ${seconds} s — ${human(size)}, ${tags.toLocaleString('en-US')} tags${warnings ? `, ${warnings} parser warning(s) ignored` : ''}`);
	console.log(`  ${finalPath}`);
	return true;
}

function status(unrealHome, env) {
	console.log(`engine-index: ${indexHome(unrealHome)}\n`);
	for (const corpus of Corpora) {
		const state = indexState(corpus, unrealHome, env);
		if (state.ok) {
			const s = state.stamp;
			console.log(`  ${corpus.padEnd(10)} OK      built ${s.builtAt} · ${Number(s.tags || 0).toLocaleString('en-US')} tags${s.engineVersion ? ` · engine ${s.engineVersion}` : ''}`);
		} else {
			console.log(`  ${corpus.padEnd(10)} UNUSED  ${state.reason}`);
			console.log(`             the selector falls back to ripgrep; rebuild with ${state.rebuild}`);
		}
	}
	const roots = corpusRoots('templates', unrealHome, env);
	if (roots.length === 0) console.log('\n  (no samples corpus on this machine — set UE_SAMPLES_ROOT to index one)');
}

// #endregion

// #region Selftest

/** The rules that can be wrong without anyone noticing: the tag parser (a mis-parse reads as «no such
 *  symbol»), the staleness verdict (a wrong `ok` is a confident wrong answer) and the module filter
 *  (a substring match answers with a neighbour's module). Pure — no index, no corpus, no engine. */
function selftest() {
	let failed = 0;
	const check = (what, got, want) => {
		const ok = JSON.stringify(got) === JSON.stringify(want);
		if (!ok) {
			failed++;
			console.error(`FAIL ${what}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`);
		}
	};

	// A real line, with the leading TAB that UE headers put in front of every member — the shape that
	// breaks a positional split.
	const memberLine =
		'FChaosVehicleManager\tE:/UE_5.8/Engine/Plugins/Experimental/ChaosVehiclesPlugin/Source/ChaosVehicles/Public/ChaosVehicleManager.h\t/^\tFChaosVehicleManager(FPhysScene* PhysScene);$/;"\tkind:p\tline:24\tclass:FChaosVehicleManager';
	check('parse: member prototype', parseTagLine(memberLine), {
		name: 'FChaosVehicleManager',
		path: 'E:/UE_5.8/Engine/Plugins/Experimental/ChaosVehiclesPlugin/Source/ChaosVehicles/Public/ChaosVehicleManager.h',
		line: 24,
		kind: 'p',
		scope: 'FChaosVehicleManager',
	});
	const classLine =
		'FChaosVehicleManager\tE:/x/ChaosVehicleManager.h\t/^class CHAOSVEHICLES_API FChaosVehicleManager$/;"\tkind:c\tline:17';
	check('parse: class declaration', parseTagLine(classLine)?.line, 17);
	check('parse: class has no scope', parseTagLine(classLine)?.scope, null);
	check('parse: pseudo-tag is not a hit', parseTagLine('!_TAG_FILE_SORTED\t1\t/0=unsorted/'), null);
	check('parse: a line without line: is not a hit', parseTagLine('X\tf.h\t/^class X$/;"\tkind:c'), null);

	// A declaration must outrank a prototype of the same name — that ordering is the whole reason the
	// selector prints the first hit first.
	const ranked = rankHits([
		{ name: 'X', path: 'a.h', line: 2, kind: 'p', scope: 'X' },
		{ name: 'X', path: 'a.h', line: 1, kind: 'c', scope: null },
	]);
	check('rank: declaration before prototype', ranked.map((h) => h.kind), ['c', 'p']);

	check('module: exact segment matches', inModule('E:/UE/Engine/Source/Runtime/Water/Public/W.h', 'Water'), true);
	check('module: a longer neighbour does not', inModule('E:/UE/Engine/Source/Runtime/WaterEditor/Public/W.h', 'Water'), false);
	check('module: no filter accepts everything', inModule('E:/anything.h', null), true);
	check('module: backslashes are the same path', inModule('E:\\UE\\Engine\\Source\\Runtime\\Water\\W.h', 'Water'), true);

	// `Owner::Member` without qualified extras — the whole reason the index stayed at half its size.
	const member = { name: 'SetThrottleInput', path: 'a.h', line: 9, kind: 'p', scope: 'UChaosWheeledVehicleMovementComponent' };
	check('scope: the owning type matches', inScope(member, 'UChaosWheeledVehicleMovementComponent'), true);
	check('scope: another type does not', inScope(member, 'UChaosVehicleMovementComponent'), false);
	check('scope: a free function has no owner', inScope({ scope: null }, 'UFoo'), false);
	check('scope: a nested owner is matched by its own name', inScope({ scope: 'FOuter::FInner' }, 'FInner'), true);
	check('scope: no owner asked accepts everything', inScope({ scope: null }, null), true);

	check('stamp: no index is not usable', stampVerdict({ corpus: 'engine', tagsExists: false, stamp: null, liveVersion: '5.8.1+1' }).ok, false);
	check(
		'stamp: an unstamped index is not usable',
		stampVerdict({ corpus: 'engine', tagsExists: true, stamp: null, liveVersion: '5.8.1+1' }).ok,
		false,
	);
	check(
		'stamp: a version mismatch is not usable',
		stampVerdict({ corpus: 'engine', tagsExists: true, stamp: { engineVersion: '5.8.0+1' }, liveVersion: '5.8.1+2' }).ok,
		false,
	);
	check(
		'stamp: a matching version is usable',
		stampVerdict({ corpus: 'engine', tagsExists: true, stamp: { engineVersion: '5.8.1+2' }, liveVersion: '5.8.1+2' }).ok,
		true,
	);
	check(
		'stamp: an unreadable engine version refuses the index',
		stampVerdict({ corpus: 'engine', tagsExists: true, stamp: { engineVersion: '5.8.1+2' }, liveVersion: null }).ok,
		false,
	);
	// The documented fail-open: templates carry no engine version and are not judged by one.
	check(
		'stamp: templates need no version',
		stampVerdict({ corpus: 'templates', tagsExists: true, stamp: { engineVersion: null }, liveVersion: null }).ok,
		true,
	);

	if (failed > 0) {
		console.error(`\nengine-index --selftest: ${failed} failure(s).`);
		process.exit(1);
	}
	console.log('engine-index --selftest: ok');
}

// #endregion

// #region CLI

// Imported by engine-api.mjs for the lookup half, so the builder only runs when this file IS the entry
// point — `process.argv[1]` is the script Node was told to run.
const isEntry = (process.argv[1] || '').replaceAll('\\', '/').endsWith('engine-index.mjs');
if (isEntry) {
	const argv = process.argv.slice(2);
	if (argv.includes('--help') || argv.includes('-h')) {
		console.log(`engine-index — build the ctags index the engine selector reads.

  ${RebuildCommand}                 build both corpora (engine + Epic samples)
  ${RebuildCommand} --engine        engine only
  ${RebuildCommand} --templates     samples only
  ${RebuildCommand} --status        where the indexes are, and whether they may be trusted
  ${RebuildCommand} --selftest      the pure rules only

The index is bought for COVERAGE: without it the selector sees Engine/Source and is blind to the 71% of
engine modules that live in Engine/Plugins. Rebuild it after an engine update — until you do, the version
stamp makes the selector refuse the index and answer through ripgrep instead.`);
		process.exit(0);
	}
	if (argv.includes('--selftest')) {
		selftest();
		process.exit(0);
	}

	const engine = resolveEngine();
	if (engine.error) {
		console.error(engine.error);
		process.exit(1);
	}
	if (argv.includes('--status')) {
		status(engine.unrealHome, process.env);
		process.exit(0);
	}

	const wanted = Corpora.filter((c) => argv.includes(`--${c}`));
	const targets = wanted.length > 0 ? wanted : Corpora;
	let ok = true;
	for (const corpus of targets) {
		ok = build(corpus, engine.unrealHome, process.env) && ok;
	}
	if (ok) {
		console.log('\nengine-index: done. The selector uses it on its next run.');
	}
	process.exit(ok ? 0 : 1);
}

// #endregion
