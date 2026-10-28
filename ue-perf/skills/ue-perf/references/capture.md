# Capturing a trace — what the engine actually does (UE 5.8)

Every statement here is read from the engine source of 5.8.3 (`Engine/Source/...`). Paths below are relative to
`Engine/Source/`. Re-check them after an engine upgrade.

## Is trace compiled in

| Fact | Source |
| --- | --- |
| `UE_TRACE_ENABLED` = 1 only when `!UE_BUILD_SHIPPING && !IS_PROGRAM` (Windows/Unix/Apple/Android) | `Runtime/TraceLog/Public/Trace/Config.h:12-22` |
| Shipping tracing exists only as an opt-in experiment (`UE_TRACE_ENABLED_SHIPPING_EXPERIMENTAL`, default 0) | `Runtime/TraceLog/Public/Trace/Config.h:24-34` |
| CPU scopes (`TRACE_CPUPROFILER_EVENT_SCOPE`) need `UE_TRACE_ENABLED && !UE_BUILD_SHIPPING` | `Runtime/Core/Public/ProfilingDebugging/CpuProfilerTrace.h:19-25` |
| Test config: `ENABLE_STATNAMEDEVENTS` on, `STATS` off | `Runtime/Core/Public/Misc/Build.h:307-315` |

## Command line (read once at start-up)

`StartFromCommandlineArguments` — `Runtime/Core/Private/ProfilingDebugging/TraceAuxiliary.cpp:1946-2031`.

| Switch | Effect | Line |
| --- | --- | --- |
| `-trace=<channels>` | channels/presets to enable | 1952 |
| `-trace` (no value) | the `Default` preset | 1955-1958 |
| (editor, no switch) | the editor enables the `Default` preset anyway; with no connection it traces to memory only | 1959-1966 |
| `-tracefile=<path>` | write to a file; empty value → default name | 1987-1999 |
| `-tracefile` | write to a file with the default name | 2000-2004 |
| `-tracehost=<ip>` / `-tracehost` | send to a trace server (localhost if no value) | 1977-1986 |
| `-tracefiletrunc` | truncate an existing file | 1971 |
| `-tracefiletimestamps` | append `_YYYYMMDD_HHMMSS` to the file name | 1972, 1042-1047 |
| a connection given but no channels | the `Default` preset | 2007-2010 |
| `-statnamedevents` | `++GCycleStatsShouldEmitNamedEvents` | `Runtime/Launch/Private/LaunchEngineLoop.cpp:1759-1762` |
| `-verbosenamedevents` | the same + verbose named events | `Runtime/Launch/Private/LaunchEngineLoop.cpp:1764-1768` |

File path (`FinalizeFilePath`, `TraceAuxiliary.cpp:990-1050`): a relative path (or one starting with a single `/`
on Windows) goes under `FPaths::ProfilingDir()` = `<Project>/Saved/Profiling/` (`Runtime/Core/Private/Misc/Paths.cpp:548-551`);
a folder gets the default name `YYYYMMDD_HHMMSS_<ticks>.utrace` (`:999-1001`); a missing `.utrace` extension is
added (`:1036-1039`).

Auto-connect: when an Unreal Insights browser window is running (named event `Local\UnrealInsightsAutoConnect`),
a starting game connects to the local trace server with the `default` channels — that trace goes to the store,
not to `Saved/Profiling` (`TraceAuxiliary.cpp:2741-2770`). The store is
`%LOCALAPPDATA%\UnrealEngine\Common\UnrealTrace\Store\001\` on this machine.

## Presets and channels

| Preset | Channels | Read-only | Line |
| --- | --- | --- | --- |
| `Default` | `cpu,gpu,frame,log,bookmark,screenshot,region` | no | `TraceAuxiliary.cpp:138` |
| `Memory` | `memtag,memalloc,callstack,module` | yes | `:139` |
| `Memory_Light` | `memtag,memalloc` | yes | `:140` |
| your own | `[Trace.ChannelPresets]` in `DefaultEngine.ini` | — | `:405`, `:2698` |

Preset names are matched case-insensitively (`:389-401`, `FCString::Stricmp`). Read-only channels are frozen after
trace initialisation (`FreezeReadOnlyChannels`, `:2541`); enabling one later logs
"Channel '%s' is read only" and does nothing (`:467-475`). So memory tracing is command line only.

Other channels defined in Runtime (the channel name is the identifier without `Channel`): `task`
(`Core/Private/Async/TaskTrace.cpp:14`), `loadtime` (`Core/Private/Serialization/LoadTimeTrace.cpp:11`),
`assetloadtime`, `counters` (`Core/Private/ProfilingDebugging/CountersTrace.cpp:9`), `rhicommands`
(`RHI/Private/RHICommandList.cpp:37`), `rendercommands`, `net`, `animation`, `gpu` (`RHI/Private/GpuProfilerTrace.cpp:18`),
`cpu` (`Core/Private/ProfilingDebugging/CpuProfilerTrace.cpp:24`).

## Console commands

All in `TraceAuxiliary.cpp`, compiled when `UE_TRACEAUX_CON_CMDS` (= `UE_TRACE_ENABLED`, `:24`).

| Command | What | Line |
| --- | --- | --- |
| `Trace.File [Path] [ChannelSet]` | start tracing to a file; one argument is a path if it has `/ \ . :`, else channels | 1846; impl 1553-1588 |
| `Trace.Start [ChannelSet]` | deprecated alias of `Trace.File` | 1837, 1591-1595 |
| `Trace.Send <Host> [ChannelSet]` | trace to a server | 1827 |
| `Trace.Stop` | stop | 1856 |
| `Trace.Pause` / `Trace.Resume` | pause / resume the channels | 1863, 1870 |
| `Trace.Status` | print status | 1877 |
| `Trace.Enable` / `Trace.Disable [ChannelSet]` | toggle channels while tracing | 1884, 1893 |
| `Trace.SnapshotFile [Path]` | write the in-memory buffer to a file | 1903 |
| `Trace.Bookmark [Name]` | a bookmark | 1919 |
| `Trace.RegionBegin` / `Trace.RegionEnd [Name]` | a named region (→ `--region`) | 1927, 1935 |
| `stats.NamedEvents <on/off>` | named events at runtime | `Runtime/Core/Private/Misc/CoreMisc.cpp:548` |

`Trace.File` while already tracing fails: "Unable to start trace, already tracing to ..." (`:2051`) — stop first.

## Stat scopes vs CPU scopes

`SCOPE_CYCLE_COUNTER`, `QUICK_SCOPE_CYCLE_COUNTER`, `DECLARE_SCOPE_CYCLE_COUNTER` emit a CPU trace scope only when
`GCycleStatsShouldEmitNamedEvents` is non-zero (`Runtime/Core/Public/Stats/Stats.h:560-562`, `:584-586`).
`TRACE_CPUPROFILER_EVENT_SCOPE` does not depend on it. Hence `-statnamedevents` fills the gaps in the game thread,
and costs time per stat scope.
