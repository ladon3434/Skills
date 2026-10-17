---
name: code-analysis
description: >
  Code analysis in any project, any code (tuned for Unreal C++):
  analyse a module, class, mechanic or agent harness; review a diff/commits,
  incl. GC/leak, perf, style and replication checks ("replication review",
  "multiplayer bug"); hunt a bug's root cause before fixing —
  crash dump ("symbolicate the crash"), callstack, Accessed None, hang, flaky test, behaviour
  that contradicts the code; post-mortem of cook/build/UAT logs ("the build passed, but…").
  Reads and reports only, never edits: the fix is ue-cpp-authoring, a build that fails is
  ue-build-test. Tools: engine-api (signatures), hazards (known hazards), log-scan
  (log digest), crash-triage (crash to symbolicated stack); agents
  code-scout / engine-reader / log-triage. Russian: «проанализируй», «аудит»,
  «разбери модуль», «отревьюй», «посмотри изменения», «проверь на утечки/GC»,
  «перф-ревью», «проверь стиль», «проверь репликацию», «десинк», «не реплицируется», «почему упало», «разбери краш», «символизируй дамп», «найди причину», «тест флакает», «что в логах».
---

# code-analysis — take apart, check, find the root

The skill reads and reports. Edits are ordinary work after the report.
Paths below are relative to this skill's folder (loading the skill shows it); it is
written `<skill>` from here on.

Which mode:

| Request | Mode | Rules |
| --- | --- | --- |
| A whole subject: module, class, mechanic, harness, "audit" | analysis | this file, below |
| Changed lines: diff, commit, commit range, PR; checking files for GC, perf, style | review | `references/review.md` |
| Replication / multiplayer: a networked diff, a desync, «does not replicate» | review, networking pass | `references/review-replication.md` |
| A specific failure with an unproven cause: crash, dump, `Accessed None`, flake | debugging | `references/debug.md` |
| An editor/game crash: `Saved/Crashes`, a `.dmp`, «разбери краш» | debugging, crash first | `crash-triage.cmd`, then `references/debug.md` |
| The build or cook passed — what is in the logs | debugging, "Where the evidence is" | `log-scan.cmd`, `references/debug.md` |

Reviewing a whole module is analysis, not review. Debugging comes before any fix,
especially when the "obvious" fix has already failed.

## Tools

Scripts are Node, no dependencies; they need `node` and `rg` (ripgrep) on PATH, and the
index also needs `ctags`/`readtags` (Universal Ctags). On Windows call the `.cmd`, otherwise
`node <skill>/scripts/mjs/<name>.mjs`.

- **Engine signature** — `<skill>/scripts/engine-api.cmd <Symbol>[::Member] [--module <Name>] [--cpp]`.
  Prints the declaration and `file:line`, no more than a couple of dozen lines — fine to call
  right in the main context. Order: cache (`<skill>/references/engine-api/*.md`, then the
  project's `.claude/engine-api/*.md`) → ctags index → ripgrep over `Engine/Source` and
  `Engine/Plugins`. A signature that was hard to get goes into the skill's cache as a
  `## <Symbol>` section with a date. Math: `TVector::Size2D`, not
  `FVector::Size2D` (template aliases).
- **Engine index** — `<skill>/scripts/engine-index.cmd [--engine|--templates|--status]`.
  Needed for plugin coverage (71% of the engine). Lives in `ENGINE_INDEX_HOME/<engine folder>/`,
  without the variable — next to the engine (`<engine>/.engine-index`; an engine in `Program Files`
  may be write-protected — set the variable then). After an engine update the index is stale;
  the selector falls back to ripgrep on its own until it is rebuilt.
- **Where the engine is** — `node <skill>/scripts/mjs/ue-engine.mjs`. Order: `UNREAL_HOME` →
  the version from `EngineAssociation` in the `.uproject` (the project wins), else `UE_VERSION` → Epic registry /
  launcher manifest. A source build (a GUID in the `.uproject`) — only through `UNREAL_HOME`.
  Epic samples — `UE_SAMPLES_ROOT` (folder of sample projects; unset — no samples index);
  `engine-api` searches them too, a hit is marked «Epic samples».
- **Known hazards** — `<skill>/scripts/hazards.cmd <symptom words> [--brief]`;
  without words — the table of contents. Searches the project's `.claude/docs/known-hazards.md` (or
  `KNOWN_HAZARDS=<path>`) and the shared `<skill>/references/ue-hazards.md` (~115 hazards:
  build, editor, assets, Blueprint, materials, UI, animation, world, networking, Epic MCP, and
  separately Windows / Claude Code). Never read the file whole. A new repeatable
  hazard is one section: project-specific in the project's file, engine-wide in the skill's file.
  Start debugging with `hazards.cmd <symptom>` — it is cheaper than any investigation.
