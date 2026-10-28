// hazards.mjs — the symptom selector over the known-hazards docs: the skill's engine-wide
// references/ue-hazards.md plus the project's own .claude/docs/known-hazards.md (or KNOWN_HAZARDS=<path>).
//
// WHY THIS EXISTS. Debugging step 0 says "check the known traps" — and a hazards doc grows to ~60 KB / dozens of
// sections, paid on EVERY debug, to match at most one of them. The doc is not the problem (every entry earned
// its place by costing a repeat); reading it whole to find one entry is. So: this prints the INDEX by default
// and only the MATCHING section(s) on a query. Same knowledge, ~2 KB instead of ~60 KB, and the full section
// still arrives verbatim when it is actually the one you need.
//
// No index is maintained by hand — headings ARE the index, so a new hazard is discoverable the moment it is
// written, with no second edit to forget. That is the same single-source rule the tracker's registry follows.
//
// Usage:
//   node hazards.mjs                 -> the index (one line per section, numbered)
//   node hazards.mjs <query...>      -> every section matching the query, in full
//   node hazards.mjs --section <n>   -> section #n from the index, in full
//
// Matching is case-insensitive substring over the heading first; if no heading matches, the body is searched
// too (so "clangd", "EINVAL" or "Session 0" find their section even when the heading words them differently).
// Multiple terms = AND. Exit 0 always when the doc is readable — "no match" is an answer, not a failure.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL = dirname(dirname(dirname(fileURLToPath(import.meta.url)))); // <skill>/scripts/mjs -> <skill>
const SKILL_DOC = join(SKILL, 'references', 'ue-hazards.md');
const PROJECT_DOC = process.env.KNOWN_HAZARDS
    || join(process.env.CLAUDE_PROJECT_DIR || process.cwd(), '.claude', 'docs', 'known-hazards.md');
const DOCS = [...new Set([PROJECT_DOC, SKILL_DOC])].filter((d) => existsSync(d));

if (DOCS.length === 0) {
    console.error(`hazards: neither ${PROJECT_DOC} nor ${SKILL_DOC} exists`);
    process.exit(1);
}

// Split on top-level `## ` headings; each section remembers its doc so a hit says where to edit it.
// The project doc comes first, so a title present in both keeps the project's version; titles repeated
// inside one doc are that doc's business and all stay. A BOM is stripped: Node keeps it, and `^## ` would
// then miss the first heading and drop its section with the preamble.
const perDoc = DOCS.map((doc) => {
    const parts = readFileSync(doc, 'utf8').replace(/^﻿/, '').split(/^## /m);
    parts.shift();
    return parts.map((raw) => {
        const nl = raw.indexOf('\n');
        return { doc, title: (nl === -1 ? raw : raw.slice(0, nl)).trim(), body: `## ${raw}`.trimEnd() };
    });
});
// A section may also name the title it carries in another doc: `<!-- aka: <title> -->` on any line. The skill
// doc uses it to keep a neutral title while still yielding to a project doc that kept the old wording.
const keysOf = (s) => [s.title, ...[...s.body.matchAll(/<!--\s*aka:\s*(.+?)\s*-->/g)].map((m) => m[1])]
    .map((t) => t.toLowerCase());
const claimed = new Set();
const sections = perDoc.flatMap((list) => {
    const kept = list.filter((s) => !keysOf(s).some((k) => claimed.has(k)));
    list.forEach((s) => keysOf(s).forEach((k) => claimed.add(k)));
    return kept;
});
const docsLabel = DOCS.join(' + ');
const projectHint = existsSync(PROJECT_DOC)
    ? PROJECT_DOC
    : `${PROJECT_DOC} (create it), or ${SKILL_DOC} when the trap is engine-wide`;

const rawArgv = process.argv.slice(2);
const brief = rawArgv.includes('--brief');
const wantIndex = rawArgv.includes('--index');
const argv = rawArgv.filter((a) => a !== '--brief' && a !== '--index');

/** The nearest titles to a query that matched nothing — scored by how many of its words appear in the
 *  title, best first. Not a spell-checker: it answers «did you mean one of these» cheaply, and says
 *  nothing when the query shares no word with any title. */
function nearest(words, limit = 8) {
    return sections
        .map((s) => ({ s, score: words.filter((w) => s.title.toLowerCase().includes(w)).length }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((x) => x.s);
}

function printIndex() {
    console.log(`Known hazards (${docsLabel}) — ${sections.length} entries. Full text: hazards.cmd <symptom words>\n`);
    sections.forEach((s, i) => console.log(`${String(i + 1).padStart(2)}. ${s.title}`));
    console.log('\nNo match for your symptom? It is not a documented trap — debug it, and if it is repeatable,');
    console.log(`add it to ${projectHint} so the next session pays nothing for it.`);
}

if (argv.length === 0 || wantIndex) {
    printIndex();
    process.exit(0);
}

if (argv[0] === '--section') {
    const n = Number(argv[1]);
    if (!Number.isInteger(n) || n < 1 || n > sections.length) {
        console.error(`hazards: --section takes 1..${sections.length}`);
        process.exit(1);
    }
    console.log(sections[n - 1].body);
    process.exit(0);
}

const terms = argv.map((a) => a.toLowerCase());
const hits = (pick) => sections.filter((s) => terms.every((t) => pick(s).toLowerCase().includes(t)));

// Heading match first — it is the precise one. Only widen to the body when the heading finds nothing, so a
// common word ("editor") does not drag in every section that merely mentions it.
let found = hits((s) => s.title);
let how = 'heading';
if (found.length === 0) {
    found = hits((s) => s.body);
    how = 'body';
}

if (found.length === 0) {
    console.log(`hazards: no section matches ${argv.map((a) => `"${a}"`).join(' + ')}.`);
    console.log('This is not a documented trap. Debug it — and if it turns out repeatable, write it into');
    console.log(`${projectHint} in the same pass, so the next session pays nothing for it.`);
    // A MISS USED TO COST MORE THAN A HIT. This branch printed the WHOLE index — 140 titles, ~15 KB —
    // on every query that found nothing, which is the query an agent makes most often when it is exploring.
    // The index is still one flag away; what a miss owes the reader is «nothing here, and here is the nearest
    // thing», not the whole book.
    const near = nearest(terms);
    if (near.length) {
        console.log('\nNearest titles (by shared words):');
        near.forEach((s) => console.log(`  - ${s.title}`));
    }
    console.log(`\n${sections.length} entries in total — full index: hazards.cmd --index`);
    process.exit(0);
}

console.log(`hazards: ${found.length} section(s) matched on ${how} — ${argv.join(' ')}\n`);
if (brief) {
    // `--brief` answers «is there anything here at all» without paying for the answer twice: the title, plus
    // the Symptom line that decides whether this is your bug. The body is one flag away.
    found.forEach((s) => {
        console.log(`## ${s.title}`);
        const symptom = s.body.split('\n').find((l) => /^\*\*Symptom/i.test(l.trim()));
        if (symptom) console.log(`   ${symptom.replace(/^\*\*Symptom\.?\*\*\s*/i, '').trim().slice(0, 200)}`);
        console.log('');
    });
    console.log('(--brief: titles + symptom only. Drop the flag for the full sections.)');
    process.exit(0);
}
found.forEach((s, i) => {
    if (i > 0) console.log('\n---\n');
    console.log(`(from ${s.doc})`);
    console.log(s.body);
});
