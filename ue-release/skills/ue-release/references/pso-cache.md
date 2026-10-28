# Bundled PSO cache in UE 5.8 — how it really works

Everything below was read from the UE 5.8 source; file and line names are given so it can be re-checked after an
engine upgrade.

## Files and where they live

| What | Where | Written by |
| --- | --- | --- |
| Stable shader keys | `Saved/Cooked/<Platform>/<Project>/Metadata/PipelineCaches/ShaderStableInfo-<Project>-<SF>.shk` | the cook (`ShaderCodeLibraryUtilities.cpp`, `GetStableInfoArchiveFilename`; metadata dir = `<Project>/Metadata` in the cook sandbox) |
| Recorded PSOs | `<running game>/Saved/CollectedPSOs/<Branch>-CL-<n>-<Project>_<SF>_<guid>.rec.upipelinecache` | the game started with `-logPSO` or `r.ShaderPipelineCache.LogPSO=1` (`PipelineFileCache.cpp`) |
| Stable cache (source) | `Build/<Platform>/PipelineCaches/*<Project>_<SF>.spc` (or `.stablepc.csv[.compressed]`, deprecated) | `ShaderPipelineCacheTools Expand` |
| Bundled cache (cooked) | `Content/PipelineCaches/<Platform>/<Project>_<SF>.stable.upipelinecache` inside the cooked output | the cook, from the stable cache (`ShaderLibraryCooking.cpp`, `CreatePipelineCache`) |

`<Project>` is the shader library name = the project name (`GetProjectShaderLibraryName`, overridable with
`-OverrideShaderLibraryName=`). `<SF>` is the shader format, e.g. `PCD3D_SM6`, `PCD3D_SM5`, `SF_VULKAN_SM6` — the
project's `D3D12TargetedShaderFormats` etc. in `DefaultEngine.ini`.

The cooker globs `Build/<Platform>/PipelineCaches/*<Project>_<SF>.spc` and `*.stablepc.csv[.compressed]`. A
`.upipelinecache` found uncooked under `Content/PipelineCaches/<Platform>/` is deleted with "cooked data doesn't
belong here". Older guides that put a `.csv` into `Content/PipelineCaches` describe UE4.

## Commandlet

```
UnrealEditor-Cmd <Project>.uproject -run=ShaderPipelineCacheTools Expand <recs...> <shks...> <Output.spc>
```

Other verbs: `Build` (stable → binary `.upipelinecache`, done by the cook), `Dump`, `Diff`, `Decompress`.
Writing `.stablepc.csv` still works and logs "Using a deprecated stablepc format". `pso-cache.cmd expand` builds
this line for one shader format and writes `.spc`.

## Recording

- Record in a **packaged** build made from the same cook as the `.shk` files — keys from another cook do not
  match the recorded hashes, and expand reports "No stable PSOs created".
- The pipeline file cache is on by default outside the editor (`PIPELINE_CACHE_DEFAULT_ENABLED (!WITH_EDITOR)`);
  `-logPSO` turns recording on. Development builds are fine for recording.
- Play everything: every map, UI screen, weapon, effect, quality level that ships. A PSO never seen is not in the
  cache.
- One recorder at a time per output folder; merge several runs by passing all their `.rec` files to one expand.
- Re-record after material/shader changes that matter; `pso-cache.cmd status` flags recordings newer than the
  shipped cache.

## Runtime knobs that exist in 5.8

| CVar | Default | Meaning |
| --- | --- | --- |
| `r.ShaderPipelineCache.Enabled` | 1 in game builds | load and precompile the bundled cache |
| `r.ShaderPipelineCache.StartupMode` | 1 | 0 paused until `ResumeBatching()`, 1 fast, 2 background |
| `r.ShaderPipelineCache.BatchTime` / `BackgroundBatchTime` | engine defaults | ms per frame spent compiling in fast / background mode |
| `r.ShaderPipelineCache.LogPSO` | 0 | record (same as `-logPSO`) |
| `r.ShaderPipelineCache.ExcludePrecachePSO` | 0 | 1 = do not record PSOs PSO precaching already handled (smaller cache) |
| `r.PSOPrecaching` | 1 | runtime PSO precaching, the 5.x mechanism; works with or without a bundled cache |

`r.ShaderPipelineCache.ReportMissingShaders` and `r.ShaderPipelineCache.PrecompileBoundShaderStates` do not exist
in 5.8 — setting them does nothing.

A common setup: precaching on, `ExcludePrecachePSO=1` while recording, a bundled cache for the rest, and a
loading screen held until the batch finishes (`FShaderPipelineCache::NumPrecompilesRemaining()`).
