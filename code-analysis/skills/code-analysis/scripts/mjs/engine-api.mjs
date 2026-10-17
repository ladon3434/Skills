// engine-api.mjs — the symbol selector over the UE engine source.
//
// WHY THIS EXISTS. "Ground an unfamiliar engine API before you write against it" —
// and that grounding went to a subagent every time — two minutes and tens of thousands of tokens for
// three lines of signature. Measured: ripgrep over the WHOLE engine header set is 1.2 s.
// The disk was never the cost. The cost was the round-trip, plus the agent flailing when its first
// guessed pattern matched nothing.
//
// So this encodes the query recipes once — class/struct/enum declaration, member and free function
// declaration, Class::Method — scopes them to a module when one is named, and caps the output. Bounded
// output is what makes it safe to run INLINE: the ban on pulling the
// engine into the main context is about megabytes, and this prints at most a few dozen lines. Reading a
// file BODY is still a subagent's job.
//
// A hit that cost real effort belongs in the cache — the skill's references/engine-api/*.md (engine facts,
// shared by every project) or the project's .claude/engine-api/*.md. This script reads both BEFORE the
// engine, so the second session pays nothing at all.
//
// THREE LAYERS, CHEAPEST FIRST: the curated cache, then the ctags index behind
// engine-index.mjs, then ripgrep over the source. The index was added for COVERAGE, not speed — the
// ripgrep layer used to search Engine/Source alone, so the 1813 modules under Engine/Plugins (71% of the
// engine: ChaosVehicles, RigVM, Water, Niagara, MassEntity, GAS) answered «no declaration» for symbols
// that exist. Both were fixed at once: the fallback now searches BOTH roots, so a machine with no index
// degrades to a slower answer rather than to a wrong one.
//
// Usage:
//   node engine-api.mjs UWidgetTree                      -> the type declaration
//   node engine-api.mjs UWidgetTree::ConstructWidget     -> that member, found via its owning type
//   node engine-api.mjs ConstructWidget --module UMG     -> scoped to one module (much narrower)
//   node engine-api.mjs FSlateChildSize --cpp            -> search .cpp too (default: headers only)
//   node engine-api.mjs UWidget --lines 40               -> raise the output cap (default 20, max 80)
//   node engine-api.mjs --cache-only UWidgetTree         -> never touch the engine, cache only
//   node engine-api.mjs UWidget --no-index               -> skip the ctags index, ripgrep the source
//
// Exit 0 whenever the search ran — "no match" is an answer, not a failure. Exit 1 only when the engine
// cannot be located or the arguments are unusable.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveEngine } from './ue-engine.mjs';
import { Corpora, corpusRoots, indexState, inModule, inScope, KindLabel, queryIndex } from './engine-index.mjs';

const SKILL = dirname(dirname(dirname(fileURLToPath(import.meta.url)))); // <skill>/scripts/mjs -> <skill>
const SKILL_CACHE = join(SKILL, 'references', 'engine-api');
const CACHE_DIRS = [SKILL_CACHE, join(process.env.CLAUDE_PROJECT_DIR || process.cwd(), '.claude', 'engine-api')];

const DEFAULT_LINES = 20;
const MAX_LINES = 80;

// #region Arguments

const argv = process.argv.slice(2);
const flags = { module: null, cpp: false, lines: DEFAULT_LINES, cacheOnly: false, noIndex: false };
const words = [];

for (let i = 0; i < argv.length; i++) {
	const a = argv[i];
	if (a === '--module' || a === '-m') flags.module = argv[++i];
	else if (a === '--cpp') flags.cpp = true;
	else if (a === '--cache-only') flags.cacheOnly = true;
	else if (a === '--no-index') flags.noIndex = true;
	else if (a === '--lines') flags.lines = Math.min(MAX_LINES, Math.max(4, Number(argv[++i]) || DEFAULT_LINES));
	else if (a === '--help' || a === '-h') words.push('--help');
	else words.push(a);
}

