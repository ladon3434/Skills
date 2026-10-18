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
  root. Agents not installed — give the same prompt to `general-purpose` (`Explore` will do
  for locating, not for judging code against the project's rules: it does not load `CLAUDE.md`).

## Analysing a whole subject

1. **Boundaries.** Headers, `.cpp`, the module, the assets it drives, and the tools
   that create it. Unknown location — `code-scout`. Links:
   - the C++ graph — `rg` / `code-scout`; clangd (`LSP`) only if the task cannot be
     solved without it: on a UE-sized project it eats tens of GB of commit (`hazards.cmd clangd`);
   - asset links the source cannot see — `rg --no-config -la "<Symbol>" Content/ -g "*.uasset"`
     (`--no-config`: a user ripgrep config can hide matches). Candidates, not proof: a count
     a finding rests on is confirmed by the full name, a second marker, or in the editor;
   - foreign engine API — `engine-api.cmd`, a whole mechanism — `engine-reader`.
   Also find the **measure** yourself: a design page, the task's acceptance criteria, a plan
   in `.local/plans/` — whatever the project keeps.
2. **Goal and limits — one question card**, after step 1, before any fan-out. Ask only what
   the owner's words did not already say; the recommended option first, options name the
   paths and sizes found:
   - **goal** — bugs before a milestone / refactoring plan / ready for designers / matches the
     design / general health (the goal picks the axes and the severity threshold);
   - **limits** — the subject only / plus direct dependencies / plus assets and tools;
   - **measure** — the document found / project conventions only / a document the owner names;
   - **depth** — quick pass without agents / standard axis fan-out / deep pass.
   The answers go into a **brief**, `.local/audits/<yyyy-mm-dd>-<slug>/README.md`: goal, in
   scope, out of scope, measure, axes, depth. Every agent gets this path — it is their only
   window into the conversation. A workflow cannot ask mid-run: the card comes before it.
3. **Axes — fanned out in ONE message**, one `general-purpose` agent per axis (not `Explore`/`Plan`:
   they do not load `CLAUDE.md`, so they do not know the project's conventions). Prompt —
   "Axis prompt" below. A subject of ≤2 files / <500 lines — walk the axes yourself, no fan-out.
4. **Deep pass** (depth "deep", the owner's word, an architectural decision) — external
   voices, a completeness critic and a refuter, `references/external-voices.md`.
5. **Synthesis.** Dedup, rank by severity across axes. Every finding of severity 2–3 is
   re-read at its `file:line` before it enters the report (an agent may be wrong): one that
   does not hold is dropped, a doubtful one is marked.

### Axis prompt

The agent starts without the conversation; everything it needs is in the prompt. In English:

```text
Audit axis 3 (designer surface) of the Door mechanic.
Brief: .local/audits/2026-10-19-door/README.md — goal: ready for designers.
In scope: Source/Game/Door/*.h, *.cpp; /Game/Props/Door/BP_Door.
Out of scope: save system, audio.
Measure: Docs/Design/Rooms.md (section "Doors").
Check: UPROPERTY names, tooltips, units, categories, defaults.
Severity 0-3 (none / minor / notable / severe), each with the evidence that set it.
Re-read every severity 2-3 finding at its file:line before reporting it.
Output rows {axis, severity, file:line, what, why, fix, confidence};
a "checked:" line listing what you read; out-of-scope findings as a separate list.
Write your report to .local/audits/2026-10-19-door/axis3.md,
then answer with the path and one status line.
```

The last line is mandatory: without it the agent returns text instead of a file.

### Severity

| | Meaning |
| --- | --- |
| 0 — none | no problem, no work needed |
| 1 — minor | fixed in passing, does not hinder development |
| 2 — notable | slows the team and grows over time; needs its own task |
| 3 — severe | already breaks deadlines or working features; the project is unpredictable until fixed |

Every rating names the evidence that set it — a `file:line`, a count, a commit. A blocker is a 3.

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
5. **Compliance** — only when the measure is a design document or acceptance criteria:
   every requirement → implemented / partial / missing / contradicts, with a `file:line` or a
   named absence. Also: documents that contradict each other, and stale ones describing what is gone.

### A large subject (a whole module, a plugin, the project)

On top of the axes:

- **UE traps** — logic in `Tick` (`rg -n "bCanEverTick\s*=\s*true" Source`), hard asset paths
  in code (`ConstructorHelpers`, `LoadObject<`, `TEXT("/Game/` — or `ue-content-gates`), raw
  `UObject*` without `UPROPERTY`/`TObjectPtr`, timers and delegates nobody unbinds.
- **Home-grown versions of standard systems** — own state machines instead of StateTree, own input
  instead of Enhanced Input, plain UMG screens instead of CommonUI, own save/ability frameworks next
  to the engine's. A finding names what the standard system would remove.
- **Hot spots by history** — `git log --no-merges --name-only --format= -- Source | sort | uniq -c | sort -rn | head -30`;
  the share of fix commits that follow feature commits in the same files. Frequently fixed files are
  where the axes look first.
- **Blueprints** — sorted into three groups: keep / move the logic to C++ / delete.

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

- In the language of the conversation. The first line repeats the goal and the limits from the brief.
  Blockers first, then by axis; each axis says what it checked, an axis without findings says so.
  Each finding: severity — `path:line` — what — why — how to fix. Out-of-scope findings — a short list
  at the end. Last — an action list with the skill that does each action.
- Raw axis reports go to the project's `.local/audits/<yyyy-mm-dd>-<slug>/` (if the project
  uses another place — there). They do not go into git.
- A conclusion resting only on agreement between agents of one vendor is marked as such.
