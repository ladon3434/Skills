# ue-perf

Profiling an Unreal Engine 5.x game with Unreal Insights, without the Insights window: how to capture a `.utrace`
and a script that exports it headless and reduces it to a text digest an agent can read. Works in any project;
starts neither the editor nor the game.

## Contents

Paths are relative to the skill folder `skills/ue-perf/`; `.claude-plugin/` and `bin/` sit at the plugin root.

| Path | What |
| --- | --- |
| `SKILL.md` | capture (build type, channels, where the trace lands), analysis, reading the digest, traps |
| `references/capture.md` | command-line switches, presets and channels, console commands, named events — with engine file:line |
| `references/insights-export.md` | `UnrealInsights.exe` headless switches, `TimingInsights.Export*` commands and their CSV formats, what the script runs |
| `scripts/ue-trace.cmd` → `mjs/ue-trace.mjs` | `find` traces, `analyze` a trace (two headless Insights runs + digest), `digest` existing CSVs, `--selftest` |
| `scripts/mjs/ue-engine.mjs` | engine lookup (the same file as in ue-workstation) |

The digest: Game/Rendering frame times (p50/p95/p99/max, over-budget counts, hitches), top timers by exclusive
time for each chosen CPU thread (GPU timers subtracted out), the GPU table, the worst game frames broken down per
thread, optional per-region tables. Wait scopes and per-frame roots are tagged so they are not mistaken for
hotspots. It ends with `RESULT: trace <OK|NO-DATA|FAILED> (exit N) - <summary>`.

## Installation

A plugin of the `ue-skills` marketplace (how to add the marketplace — the root `README.md`). From the project folder:

```
claude plugin install ue-perf@ue-skills --scope local   :: this project only; the project repository is not changed
claude plugin install ue-perf@ue-skills                 :: every project on the machine
```

Disable — `/plugin` → Installed (space), or `claude plugin disable ue-perf@ue-skills`. After installing —
`/reload-plugins` or a new session. `<skill>` paths — the plugin's `skills/ue-perf/` folder.

The plugin puts the command `ue-trace` on the Bash tool's PATH (the `bin/` folder); from PowerShell — through
`<skill>\scripts\ue-trace.cmd`. Needs `node` 18+ and `UnrealInsights.exe` (shipped in
`Engine\Binaries\Win64` of launcher installs; in a source build, build the `UnrealInsights` program target or pass
`--insights <exe>`). The engine is found as in the other plugins: `UNREAL_HOME` → `UE_VERSION` /
`EngineAssociation` → the Epic registry.

Check without an engine: `ue-trace --selftest`.