if (words.length === 0 || words[0] === '--help') {
	console.log(`engine-api — ground an engine symbol without a subagent.

  engine-api.cmd <Symbol>[::Member] [--module <Name>] [--cpp] [--lines N] [--cache-only]

  <Symbol>          UWidgetTree · FSlateChildSize · EHorizontalAlignment · ConstructWidget
  <Symbol>::Member  resolves the owning type first, then searches only its header(s)
  --module <Name>   scope to one engine module (UMG, UMGEditor, Kismet, Engine, Slate, ...);
                    resolved by walking the tree, so a module this file never heard of still works
  --cpp             search .cpp as well (default: headers only — declarations live there)
  --lines N         output cap, default ${DEFAULT_LINES}, max ${MAX_LINES}
  --cache-only      answer from the cache (skill references/engine-api/ + project .claude/engine-api/) and stop
  --no-index        ignore the ctags index and ripgrep the source directly

Lookup order: the curated cache, then the ctags index (engine-index.cmd builds it — that is
what makes Engine/Plugins visible at all), then ripgrep over Engine/Source + Engine/Plugins.

Grounded a signature the hard way? Write it into that cache directory in the same pass — the next
session then pays nothing for it. Reading a file BODY is still a subagent's job (engine-reader).`);
	process.exit(0);
}

const query = words[0];
const [ownerType, member] = query.includes('::') ? query.split('::') : [null, null];
const symbol = member || query;

// #endregion

// #region Cache

/** Sections of the cache are `## <heading>` blocks, exactly like known-hazards.md. */
function searchCache(term) {
	const hits = [];
	for (const dir of CACHE_DIRS.filter((d) => existsSync(d))) for (const file of readdirSync(dir).filter((f) => f.endsWith('.md'))) {
		const text = readFileSync(join(dir, file), 'utf8').replace(/^﻿/, ''); // a BOM would hide the first `## `
		const parts = text.split(/^## /m);
		parts.shift();
		for (const raw of parts) {
			const nl = raw.indexOf('\n');
			const title = (nl === -1 ? raw : raw.slice(0, nl)).trim();
			if (title.toLowerCase().includes(term.toLowerCase())) {
				hits.push({ file: join(dir, file), body: `## ${raw}`.trimEnd() });
			}
		}
	}
	return hits;
}

const cached = searchCache(query.includes('::') ? member : query);
if (cached.length > 0) {
	console.log(`engine-api: ${cached.length} cached entry(ies) for "${query}" — already grounded, no engine search.\n`);
	cached.forEach((h, i) => {
		if (i > 0) console.log('\n---\n');
		console.log(`(from ${h.file})`);
		console.log(h.body);
	});
	console.log('\nIf this entry looks stale against the current engine, re-run with --cache-only omitted');
	console.log('after deleting the section — a cache nobody corrects is worse than none.');
	process.exit(0);
}

if (flags.cacheOnly) {
	console.log(`engine-api: nothing cached for "${query}". Drop --cache-only to search the engine.`);
	process.exit(0);
}

// #endregion

// #region Engine + module resolution

const engine = resolveEngine();
if (engine.error) {
	console.error(engine.error);
	process.exit(1);
}
const SOURCE_ROOT = join(engine.unrealHome, 'Engine');

/**
 * Module name -> its source directory. The obvious three homes are checked first; anything else is found
 * by walking Engine/Plugins. Deliberately NOT a hardcoded table: a table would silently rot the first
 * time Epic moves a module, and the walk costs milliseconds.
 * @returns {string|null} absolute path, or null when the name resolves to nothing
 */
function resolveModule(name) {
	for (const bucket of ['Runtime', 'Editor', 'Developer', 'ThirdParty']) {
		const candidate = join(SOURCE_ROOT, 'Source', bucket, name);
		if (existsSync(candidate)) return candidate;
	}
	// Plugins nest as Plugins/<Category>/<Plugin>/Source/<Module> — walk a bounded depth.
	const pluginsRoot = join(SOURCE_ROOT, 'Plugins');
	const stack = [{ dir: pluginsRoot, depth: 0 }];
	while (stack.length > 0) {
		const { dir, depth } = stack.pop();
		if (depth > 4) continue;
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const e of entries) {
			if (!e.isDirectory()) continue;
			if (e.name === name && existsSync(join(dir, e.name, 'Public'))) return join(dir, e.name);
			if (e.name === name && existsSync(join(dir, e.name, 'Source'))) return join(dir, e.name);
			stack.push({ dir: join(dir, e.name), depth: depth + 1 });
		}
	}
	return null;
}

