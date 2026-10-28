---
name: docs-for-readers
description: How to write a document people will actually read — a review, analysis, investigation, plan, test report or design proposal for game designers, programmers, artists or a lead — and how to rewrite or proofread one so it reads in a minute. Covers structure (header, summary, terms, problems, questions, plan, appendices), how important it is now, what the plan may break and how to keep it whole, an Obsidian table of contents with working links, context before every claim, verification status of findings, the problem template and open questions that can be answered without remembering anything. Use when writing or improving such a document, "write a review / report / plan", "make the doc readable", "proofread the doc", "add a table of contents". Russian: «напиши разбор / отчёт / план», «сделай доку читаемой», «вычитай документ», «перепиши для геймдизайнера», «добавь оглавление», «оформи вопросы к ГД». The FORM rules (links, anchors, numbering, checkers) are the sibling skill md-doc-hygiene.
---

# Documents for people

A reader opens a document to learn in a minute what is broken and what is needed from them. They read the details
later, and only some of them. Everything below serves that.

The form of the file — heading links, block IDs, list numbering, table pipes — is the sibling skill
**md-doc-hygiene**; its checkers end every edit here too. This skill owns what the document says and in what order.

## Structure

Sections, in this order:

1. **Header:**
   - title (`#`), then the table of contents (below);
   - date;
   - status ("review, nothing fixed yet", "plan", "done");
   - **importance now** — one verdict with its reason (below);
   - a "who → which sections to read" table;
   - what it is based on: code, Blueprint graphs, design pages, in-game checks.
2. **Summary.** 3–7 points, then "what we need from you" and "what can be done without waiting for answers". One
   of the points is the main breakage risk of the proposal and how we contain it. A reader who stops here must know
   the essentials.
3. **Terms** — defined before their first use in the text.
4. **How it works now** — as the player (or the user of the system) sees it, not node by node.
5. **Problems** — one list, sorted by impact on the player.
6. **Questions** for whoever decides.
7. **Proposal and plan.**
8. **What may break** — the risks of the plan to what already works, and what we do about each (below).
9. **Appendices:** how it was checked, raw measurements, "where things live in the project", links to source
   pages.

Methodology and raw numbers stay out of the main text. Keep the conclusion there and link to the appendix.

A short note (one screen, one topic) keeps only what it needs: header, summary, the body. The order stays. A note
that proposes a change keeps its importance verdict and its "what may break", however short.

## Importance now

The reader decides first whether to read on at all, so the header says how much this matters **now**, by the
analysis, not by the author's feeling. One verdict and the reason in one or two sentences:

| Verdict | When |
| --- | --- |
| **Urgent** | blocks play, a build, a release or someone's work today; or data is being lost |
| **This milestone** | the player meets it on a main path, or a planned feature cannot start without it |
| **Can wait** | rare, cosmetic, or only a code risk that does not reproduce today |
| **Do not do** | the cost or the breakage risk is above the gain; say what we live with instead |

The reason names the evidence: how often it happens, who is blocked, the date it collides with, and **what happens
if we wait** — "nothing gets worse" is a valid and useful answer. The verdict follows from the problems list, not
the other way round; when the problems change, the verdict is re-checked. If two parts of the document differ in
importance, give each its verdict in the summary rather than averaging them.

## What may break

A plan that changes working code or content puts what was already done at risk. The reader — and whoever approves
the plan — needs that cost next to the gain, before the work starts. Every proposal has this section; "nothing may
break" is allowed only with the reason (a new file nothing uses yet, a change behind a switch that is off).

Look for what depends on the thing being changed, not only at the thing itself:

- code that calls it, other modules, subclasses;
- content that references it: Blueprints on the class, assets by path, data tables and data assets, levels;
- what is stored: save games, serialized properties and their defaults, config `.ini` values;
- what goes over the network: replicated properties and RPCs;
- what people rely on by habit: a cheat, a debug command, a test map, a workflow of designers or artists.

Each risk is a `###` heading with a short name ("Old saves lose their last checkpoint"), so the table of contents lists
it and plan steps link to it, and follows one template:

- **What may break** — the thing that works today, as the player or the colleague sees it.
- **Why** — the mechanism: a renamed property loses its saved values, a Blueprint overrides the function, a level
  places the old actor.
