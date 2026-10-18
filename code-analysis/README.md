# code-analysis

A code analysis skill for any Unreal Engine project: analysing a whole subject, reviewing changes,
debugging to the root cause.

## Contents

Paths are relative to the skill folder `skills/code-analysis/`; `.claude-plugin/`, `hooks/hooks.json`, `bin/`, `agents/` sit at the plugin root.

| Path | What |
| --- | --- |
| `SKILL.md` | routing, goal-and-limits card and brief, analysis by axes (incl. compliance, large-subject checks), axis prompt, severity 0–3, report |
| `references/review.md` | diff review, scope of the check by signs, UE C++ checklist (GC, lambdas and timers, lifecycle, perf, names and texts), the codex reviewer (without it — agy/Gemini Pro) |
| `references/review-replication.md` | networking pass of a review or audit (UE 5.8): authority and roles, replicated properties and OnRep, RPCs, ownership/relevancy/dormancy, subobjects, Fast Array, NetSerialize, prediction, Iris, multiplayer testing; source-verified |
| `references/debug.md` | proving the root before the fix: where the evidence is, crash dumps, addresses and log lines, causes by frequency, breakpoints, instrumentation |
| `references/external-voices.md` | agy / codex / fable, waiting for voices, completeness critic, refuter |
| `references/engine-api/*.md` | cache of verified UE 5.8 signatures |
| `references/ue-hazards.md` | 116 hazards: engine by domain + separately Windows / Claude Code |
| `scripts/engine-api.*` | engine signature selector |
| `scripts/engine-index.*` | ctags index of the engine and samples |
| `scripts/hazards.*` | known-hazard search |
| `scripts/log-scan.*` | build / cook / UAT log digest: kinds, repeat collapsing, `--since`, `--file` |
| `scripts/crash-triage.*` | crash folder / minidump digest: error, type, collapsed stack with the first project frame, crash-log lines, next step; symbolicates an unsymbolicated stack through `cdb`; `--json`, `--list`, `--selftest` |
| `scripts/mjs/ue-engine.mjs` | finding the installed engine |
| `agents/*.md` | `code-scout`, `engine-reader`, `log-triage` |

## Installation

A plugin of the `ue-skills` marketplace (how to add the marketplace — the root `README.md`). From the project folder:

```
claude plugin install code-analysis@ue-skills --scope local   :: this project only; the project repository is not changed
claude plugin install code-analysis@ue-skills                 :: every project on the machine
```

Disable — `/plugin` → Installed (space), or `claude plugin disable code-analysis@ue-skills`. After installing —
`/reload-plugins` or a new session. `<skill>` paths below are the plugin's `skills/code-analysis/` folder.

The agents come with the plugin: `code-analysis:code-scout`, `code-analysis:engine-reader`, `code-analysis:log-triage`.
The plugin puts the commands `engine-api`, `hazards`, `log-scan` and `crash-triage` on the Bash tool's PATH (the `bin/` folder); from PowerShell — through
`<skill>\scripts\*.cmd`.

## Environment

| Variable | Why | Default |
| --- | --- | --- |
| `UNREAL_HOME` | engine root (required for a source build) | from the Epic registry by version |
| `UE_VERSION` | engine version | `EngineAssociation` from the `.uproject`, else 5.8 |
| `UE_SAMPLES_ROOT` | Epic samples for the index and agents | unset — no samples index |
| `ENGINE_INDEX_HOME` | shared folder of ctags indexes, one subfolder per engine inside (`UE_5.8\`) | `<engine>\.engine-index` |
| `KNOWN_HAZARDS` | the project's hazard file | `<project>\.claude\docs\known-hazards.md` |

Needs `node` and `rg`; `ctags` is optional (without it, slower and through ripgrep only). `crash-triage` symbolicates
minidumps with `cdb.exe` (Windows only, optional: without it the crash context's own stack is still read) —
`winget install Microsoft.WinDbg`, or the Windows SDK feature "Debugging Tools for Windows"; `CDB_EXE` points at a
specific one.
