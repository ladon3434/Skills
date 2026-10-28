---
name: md-doc-hygiene
description: Structure and link rules for markdown / Obsidian documentation — headings without numbers, links by heading text instead of "§2.5", ^t-/^r- block IDs for terms and rules, list numbering, escaped pipes and no nested tables, an Obsidian table of contents kept in step with the headings, one definition per term — plus checkers that verify them. Use when editing a documentation tree or an Obsidian vault (not a SKILL.md, README or changelog), especially when renaming headings, adding or removing list items, or placing cross-references — «поправь доку», «проверь ссылки в документации», «переименуй заголовок», «check the docs links», «fix markdown structure». Owns only the FORM of documents; what a document says and in what order is the sibling skill docs-for-readers.
---

# md-doc-hygiene — the form of markdown documentation

Documents are tied together by **real links**, not by text, and survive renumbering. Every docs edit ends with a
green checker run. Script paths are from the skill folder (`<skill>`); `<docs>` is the docs root (an Obsidian
vault, `Docs/`, a wiki folder — whatever the project uses).

## Checkers — first and last

```
python <skill>/scripts/check_md_structure.py <docs> [--fix] [--forbid-section-signs] [--no-whitespace] [--require-toc]
python <skill>/scripts/check_md_links.py <docs>
python <skill>/scripts/check_duplicates.py <docs>
```

- **Structure** — `[NUM]` broken ordered-list numbering (per indent level, per section), `[ANC]` `[[File#Heading]]`
  / `[[#Heading]]` to a missing heading, `[BLK]` `[[File#^id]]` to a missing block ID, `[DUPH]` a heading text
  repeated in one file (ambiguous anchor), `[NUMH]` a heading starting with a number, `[HCHR]` a `##`+ heading no
  link can reliably reach (`# | ^ %% [[ ]]`, or `:`), `[PIPE]` an unescaped alias pipe in a table row, `[TBL]` an
  indented table row (a table inside a list item renders as text), `[COLS]` a row whose cell count differs from the
  header, `[TOC]` a table of contents out of step with the headings (below), `[WS ]` trailing / double spaces.
  `--forbid-section-signs` also flags `§2.5` references for docs that retired that scheme; `--require-toc` flags a
  file of 3+ `##` sections without a table of contents. Fenced code is skipped.
  `--fix` **renumbers lists and rebuilds tables of contents, but never touches other links**: a reference may be in
  range and still point at the wrong item — only a person can tell. Re-read the touched sections after `--fix`.
- **Links** — `[LINK]` `[text](path)` to a missing file, `[WIKI]` `[[Page]]` to a missing page, `[ABS ]` a
  `file:///` or drive-absolute link (breaks on any other machine — link relatively). Link syntax shown in inline
  code is skipped, and so are `_TEMPLATE.md` files.
- **Repeated sentences** — compares **ignoring punctuation and case**, because a real duplicate usually differs
  only by a comma against a dash: the new wording landed next to the old one. `[DUP]` — said twice in the same
  spot, fix it. `[ECHO]` — repeated farther away or in another file: sometimes a deliberate refrain, sometimes a
  glossary entry that swallowed the rule it should only link to. Headings, tables, quotes, code, link text and the
  "See also" section are not compared.

### Project dictionaries — run these when the project has them

The checkers are here; what they look for is the project's, in `<project>/.claude/md-doc-hygiene/`:

```
python <skill>/scripts/check_jargon.py [<docs>]     # needs jargon.json; without <docs> - its "paths"
python <skill>/scripts/check_terms.py [<chapters>]  # needs terms.json; without <chapters> - its "paths"
python <skill>/scripts/check_series.py [--strict]   # needs series.json
```

- **Jargon** (`jargon.json`) — words the project swept out of its documents, each with what to write instead and
  an optional exception pattern around the match. `[JRG]` = an error: rewrite, or — if the word has to stay — ask
  the person and add an exception to the project's list. The format is in the script's header.
- **Glossary** (`terms.json`) — per-chapter Terms sections (the rule «a term is defined once» below, checked):
  `[DUP]` a Term defined in several chapters, `[ANC]` its anchor outside the Terms section — errors; `[LEN]` a
  definition grown into rules, `[ORP]` a Term nobody else mentions — warnings for a person. The settings (heading
  text, anchor prefix, catalogue chapters exempt from `[ANC]`, words that mark a pointer entry) are in the
  script's header.
- **Numbered series** (`series.json`) — a register whose headings carry an ID on purpose (`## Q12. …`: questions,
  decisions, requirements) and the places that name those IDs. `[SEQ ]` the register's numbers repeat, skip or
  run out of order, `[GONE]` the text names a number the register does not have — errors; `[BARE]` an existing
  number named as plain text instead of a link — a warning (`--strict` makes it an error). Mentions inside
  `[[links]]` and code are not checked. **Never promise a number in advance** ("the next free one is Q15"): it goes
  stale as soon as someone else takes it. Give the number when the entry is written, and refer to the register
  until then. The format is in the script's header.

No such file — the project keeps no such rule; skip the check. A project may still carry other checkers of its
own — run those too.

## Headings
- **No numbers.** `### Demolition`, not `### 2.5. Demolition`. Numbers drift and breed hacks like `2.1a`,
  `2.8a–d` invented only to avoid renumbering neighbours.