- **How likely and how bad** — high / medium / low each, with the reason (how many users of the thing were found,
  whether it ships).
- **How we will notice** — the test, the in-game check, the checker or log line that turns red. If nothing would
  notice, say so: an unnoticed breakage is a risk of its own and goes higher.
- **What we do to keep it whole:**
  - *before* — find every user of the thing (a search in code and content; in an Unreal project the ue-content-gates
    skill finds the assets that use a C++ class), pin the current behaviour with a test or
    a recorded in-game check, measure what will be compared after;
  - *during* — small steps, each one checked before the next; the old path kept until the new one is verified;
    redirectors for renamed classes, properties and assets; a switch (console variable, setting) to turn the new
    behaviour off; what we deliberately do not touch;
  - *after* — the checks to run and who runs them, and how to roll back (revert the commit, turn the switch off,
    restore the asset).
- **What remains** — the risk left after all this, and who accepts it.

The risks are sorted by likelihood times cost. Each plan step that carries a risk links to it by heading text, and
its check is a step of the plan, not a wish in this section.

## Table of contents

Every document with three or more `##` sections opens with a table of contents right under the title. It is a list
of Obsidian links to this file's own headings, between two markers the checker knows:

```
# Checkpoints review

<!-- toc -->
- [[#Summary|Summary]]
- [[#Problems|Problems]]
  - [[#Blocks play|Blocks play]]
  - [[#Not done per the design document|Not done per the design document]]
- [[#Questions|Questions]]
- [[#Proposal and plan|Proposal and plan]]
- [[#What may break|What may break]]
<!-- /toc -->
```

- **Entries are `[[#Heading|Heading]]`** — the heading text exactly as written, and the same text as the alias, so
  the reader sees the section name and `--fix` can rebuild the list without losing anything.
- **Levels `##` and `###`**; one indent step (two spaces) per level. Deep documents may go to `<!-- toc:2 -->`
  (`##` only); `<!-- toc:4 -->` and up add deeper levels. The title `#` is never in it.
- **Headings must be linkable**: unique in the file, no number at the start, none of `# | ^ %% [[ ]] :`. Write
  "Problems — blocks play", not "Problems: blocks play".
- **Never write it by hand twice.** After headings change, `check_md_structure.py <docs> --fix` rebuilds every
  table of contents from the headings; without `--fix` it reports `[TOC]` (a heading missing, a stale entry, order or
  nesting off) and `[ANC]` (an entry that reaches no heading). `--require-toc` also flags a document of 3+ sections
  without one.
- The table of contents of a whole vault (a list of documents, `[[09_Catalog]]`) is a different thing — bare links,
  md-doc-hygiene "Links".

## Context before the claim

- **Requirement before the finding.** First "how it should be": a short paraphrase of the requirement with a link to
  the design page and the name of the section or table row. Then "how it is". A bare "the arrows lead the wrong
  way" means nothing to the reader: wrong compared to what?
- **Do not refer to what has not been named.** "Which of the two scenarios is the main one" without the scenarios
  themselves is a meaningless question. List the options right where the question is asked, step by step, side by
  side.
- **Every summary point stands on its own.** It is clear without reading the rest of the document. Details go
  behind a link to a section.
- **Terms are unambiguous.** If the topic has two "graphs", the two things need two different names. The same goes
  for numbering: "the checkpoint of level 5", not "checkpoint 5", when a node index also exists. A term is defined once
  (md-doc-hygiene "A term is defined once").
- **Numbers carry units and meaning.** "302 map pixels to the right" is worse than "to the right of and above the
  current one".

## Facts

- **One fact, one place.** Do not split it into "hypothesis in one section, confirmation in another" with links
  going back and forth (md-doc-hygiene "A rule is stated once").
- **The final state, not the history of the work.** No "at first we thought X", "the concern was not confirmed",
  "the first version was written from the code". What turned out wrong is simply corrected.
- **Every finding has a verification status:** *checked in game*, *from the code*, *not checked*. A separate "Not
  checked" section in the appendix.
- **Severity by impact on the player.** A latent code risk that does not reproduce today does not rank above what
  the player sees every time.

## A problem

Every problem follows one template:

- **Requirement** — with a link, if the design document has one.
- **What the player sees.**
- **Cause** — asset, function, line of code.
- **How it was checked.**
- **Importance now** — the verdict from the scale in "Importance now", with its reason.
- **What to do** — and, if the fix touches working code or content, a link to its risk in "What may break".