// BOTH ROOTS, NOT JUST Engine/Source. This one line is the bug the index was researched over: the engine
// has 755 modules under Source and 1813 under Plugins, so searching Source alone reported «no
// declaration» for 71% of the corpus — a false absence, which costs a subagent or a wrong decision, not
// just time. The index makes the same coverage fast; this makes the FALLBACK honest, so a machine that
// never built one still answers correctly.
let searchRoots = [join(SOURCE_ROOT, 'Source'), join(SOURCE_ROOT, 'Plugins')];
let scopeLabel = 'Engine/Source + Engine/Plugins';
if (flags.module) {
	const resolved = resolveModule(flags.module);
	if (resolved) {
		searchRoots = [resolved];
		scopeLabel = relative(SOURCE_ROOT, resolved).replaceAll('\\', '/');
	} else {
		console.log(`engine-api: module "${flags.module}" not found under Engine/Source or Engine/Plugins — falling back to the whole tree.\n`);
	}
}

// #endregion

// #region Index layer

/** Where a hit's path is shown FROM. The engine index and the samples index have different roots, and a
 *  templates hit rendered against the engine root comes out as `../../<samples root>/…`. */
const CORPUS_ROOTS = new Map(Corpora.map((c) => [c, corpusRoots(c, engine.unrealHome)]));

function displayPath(path, corpus) {
	// Engine hits are shown from `Engine/`, so `Source/Runtime/…` and `Plugins/Experimental/…` read as the
	// two halves of one tree — which is exactly the thing this task made visible.
	const bases = corpus && corpus !== 'engine' ? CORPUS_ROOTS.get(corpus) || [] : [SOURCE_ROOT];
	for (const root of bases) {
		const rel = relative(root, path).replaceAll('\\', '/');
		if (!rel.startsWith('..')) return rel;
	}
	return path.replaceAll('\\', '/');
}

// Two answers the index can give, and they are NOT the same thing:
//   · hits            -> answer from the index, skip ripgrep entirely;
//   · nothing at all  -> say nothing and fall through, because a narrow kind set means the index does not
//                        know everything ripgrep can find. An empty index is never reported as «no such
//                        symbol» — that is the failure mode this whole task exists to remove.
// A REFUSED index (missing, unstamped, built against another engine version) prints WHY, because a
// silent degradation to a 2 s search is how nobody ever rebuilds it.
// `--cpp` SKIPS THE INDEX, and that is not a shortcut. The index holds headers only, so an indexed answer
// to a `--cpp` query would silently be the header answer the caller ALREADY decided was not enough — the
// flag exists precisely for the symbol that is defined but never declared in a header.
let indexHits = null;
let indexCorpus = null;
let indexStamp = null;
let indexNote = null;

if (!flags.noIndex && !flags.cpp) {
	for (const corpus of Corpora) {
		const state = indexState(corpus, engine.unrealHome);
		if (!state.ok) {
			// Only the engine index is worth a line here: the samples corpus is optional on a machine, and
			// its absence is not news.
			if (corpus === 'engine') indexNote = `${state.reason} — searching with ripgrep instead (rebuild: ${state.rebuild})`;
			continue;
		}
		const answer = queryIndex(state.tagsPath, symbol);
		if (!answer.ok) {
			indexNote = `the ${corpus} index could not be read (${answer.reason}) — searching with ripgrep instead`;
			continue;
		}
		const hits = answer.hits.filter((h) => inScope(h, ownerType)).filter((h) => inModule(h.path, flags.module));
		if (hits.length === 0) continue;
		indexHits = hits;
		indexCorpus = corpus;
		indexStamp = state.stamp;
		break;
	}
}

if (indexNote) console.log(`engine-api: ${indexNote}\n`);

if (indexHits) {
	const kinds = [...new Set(indexHits.map((h) => KindLabel[h.kind] || `kind ${h.kind}`))];
	// The samples index carries a build DATE and no version gate (see stampVerdict), so an answer from it
	// says how old it is — that date is the only thing a reader can judge its freshness by.
	const where = indexCorpus === 'engine' ? scopeLabel : `Epic samples (index built ${indexStamp.builtAt.slice(0, 10)})`;
	report(
		indexHits.map((h) => ({ ...h, text: h.name })),
		`${kinds.join(' / ')} — ctags index`,
		where,
		indexCorpus,
	);
	process.exit(0);
}