- **Build, cook, UAT logs** — `<skill>/scripts/log-scan.cmd [--since <min> | --latest N] [--file <path>]`:
  suspicious lines by kind, repeats collapsed, output capped; exit 1 — there are findings.
  Taking a huge log apart as a whole — the `log-triage` agent.
- **Crash folder or minidump** — `<skill>/scripts/crash-triage.cmd [<crash folder> | <.dmp>] [--symbolicate] [--symbols <pdb dir>] [--json]`;
  without a path — the newest crash of the project. Error, crash type, the top frames with engine/OS noise
  collapsed and the first project frame marked, the crash log's fatal lines, what to open next, and
  `RESULT: crash <type> at <frame>`. An unsymbolicated stack goes through `cdb` on the minidump (the command is
  printed to rerun); no `cdb` — it says what to install. Exit 0 stack, 1 nothing usable, 2 setup error.
- In Bash the plugin's commands are available by name: `engine-api`, `hazards`, `log-scan`, `crash-triage`.
- **Agents** come with the plugin and are called with its prefix — `code-analysis:code-scout`,
  `code-analysis:engine-reader`, `code-analysis:log-triage`; short names below:
  `code-scout` (haiku) — where things are, paths and roles; `engine-reader` (sonnet) — how
  an engine or sample mechanism works, with `file:line`; `log-triage` (haiku) — errors from
  a huge log plus a verdict. Read the engine and samples only through them, not in the main
  context. Give the agent the engine root (from `ue-engine.mjs`) and, if needed, the samples
  root. Agents not installed — give the same prompt to `general-purpose`/`Explore`.

## Analysing a whole subject

1. **Boundaries.** Headers, `.cpp`, the module, the assets it drives, and the tools
   that create it. Unknown location — `code-scout`. Links:
   - the C++ graph — `rg` / `code-scout`; clangd (`LSP`) only if the task cannot be
     solved without it: on a UE-sized project it eats tens of GB of commit (`hazards.cmd clangd`);
   - asset links the source cannot see — `rg -la "<Symbol>" Content/ -g "*.uasset"`
     (candidates, not proof);
   - foreign engine API — `engine-api.cmd`, a whole mechanism — `engine-reader`.
2. **Axes — fanned out in ONE message**, one `general-purpose` agent per axis. Each writes
   findings to a report file as `{axis, severity, file:line, what, why, fix}` rows and answers
   with the file path and a status line. A subject of ≤2 files / <500 lines — walk the axes
   yourself, no fan-out.
3. **Deep pass** (on the owner's word, "deep", an architectural decision) — external
   voices and a completeness critic, `references/external-voices.md`.
4. **Synthesis.** Dedup, rank by severity across axes, verify every
   load-bearing finding against the code (an agent may be wrong), report.

### Axes (game code / engine module)

1. **Logic and consistency** — bugs, lifecycle (`BeginPlay`/`EndPlay`,
   `PostInitProperties`, GC and `UPROPERTY` ownership, weak pointers), null states,
   unhandled failure paths, missing validation, logging against the project's
   conventions. Network model — per the project: in a single-player game missing
   replication is not a finding.
2. **C++ interface** — responsibility, coupling, module boundaries (runtime does not
   pull editor API — `hazards.cmd editor-only`), Blueprint exposure versus
   actual use, `*_API` exports.
3. **Designer surface** — the Details panel: names, `ToolTip`, units,
   categories, `ClampMin`/`ClampMax`, defaults under which a fresh instance is already valid.
4. **Agent authoring** — only if the project has tools (MCP, editor scripts)
   that create this subject: do they cover the meaningful configuration, is there a
   result check, will an agent pick the right tool correctly.

A non-game subject (tooling, scripts, services) — axes 1 and 2 as is, and instead of 3 and 4:
**testability** (what is verifiable without a live editor/service) and **failures** (what
the user sees when an external dependency is down).

### Subject — an agent harness

`CLAUDE.md`, `.claude/**`, hooks, `.mcp.json`, the tool surface. The yardstick — for
every rule, document and gate: does it serve the result or a defect the owner
controls; has it prevented at least one real failure; is it a fact the
model cannot learn otherwise? If the project has an owner's rules page — measure
against it. For agent text the default is to delete. Runs only on the owner's word.

## Report

- In the language of the conversation. Blockers first, then by axis; an axis without findings says so.
  Each finding: `path:line` — what — why — how to fix. At the end — an action list.
- Raw axis reports go to the project's `.local/audits/<yyyy-mm-dd>-<slug>/` (if the project
  uses another place — there). They do not go into git.
- A conclusion resting only on agreement between agents of one vendor is marked as such.
