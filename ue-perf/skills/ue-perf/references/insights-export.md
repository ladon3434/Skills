# Headless Insights export — the commands `ue-trace` relies on (UE 5.8)

Paths are relative to `Engine/Source/`. The `Programs/UnrealInsights` sources (the program's own command-line parsing)
are not in a launcher install; the switches below are grounded in Epic's functional tests that launch Insights
the same way, in the modules that act on them, and in the strings of the shipped `UnrealInsights.exe` 5.8.3
(it contains `OpenTraceFile`, `ExecOnAnalysisCompleteCmd`, `NoUI`, `AutoQuit`).

## Launch

```
UnrealInsights.exe -OpenTraceFile="<trace>" -ABSLOG="<log>" -AutoQuit -NoUI -ExecOnAnalysisCompleteCmd="<cmd>" -log
UnrealInsights.exe ... -ExecOnAnalysisCompleteCmd="@=<response file>"
```

| Fact | Source |
| --- | --- |
| The exact switch set, one export command | `Developer/TraceInsights/Private/Insights/Tests/FunctionalTests/ExportCommandsTests.cpp:86`, `:117`, `:148`, `:179` |
| `@=<file>` runs a response file | same file `:234` |
| The command is stored, quotes trimmed | `Developer/TraceInsights/Private/Insights/TraceInsightsModule.cpp:598-613`; `InsightsManager.cpp:1039-1042` |
| Executed when the session analysis completes, then AutoQuit exits | `Developer/TraceInsights/Private/Insights/InsightsManager.cpp:1046-1074` |
| `@=` dispatch | `InsightsManager.cpp:1089-1098` |
| Response file: one command per line, `#` lines skipped, CR/LF either | `InsightsManager.cpp:1104-1168` |
| `-NoUI` is a real option of the Insights launcher UI | `Developer/TraceInsightsFrontend/Private/InsightsFrontend/Widgets/SConnectionWindow.cpp:270`, `:611` |

The log written with `-ABSLOG` carries `Executing commands on analysis completed...` and one
`Exported ... to file` / `Exported timing statistics to file` line per command; failures say
`Failed to export ...`, `Cannot write the export file`, `Unable to find any region`. The script greps these.

## Export commands (`FTimingProfilerManager::Exec`, `Developer/TraceInsights/Private/Insights/TimingProfiler/TimingProfilerManager.cpp`)

| Command | Options | Line |
| --- | --- | --- |
| `TimingInsights.ExportThreads <file>` | — | 753 |
| `TimingInsights.ExportTimers <file>` | — | 769 |
| `TimingInsights.ExportTimingEvents <file>` | `-columns= -threads= -timers= -startTime= -endTime= -region=` | 802-900 |
| `TimingInsights.ExportTimerStatistics <file>` | the same + `-maxTimerCount= -sortBy=TotalInclusiveTime -sortOrder=Descending\|Ascending` | 903-1060 |
| `TimingInsights.ExportTimerCallees <file>` | `-threads= -timers= -startTime= -endTime= -region=` | 1063-1162 |
| `TimingInsights.ExportCounters <file>` | — | 1165 |
| `TimingInsights.ExportCounterValues <file>` | `-counter= -columns= -startTime= -endTime= -region=` | 1175 |
| `MemoryInsights.ExportAllocs ...` | memory allocations (needs a `memory` trace) | `MemoryProfiler/MemoryProfilerManager.cpp:450` |

Parsing traps:
- The file name is `FParse::Token(Cmd, bUseEscape = true)` (`TimingProfilerManager.cpp:818`): inside quotes a
  backslash is an escape and is dropped (`Runtime/Core/Private/Misc/Parse.cpp:945-958`). Use forward slashes.
- `-threads="A,B"` — comma list, `*`/`?` wildcards; names include pseudo-threads `GPU`, `GPU1`, `GPU2`, each GPU
  queue (`GPU0-Graphics0`, ...), `VerseSampling`, `Game Frames`, `Rendering Frames` (`TimingExporter.cpp:1200-1286`).
  A pattern that matches nothing gives a filter that rejects every thread (`:1290-1297`).
- `.csv` → comma-separated, anything else → tab-separated (`TimingExporter.cpp:98`, `:716`).
- `-region=` exports one file per region; the file name must contain `{region}`; a name repeated in the trace gets
  `_<n>` per interval, at most 100 intervals per region (`TimingExporter.cpp:808-868`).
- `{region}` or `*` in a file name without `-region` is an error (`:957-961`).

## CSV formats

**ExportTimingEvents** — columns `ThreadId,ThreadName,TimerId,TimerName,StartTime,EndTime,Duration,Depth`
(`TimingExporter.cpp:326-333`), default set `ThreadId,TimerId,StartTime,EndTime,Depth` (`:337-356`). Times in
seconds of session time, `%.9g` timestamps and `%.9f` durations (`Insights/Common/Utf8FileWriter.cpp:182-220`).
Events are written per timeline, parents before children (`TimingExporter.cpp:412-650`). Frame tracks export one
row per frame: `TimerName` = `Game Frame <n>` / `Rendering Frame <n>`, `Depth` 1
(`:505-555`; names `TimingProfiler/ViewModels/FrameTimingTrack.cpp:582-598`, `FrameTrackHelper.cpp:124-131`).

**ExportTimerStatistics** — written by `TraceServices::Table2Csv` (`Developer/TraceServices/Private/Common/Utils.cpp:18-80`):
header `Name,Count,C.Avg,Incl,I.Min,I.Max,I.Avg,I.Med,Excl,E.Min,E.Max,E.Avg,E.Med`
(`Developer/TraceServices/Private/Model/TimingProfiler.cpp:38-53`), values `%f` (seconds, 6 decimals), commas in
names replaced by spaces (`Utils.cpp:65`). The aggregation always includes both old GPU timelines and every GPU
queue (`TimingExporter.cpp:977-979`), only the CPU threads follow `-threads`, and `-columns`/`-timers` are ignored
(`:985`). `ue-trace` therefore exports a GPU-only table (`-threads=` a name that matches nothing) and subtracts it.

## What `ue-trace analyze` runs

Pass 1 (`pass1.rsp` in the CSV folder):
```
TimingInsights.ExportThreads "<dir>/threads.csv"
TimingInsights.ExportTimingEvents "<dir>/frames.csv" -threads="Game Frames,Rendering Frames" -columns=ThreadName,TimerName,StartTime,EndTime,Duration [-startTime= -endTime=]
TimingInsights.ExportTimerStatistics "<dir>/stats_gpu.csv" -threads=__ue_trace_no_cpu_thread__ [window]
TimingInsights.ExportTimerStatistics "<dir>/stats_t<i>.csv" -threads="<pattern i>" [window]
[TimingInsights.ExportTimerStatistics "<dir>/region_gpu_{region}.csv" ... -region="<pattern>"; region_t<i>_{region}.csv per thread]
```
Pass 2 (`pass2.rsp`), one line per worst game frame:
```
TimingInsights.ExportTimingEvents "<dir>/worst_<k>.csv" -threads="<patterns>" -columns=ThreadName,TimerName,StartTime,EndTime,Depth -startTime=<frame start> -endTime=<frame end>
```
Exclusive time inside a frame is computed from the events: each event clamped to the frame, minus its clamped
children (found by `Depth`). Verified on 5.8.3 traces of 42 MB (≈ 7 s both passes) and 687 MB (≈ 42 s).
