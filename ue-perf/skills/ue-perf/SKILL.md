---
name: ue-perf
description: >
  Profile an Unreal Engine 5.x game with Unreal Insights without the Insights window:
  capture a trace (.utrace) from the editor, a Standalone game or a packaged Development
  build — which channels for CPU, GPU, memory, loading; then read it offline into a short
  text digest — frame-time distribution and hitches, top timers per thread by exclusive
  time with counts, GPU passes, the worst frames broken down by thread, a time window or
  a TRACE region. Use for "profile", "profile the game", "why is it slow", "frame time",
  "fps drops", "hitches", "stutter", "Unreal Insights", "utrace", "read the trace",
  "what eats the game thread", "is it CPU or GPU bound". Russian: «профилируй»,
  «почему тормозит», «фризы», «просадка fps», «разбери трейс», «что жрёт кадр»,
  «упираемся в CPU или GPU».
---

# ue-perf — capture a trace, read it as text

Paths are relative to the skill folder (`<skill>`). The command `ue-trace` is on the Bash tool's PATH; from
PowerShell — `<skill>\scripts\ue-trace.cmd`. Needs `node` 18+ and `UnrealInsights.exe`
(`<engine>\Engine\Binaries\Win64`, shipped with launcher installs; the engine is found like everywhere in this
marketplace: `UNREAL_HOME` → the `.uproject` version → the Epic registry). Line-level source references —
`references/capture.md`, `references/insights-export.md`.

## 1. Capture

Trace exists only where `UE_TRACE_ENABLED`: every build **except Shipping** (Test included). A Shipping exe
writes nothing and says nothing — profile Development (or Test for numbers closest to Shipping).

| What runs | How to start the trace |
| --- | --- |
| Packaged Development / Test build | `MyGame.exe -tracefile=<name or path> -trace=default [-statnamedevents]` |
| Standalone from the editor build (no editor UI cost) | `UnrealEditor.exe <Project>.uproject <Map> -game -tracefile=... -trace=default` |
| Running editor / PIE | console `Trace.File [path] [channels]` … reproduce … `Trace.Stop` |
| Any running game with a console | `Trace.File` / `Trace.Stop`; `Trace.Status` prints what is on |

- **Where it lands**: a relative name or no name → `<Project>\Saved\Profiling\` (default name
  `YYYYMMDD_HHMMSS_xxxxxx.utrace`); `-tracehost=<ip>` or a running Insights browser → the trace store
  `%LOCALAPPDATA%\UnrealEngine\Common\UnrealTrace\Store\001\`. `ue-trace find` lists both, newest first.
- **Channels** (`-trace=` / `Trace.File`, comma list, presets expand):
  - CPU + GPU + frames: `default` = `cpu,gpu,frame,log,bookmark,screenshot,region`. Usually enough.
  - Task graph / loading / RHI detail: add `task`, `loadtime,assetloadtime`, `rhicommands,rendercommands`, `counters`.
  - Memory: `memory` = `memtag,memalloc,callstack,module` (`memory_light` without callstacks). These are
    **read-only channels: command line only** — `Trace.Enable memalloc` in a running game is refused.
- **Stat scopes**: `SCOPE_CYCLE_COUNTER` / `QUICK_SCOPE_CYCLE_COUNTER` reach Insights only with named events on —
  `-statnamedevents` (or console `stats.NamedEvents 1`). `TRACE_CPUPROFILER_EVENT_SCOPE` always does. Without
  it the game thread shows big unscoped gaps; with it every stat scope adds overhead — compare like with like.
- **Mark what matters**: `Trace.Bookmark <name>`, `Trace.RegionBegin <name>` / `Trace.RegionEnd <name>`
  (or `TRACE_BEGIN_REGION`/`TRACE_END_REGION` in code) — the region becomes `--region <name>` below.
- Capture 20–60 s of the problem, not minutes: a 10-minute editor session is ~700 MB and 40 s to export.

Starting the editor or the game is the user's call or `unreal-editor` / `ue-build-test` territory — this skill
does not launch them. Ask for the trace, or give the command line above.

## 2. Analyse

```
ue-trace find                                   # traces of this project + the trace store
ue-trace analyze <file.utrace> | --latest       # export headless + digest
         [--threads "GameThread,RenderThread*,RHIThread"] [--top 12] [--worst 5]
         [--start S --end S]  [--region "Load*"]  [--out DIR]  [--timeout 900]
ue-trace digest <csv dir> [--top N]             # re-read CSVs from an earlier run, no engine
```

`analyze` starts `UnrealInsights.exe -OpenTraceFile=… -AutoQuit -NoUI -ExecOnAnalysisCompleteCmd=@=<rsp>`
twice (pass 1: threads, frames, timer statistics; pass 2: events of the K worst game frames), writes CSVs to
`%TEMP%\ue-trace\<trace>` and prints the digest. ~5 s for a 40 MB trace, ~40 s for 700 MB. It does not touch the
trace file. Ends with `RESULT: trace <OK|NO-DATA|FAILED> (exit N) - <summary>`; on FAILED read `pass1.log` in
the CSV folder. A trace still being written (game running) — stop it first.

## 3. Read the digest

- **Frames**: Game / Rendering frame time p50/p95/p99/max, counts over 33.3/50/100 ms, hitches = frames over
  2× p50. p50 is the steady cost; p99/max are the hitches — different causes, different fixes.
- **Per thread table**, sorted by exclusive (self) time: `excl ms`, `ms/frame` (= excl / game frames — compare
  with the frame budget), `incl ms`, `count`, `max incl` (`?` = shares a name with a GPU timer, unknown).
  - `[wait]` — the thread is blocked (WaitForTasks, GameThreadWaitForTask, …): the cost is on **another**
    thread or the GPU. Follow it, do not optimise the wait.
  - `[root: unscoped time inside]` — a wrapper (e.g. `Frame`) whose self time is code with no scope: add
    `-statnamedevents` or `TRACE_CPUPROFILER_EVENT_SCOPE` and capture again.
- **Bound by what**: GameThread busy with real timers while Render/RHI wait → game-thread bound; GameThread
  waits (`GameThreadWaitForTask`) while RenderThread works → render-thread bound; all CPU threads
  wait and GPU ms/frame ≥ frame time → GPU bound.
- **GPU table** sums every GPU queue (graphics + async compute + copy overlap), so its total can exceed 100 %
  of wall time; read relative order, and `ms/frame` of single passes.
- **Worst frames**: per thread, busy time and the 4 largest self times inside that frame — the hitch's cause
  is usually one timer far above its usual `ms/frame`.
- Numbers come from the trace as-is: an editor/PIE trace includes Slate, editor ticking and `WinPumpMessages`
  — rank game code against that noise or capture `-game` / packaged.

## Traps (from the engine source)

- Shipping: no trace at all (`UE_TRACE_ENABLED` is off). Test: trace on, the stat system off (`STATS` 0).
- PIE adds the editor's own frame work to every thread; numbers for decisions come from `-game` or a packaged
  Development build, with `-trace=default` only (extra channels cost time too).
- `-statnamedevents` changes timing; do not compare a trace with it against one without it.
- Memory channels must be on the command line from start-up; enabling later is refused.
- The export commands take the file name as an escaped token: a backslash inside quotes disappears. The script
  writes forward slashes; keep that if you write your own response file.
- `ExportTimerStatistics` always folds every GPU timeline into the table and ignores `-columns`/`-timers`;
  the script subtracts a GPU-only table to get one CPU thread. Details — `references/insights-export.md`.
- More exports (callees, counters, memory allocations) and the raw command forms — `references/insights-export.md`.