// #endregion

// #region Search

const GLOBS = flags.cpp ? ['-g', '*.h', '-g', '*.cpp'] : ['-g', '*.h'];

/** One ripgrep pass over one or more roots. Returns [{path, line, text}] — never throws on "no match"
 *  (rg exit 1). The roots are a LIST because the default scope is two of them, Engine/Source and
 *  Engine/Plugins; a single file path is still accepted, which is what the Class::Member recipe hands it. */
function rg(pattern, roots = searchRoots, extra = []) {
	const targets = Array.isArray(roots) ? roots : [roots];
	let out;
	try {
		// -H is not optional: given exactly ONE file path, rg omits the filename and prints `line:text`.
		// The Class::Member recipe searches one file at a time, so without -H every one of its hits
		// fails to parse and the tool reports "not found" on a symbol that is right there.
		out = execFileSync('rg', ['-n', '-H', '--no-heading', '--color', 'never', ...GLOBS, ...extra, pattern, ...targets], {
			encoding: 'utf8',
			maxBuffer: 32 * 1024 * 1024,
			stdio: ['ignore', 'pipe', 'ignore'],
		});
	} catch (e) {
		if (e.status === 1) return []; // rg: no match
		throw e;
	}
	return out
		.split('\n')
		.filter(Boolean)
		.map((l) => {
			// Windows paths carry a drive colon, so split off the LAST two colon-separated fields.
			const m = l.match(/^(.*?):(\d+):(.*)$/s);
			return m ? { path: m[1], line: Number(m[2]), text: m[3] } : null;
		})
		.filter(Boolean);
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const S = esc(symbol);

// The recipes, in precedence order. A declaration beats a mention; that ordering is the whole point of
// having recipes instead of a bare grep.
// `class UWidgetTree;` is a forward declaration, not the answer — and there are always more of those
// than of the real thing. Requiring what FOLLOWS the name (a base list, a brace, or end-of-line) is what
// separates the definition from the noise. Rust regex has no lookahead, hence the positive form.
const RECIPES = [
	{ what: 'type declaration', pattern: `^\\s*(class|struct)\\s+([A-Z][A-Z0-9_]*_API\\s+)?${S}\\s*(final)?\\s*(:|\\{|$)` },
	{ what: 'enum declaration', pattern: `^\\s*enum\\s+(class\\s+)?${S}\\b` },
	// UE wraps many old enums as `namespace EFoo { enum Type { ... } }` so they stay TEnumAsByte-able.
	// Without this recipe such a symbol only ever matches as a "mention".
	{ what: 'namespaced enum', pattern: `^\\s*namespace\\s+${S}\\b` },
	{ what: 'typedef/using', pattern: `^\\s*(typedef\\s+.*\\b${S}\\b\\s*;|using\\s+${S}\\s*=)` },
	{ what: 'function declaration', pattern: `^\\s*[\\w:<>,\\*&\\s\\[\\]]+\\b${S}\\s*\\(` },
	// Last resort: the symbol exists but only as a forward declaration or a mention in this scope.
	{ what: 'mention only (no definition in scope)', pattern: `\\b${S}\\b` },
];

let results = [];
let matchedRecipe = null;

// `Class::Member` — find the owning header first, then look only inside it. This is what turns a noisy
// project-wide grep for a common member name ("Apply", "GetName") into two exact lines.
if (ownerType) {
	const O = esc(ownerType);
	// Look for where the type is DEFINED, not merely forward-declared. Searching every header that
	// happens to name it drags in unrelated members: `UPackage::GetMetaData` came back with hits from
	// Field.h purely because that header forward-declares UPackage. Fall back to the loose form only
	// when the strict one finds nothing (the type may live behind a macro or a typedef).
	let ownerHits = rg(`^\\s*(class|struct)\\s+([A-Z][A-Z0-9_]*_API\\s+)?${O}\\s*(final)?\\s*(:|\\{|$)`);
	if (ownerHits.length === 0) {
		ownerHits = rg(`^\\s*(class|struct)\\s+([A-Z][A-Z0-9_]*_API\\s+)?${O}\\b`);
	}
	if (ownerHits.length === 0) {
		console.log(`engine-api: owning type "${ownerType}" not found in ${scopeLabel}.`);
		console.log(`Try without the module scope, or search the member alone: engine-api.cmd ${symbol}`);
		process.exit(0);
	}
	const files = [...new Set(ownerHits.map((h) => h.path))];
	for (const file of files) {
		results.push(...rg(`\\b${S}\\s*\\(`, file));
	}
	matchedRecipe = `member of ${ownerType} (${files.length} declaring header(s))`;
} else {
	for (const recipe of RECIPES) {
		results = rg(recipe.pattern);
		if (results.length > 0) {
			matchedRecipe = recipe.what;
			break;
		}
	}
}

// #endregion

// #region Report

/** ONE report for both layers. The index and ripgrep disagree about how they FOUND a hit and about
 *  nothing else — both end at a file and a line — so the printing, the output cap and the advice live
 *  here once. A second copy for the index layer would be the first thing to drift. */
function report(hits, foundBy, where, corpus = null) {
	console.log(`engine-api: "${query}" — ${hits.length} hit(s) by ${foundBy} in ${where}\n`);

	let printed = 0;
	let suppressed = 0;
	for (const hit of hits) {
		if (printed >= flags.lines) {
			suppressed++;
			continue;
		}
		console.log(`${displayPath(hit.path, corpus)}:${hit.line}`);
		printed++;

		// Print the declaration, plus its continuation lines when the signature wraps. A UE signature very
		// often spans three lines; stopping at the first is how a grounding pass gets the parameters wrong.
		let text;
		try {
			text = readFileSync(hit.path, 'utf8').split(/\r?\n/);
		} catch {
			console.log(`    ${(hit.text || hit.name || '').trim()}`);
			continue;
		}
		// Walk BACK over the qualifiers that sit on their own lines above a UE declaration. `UE_DEPRECATED` is
		// the load-bearing one: a grounding of UScaleBoxSlot::SetPadding got a clean-looking signature, and
		// only the compiler's deprecation warning revealed it ("There is no padding on ScaleBox") — the macro was one
		// line above the match. A signature shown without its deprecation is worse than no answer.
		const PRECEDING = /^\s*(UE_DEPRECATED|UE_INTERNAL|UE_EXPERIMENTAL|template\s*<|UFUNCTION|UPROPERTY)/;
		const lead = [];
		for (let i = hit.line - 2; i >= 0 && lead.length < 3 && PRECEDING.test(text[i]); i--) {
			lead.unshift(text[i]);
		}
		for (const line of lead) {
			if (printed >= flags.lines) break;
			console.log(`    ${line.trimEnd()}`);
			printed++;
		}

		for (let i = hit.line - 1; i < text.length && printed < flags.lines; i++) {
			const line = text[i];
			console.log(`    ${line.trimEnd()}`);
			printed++;
			if (/[;{]\s*$/.test(line) || line.trim() === '') break;
		}
		console.log('');
		printed++;
	}

	if (suppressed > 0) {
		console.log(`(${suppressed} more hit(s) not shown — narrow with --module <Name>, or raise --lines N.)`);
	}
	console.log(`Worth keeping? Add it to ${join(SKILL_CACHE, '<domain>.md')}`);
	console.log('as a `## <Symbol>` section with the signature, the file:line and the date.');
}

if (results.length === 0) {
	console.log(`engine-api: no declaration of "${query}" in ${scopeLabel}${flags.cpp ? '' : ' (headers only)'}.`);
	console.log('\nNext steps, cheapest first:');
	console.log('  · drop --module, or add --cpp if it is defined but not declared in a header');
	console.log('  · the symbol may be a macro or generated by UHT — those live in *.generated.h / a *.h macro block');
	console.log('  · still nothing: THIS is when a subagent earns its cost (it can read bodies and follow includes)');
	process.exit(0);
}

report(results, matchedRecipe, scopeLabel, 'engine');

// #endregion