Groups: "blocks play", "not done per the design document", "code risks", "observations, not bugs".

## Open questions

Every open question — to game design, to a colleague, to the author of some code — is written so that it can be
answered without remembering anything. Nobody remembers what a commit from half a year ago did, and a question that
says "what was TASK-2058 about?" gets no useful answer.

Each question has five parts, in this order:

1. **What we found** — the facts, with their sources: page and section, commit hash, date and branch, asset,
   function, measured numbers. Quote or paraphrase what the source actually says; when two sources disagree, show
   both.
2. **Context** — why it matters now: what it blocks, which plan step depends on it, what the player sees.
3. **The question** — one question, phrased so that it has a short answer.
4. **What we propose** — our answer, with the reason. People decide faster from a proposal than from a blank page.
   Skip only when we have no position, and say so.
5. **Expected answers and what we do for each** — two to four likely answers, and for each the concrete consequence
   for the plan. This shows the person what their answer changes and lets them pick instead of writing an essay.

For a question about old code, dig the context out first: the commit, its branch name, the neighbouring commits,
the config it touched. The branch name often tells more than the commit message.

Questions to game design also list the options from every source page, each with a link.

- **Each question is a `###` heading** with a short name ("Which checkpoint is the main one"), so the table of
  contents lists it and other sections link to it by text — `[[#Which checkpoint is the main one|…]]` — not by "Q3".
  Numbers drift when a question is decided; heading links do not. If the document keeps numbers for talking about
  questions aloud, they stay out of the heading and out of every link.
- **Decided items leave the questions** and go into a "Decided (date)" block. The decision is reflected everywhere
  the text touches it: the summary, the problems, the plan. The remaining questions are reworded to fit the
  decision.

## Links and formatting

- A source page (design wiki, Confluence, tracker) is a full link with its title. The table of all pages goes into
  the appendix. Where the project keeps its design pages and how to link them is in the project's `CLAUDE.md` or
  `AGENTS.md`.
- Identifiers (`BP_Checkpoint`, `IA_Confirm`) go in backticks. In sections for game design, only where they cannot be
  avoided. The full "where is what" list goes into the appendix.
- A table is for comparisons and measurements. A numbered list is for a sequence of steps.
- **Never nest a table in a list item.** Indented inside an item, many renderers do not recognise it and show plain
  text with vertical bars. If an item needs a table, write that item as a plain paragraph (`**1. Title.**`), put
  the table without indentation, and continue the list from the next number. The checker reports `[TBL]`; a row
  whose cell count differs from the header is `[COLS]`.
- The document's language is the project's docs language; code, logs and identifiers stay as they are.

## Before handing over

Run the md-doc-hygiene checkers on the docs folder until green — they sit next to this skill, in
`<this skill>/../md-doc-hygiene/scripts/`: `check_md_structure.py`, `check_md_links.py`, `check_duplicates.py`, plus
the project's dictionary checks if it has them (md-doc-hygiene "Checkers"). Then reread the document as someone who opens it for the first time:

- [ ] The table of contents is there and every entry opens its section in Obsidian.
- [ ] The summary is clear without the rest of the text.
- [ ] Every "this is wrong" has a "how it should be" next to it, with a link.
- [ ] Every "two options", "these scenarios", "that animation" is spelled out in place.
- [ ] Terms are defined before first use; no word has two meanings.
- [ ] Every finding has a verification status.
- [ ] The header has an importance verdict with its reason and "what happens if we wait"; every problem has one too.
- [ ] Every change to working code or content has its risk: what may break, why, how likely and how bad, how we
      will notice, what we do before / during / after, what remains.
- [ ] Every risk's check is a step of the plan, and the plan says how to roll back.
- [ ] No traces of the history of the work.
- [ ] Every open question has: what we found, context, the question, what we propose, expected answers with
      consequences.
- [ ] Decided items are out of the questions and reflected throughout the text.
- [ ] Tables render: no table inside a list item, column counts match.

## Handing over

The document is a file in the project's docs folder. The reply lists what changed and the touched files. Commit,
publishing anywhere (claude.ai, Confluence, a wiki) or sending it to people only on an explicit request.
