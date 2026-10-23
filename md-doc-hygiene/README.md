# md-doc-hygiene

Markdown / Obsidian documentation in two skills. `docs-for-readers` — what a document says and in what order, so
a reader gets it in a minute: header and summary, problems by impact, open questions that can be answered without
remembering anything, a table of contents with working links. `md-doc-hygiene` — the form and the checkers that
enforce it: headings without numbers, links by heading text and block IDs instead of "§2.5", list numbering, tables,
tables of contents kept in step with the headings, one definition per term and per rule. Works on any docs tree.

## Contents

Paths are relative to the plugin's `skills/` folder; `.claude-plugin/` sits at the plugin root.

| Path | What |
| --- | --- |
| `docs-for-readers/SKILL.md` | a document for people: structure, table of contents, context before claims, facts and their verification status, the problem and open-question templates, the pre-handover checklist |
| `md-doc-hygiene/SKILL.md` | headings, links, anchors, a document's table of contents, single definitions, traps, constraints |
| `md-doc-hygiene/scripts/check_md_structure.py` | list numbering and tables of contents (`--fix` renumbers and rebuilds), heading/block anchors, duplicate, numbered and unlinkable headings, tables (pipes, nesting in lists, cell counts), whitespace |
| `md-doc-hygiene/scripts/check_md_links.py` | `[text](path)` and `[[wiki]]` links resolve; absolute `file:///` links flagged |
| `md-doc-hygiene/scripts/check_duplicates.py` | repeated sentences, compared without punctuation and case |
| `md-doc-hygiene/scripts/check_jargon.py` | words the project swept out of its docs (list in `<project>/.claude/md-doc-hygiene/jargon.json`) |
| `md-doc-hygiene/scripts/check_terms.py` | per-chapter glossaries: a term defined once, its anchor in the Terms section (settings in `.../terms.json`) |
| `md-doc-hygiene/scripts/check_series.py` | numbered heading series (`## Q12. …`): no repeats or gaps, every number the text names exists (series in `.../series.json`) |

## Install

A plugin of the `ue-skills` marketplace (adding the marketplace: root `README.md`). From the project folder:

```
claude plugin install md-doc-hygiene@ue-skills --scope local   :: this project only; the project repository is not changed
claude plugin install md-doc-hygiene@ue-skills                 :: every project on the machine
```

Turn off: `/plugin` → Installed (space), or `claude plugin disable md-doc-hygiene@ue-skills`. After installing —
`/reload-plugins` or a new session.

Needs Python 3 (stdlib only). Every checker takes the docs root as its argument (default: the current directory).