- **Meaningful and short.** No bureaucratese, no enumerations, no counters that go stale (`… — 28 types`), no
  `[[links]]` inside a heading — such a heading cannot carry an anchor.
- Heading text is **unique within the file**, or its anchor is ambiguous.

## Links
Show the **meaning**, not the address. File names appear in the visible text only in a table of contents.

| Target | Write | Reader sees |
|---|---|---|
| a document | `[[09_Catalog\|Item catalog]]` | Item catalog |
| a section | `[[06_Construction#Demolition\|Demolition]]` | Demolition |
| a section of this file | `[[#Demolition\|Demolition]]` | Demolition |
| a term | `[[01_Economy#^t-scrap\|Scrap]]` | Scrap |
| a rule | `[[06_Construction#^r-demolition-auto\|Demolition is automatic…]]` | the rule's name |

**Exception — the vault's table of contents** (a list of documents): bare links (`[[01_Economy]]`); the point there
is "file name → content", and an alias kills it. In "See also" sections aliases are wanted.

**A document's own table of contents** is a list of links to its headings between `<!-- toc -->` and
`<!-- /toc -->`, each `[[#Heading|Heading]]`, levels `##`–`###` (`<!-- toc:2 -->` for `##` only, up to
`<!-- toc:6 -->`), one two-space indent per level:

```
<!-- toc -->
- [[#Summary|Summary]]
- [[#Problems|Problems]]
  - [[#Blocks play|Blocks play]]
<!-- /toc -->
```

The structure checker holds it to the headings below it — `[ANC]` for an entry that reaches no heading, `[TOC]` for a
missing heading, a stale entry, wrong order or nesting — and `--fix` rebuilds it. When a document needs one and
what goes around it: the sibling skill **docs-for-readers**.

A `§2.5`-style reference is a regression wherever the docs use heading links; `--forbid-section-signs` catches it.

## Anchors (block IDs)
- `^t-` — a glossary **term**: `^t-scrap`. `^r-` — a **rule** item: `^r-doors-lock-in-combat`. An open question
  is a heading, not a block, and is linked by its text (docs-for-readers "Open questions").
- Latin kebab-case, placed **at the end of the line** of the target block.
- Different prefixes are not a whim: the reader sees where a link goes, a term and a rule with the same slug do not
  collide, and meaningful anchors stand apart from Obsidian's generated ones (`^a1b2c3`).
- Put them **only on what is actually linked**, or the glossary fills up with noise.

## A term is defined once
- **One definition per term, in its "home" document.** The `^t-` anchor stands only there.
- **Elsewhere — a pointer, not a second definition:**
  `- **Stability**: defined [[03_Combat#^t-stability|in the combat rules]]; here it matters because…`.
  No anchor on the pointer — otherwise the term gets two addresses and links split between them.
- **A rule is not a definition, even if it starts with the term.** `- **Loot is an origin, not a channel.** …`
  reads like a second dictionary entry. Start such an item with the claim and link to the definition.

## A rule is stated once
Same logic as terms, broken more often: rules get retold instead of quoted, and the copies drift silently.
- **The mechanic lives in its home document; others link to it.** Overview / showcase documents describe where a
  thing is visible, not how it works.
- **Absolutes are never retold.** "always", "never", "only", "the single" — in a copy such a word lives its own life
  and after a couple of edits contradicts the original ("**almost** any function" became "any function").
- **Compare modality, not meaning.** A retelling is usually right in substance and wrong in strength; open the
  original and compare exactly the "almost / only / always" words.
- **When copies diverge, fix the source, not the majority** — the right answer follows from the definition, not
  from a vote.

## Traps (all seen in practice)
1. **Ranges.** "items 1–2" turned into links becomes `[[…]]–2` — a dangling tail. Expand into two links joined by
   "and". Find regressions: `grep -rnoE "\]\]–[0-9]|\]\]\.[0-9]" <docs>`.
2. **Bare "(item 5)" inside a section** — the most fragile references: they break when a neighbour is inserted and
   nothing catches them. Turn them into `[[#^r-…|name]]`.
3. **Someone else's "§"/"item N" in the line.** If another document is mentioned earlier in the line, a bare
   reference may belong to **it**. **Never guess automatically** — read it. A wrong link is quieter and worse than
   text without a link.
4. **A reference to a range of sections** (`§2.4–2.5`) is two different sections, not one.
5. **A link in a table cell — the alias pipe must be escaped:** `[[05_People\|People]]`. A bare `|` inside `[[…]]` is
   a column border to the renderer. Untouched, it stays quiet; but Obsidian's visual table editor rebuilds the row
   by its own parse — and **every such link is torn between cells**, plus an extra column. Only a revert and
   escaping fix it. The structure checker reports it as `[PIPE]`.

## Constraints
- **Never write .md through Windows PowerShell 5.1 `Get-Content`/`Set-Content`** — they read UTF-8 as ANSI and
  write a BOM; non-ASCII text dies. Use Write/Edit, or Python with `open(..., encoding='utf-8', newline='\n')`.
- Mass edits — **dry-run first** with a report, then write. Show the user what and how much will change.
- Content questions (not form) go to the user or to the project's task tracker — don't decide them here.
