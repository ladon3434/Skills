# PCG performance and debugging (UE 5.8)

Source root: `<engine>/Engine/Plugins/PCG/Source/PCG/` (`PCG/`). Profiling a whole game frame with Insights —
the `ue-perf` skill, if installed; PCG elements emit `TRACE_CPUPROFILER_EVENT_SCOPE` per node.

## 1. Execution budget and threads

| CVar | Default | Meaning |
|---|---|---|
| `pcg.FrameTime` | 5 ms | game-thread time per frame in game / PIE worlds |
| `pcg.EditorFrameTime` | 15 ms | same in editor worlds |
| `pcg.Runtime.MaxExecutingThreads` | 8 | hard cap of worker threads at runtime (`pcg.Editor.*` mirror for the editor) |
| `pcg.Runtime.MaxPercentageOfThreadsToUse` | 0.9 | |
| `pcg.GraphMultithreading` | true | several tasks at once |

Elements that `CanExecuteOnlyOnMainThread` (spawners, Blueprint nodes with `bRequiresGameThread`) eat the
game-thread budget — keep them at the end of the graph and fed with already filtered data.

## 2. Cache

- Cacheable nodes (see `IsCacheable`) store results keyed by a CRC of inputs + settings. **Enabled in editor
  worlds, disabled in game worlds by default**: `pcg.Cache.Editor.Enabled` = true, `pcg.Cache.Runtime.Enabled` =
  false; budgets `pcg.Cache.Editor.MemoryBudgetMB` 6144, `pcg.Cache.Runtime.MemoryBudgetMB` 128.
  So editor timings of a regeneration are not runtime timings — measure in PIE/standalone.
- `pcg.FlushCache` clears results and compiled graphs; `pcg.Cache.LogStats` prints stats.
- A node marked cacheable that reads untracked state returns stale results in the editor — the typical "changed
  X, PCG did not update" bug of custom nodes.

## 3. GPU execution

- Settings with an **Execute on GPU** toggle (`bExecuteOnGPU`, shown when `DisplayExecuteOnGPUSetting()`):
  Copy Points, Transform Points, Normal To Density, Cull Points Outside Actor Bounds, Attribute Partition, World
  Ray Hit Query, Static Mesh Spawner, Skinned Mesh Spawner, Data Num. **Custom HLSL** always runs on GPU
  (point/texture/attribute-set generator or processor, or custom kernel).
- Chains of GPU nodes compile into one compute graph. Each GPU→CPU boundary is a readback;
  `pcg.Graph.GPU.WarnOnGPUReadbacks` (editor) flags the nodes that cause one.
- **Cooked builds cannot compile compute graphs** — they use the compilation data cooked with the graph
  (`UPCGGraph::CookedCompilationData`). A graph that is not cooked (or changed after cook) has no GPU path.
- GPU Static Mesh Spawner → **procedural ISM** components: instance data lives on the GPU, is not saved, and is
  lost when the GPU scene is flushed — such components always regenerate (even GenerateOnLoad that was generated
  in the editor). `bSetupCullingCells` / `CullingCellSize` (experimental) split instances into CPU-cullable cells.
- `IsCacheable` is false for GPU-executed settings — the cache does not help GPU nodes.

## 4. Partition grid and instance counts

- Non-HiGen partitioned graphs: one local component and partition actor per `APCGWorldActor::PartitionGridSize`
  cell (default 25600 cm, min 400). Smaller cells — more actors, components, tasks and ISM components, cheaper
  single regenerations; larger — fewer, heavier executions. HiGen: put each part of the graph on the coarsest grid
  that still makes sense; data flows only from larger to smaller grids.
- **Static Mesh Spawner** merges all instances of the same descriptor into one ISM per target actor; disabling
  `bAllowMergeDifferentDataInSameInstancedComponents` multiplies components (the property says "Performance
  warning if set to false").
- **Spawn Actor** with `NoMerging` creates a real actor per point — fine for dozens of interactive actors, wrong
  for scatter. Use Static Mesh Spawner, or `CollapseActors` to turn an actor's meshes into instances.
- Filter before you spawn: density filter / self pruning / difference on points, not on spawned instances.

## 5. Runtime generation knobs

| CVar | Default | Meaning |
|---|---|---|
| `pcg.RuntimeGeneration.Enable` | true | master switch |
| `pcg.RuntimeGeneration.NumGeneratingComponents` | 16 | concurrent runtime components |
| `pcg.RuntimeGeneration.GlobalRadiusMultiplier` | 1.0 | scales every generation radius |
| `pcg.RuntimeGeneration.TimeBetweenRuntimeGenSchedulerTicks` | 0 | throttle scheduler ticks while idle |
| `pcg.RuntimeGeneration.FramesBeforeFirstGenerate` | 0 | delay after world start |
| `pcg.RuntimeGeneration.EnablePooling` / `BasePoolSize` | true / 100 | partition actor pool |
| `pcg.RuntimeGeneration.Server.Mode` | 2 | 0 off on servers, 1 local sources, 2 all |
| `pcg.Quality` | 2 | quality level for Runtime Quality Branch/Select and per-quality radii |

Radii are per grid size and per quality level (`FPCGRuntimeGenerationRadii`); the scheduler waits for World
Partition streaming before generating local components (`pcg.RuntimeGeneration.EnableWorldStreamingQueries`).

## 6. Debugging

- **Debug flag on a node** (`bDebug`, transient — never saved): draws the node's output points as meshes
  (`DebugSettings`: point mesh, scale method, material override). On graphs with
  `bDebugFlagAppliesToIndividualComponents` it follows the component chosen as debug object.
- **Inspect** a node in the graph editor: the attribute list view of its output (points, attributes, data domain).
  Inspection data is always collected in the editor; outside it only with profiling enabled
  (`PCG_PROFILING_ENABLED` = editor or non-Shipping).
- **Errors on nodes**: `PCGE_LOG(..., GraphAndLog, ...)` puts the message on the node and in `LogPCG`
  (`log LogPCG Verbose` for more). "Print String" node prints from inside a graph.
- **Runtime generation**: `pcg.RuntimeGeneration.EnableDebugOverlay` — on-screen stats (not in Shipping/Test);
  `pcg.RuntimeGeneration.EnableDebugging` — verbose log; `pcg.RuntimeGeneration.HideActorsFromOutliner` false
  to see pooled partition actors in PIE; `pcg.RuntimeGeneration.Refresh` regenerates everything.
- **Leaked actors**: generated actors carry the tag `PCG Generated Actor`, components `PCG Generated Component`;
  cleanup-pending ones `PCG Marked For Cleanup`. Search the outliner by tag.
- **Determinism**: regenerate with the same seed and compare `GetGeneratedGraphOutput()`; nodes expose
  editor-only "Determinism" settings (`FPCGDeterminismSettings`) for the editor's determinism tests.

## Verified at

- `PCG/Private/Graph/PCGGraphExecutor.cpp:51-90` runtime thread/time CVars, `:122-125` `pcg.EditorFrameTime` 15,
  `:1720-1726` per-world choice
- `PCG/Private/Graph/PCGGraphCache.cpp:14-37` cache enabled/budgets; `:66` `pcg.Cache.LogStats`;
  `PCG/Private/Subsystems/PCGSubsystem.cpp:49-51` `pcg.FlushCache`, `:60-61` `pcg.Quality`
- `PCG/Public/PCGSettings.h:648-665, 684-685` GPU toggle; `PCG/Private/PCGSettings.cpp:1161-1171` `ShouldExecuteOnGPU`;
  `PCG/Private/Compute/Elements/PCGCustomHLSL.cpp:41` always GPU; `PCG/Private/Compute/Elements/PCGCustomHLSL.h:21-32` kernel types
- `PCG/Public/PCGGraph.h:775-780` cooked compilation data "compiling compute graphs is not supported outside of editor";
  `PCG/Private/Graph/PCGGraphCompiler.cpp:96-98`
- `PCG/Private/Compute/Data/PCGProxyForGPUData.cpp:17-22` readback warning CVar (editor)
- `PCG/Private/PCGComponent.cpp:393-397, 1763-1764` procedural ISMs always regenerate
- `PCG/Public/Elements/PCGStaticMeshSpawner.h:118-120, 131-136`
- `PCG/Public/PCGWorldActor.h:59-63` grid size min 400; `PCG/Private/Graph/PCGGraphCompiler.cpp:663-664` grid direction
- `PCG/Private/RuntimeGen/PCGRuntimeGenScheduler.cpp:47` overlay not in Shipping/Test, `:57-145` CVars;
  `PCG/Private/RuntimeGen/PCGGenSourceManager.cpp:36-39`
- `PCG/Public/PCGSettings.h:235-236` `bDebug` transient; `PCG/Public/PCGDebug.h:26-46`;
  `PCG/Public/PCGGraph.h:765-769` debug flag per component; `PCG/Public/PCGSettings.h:494-495` determinism settings
- `PCG/Private/Graph/PCGGraphExecutor.cpp:1397, 1623` inspection data outside editor only with profiling;
  `PCG/Public/PCGCommon.h:972-977` `PCG_PROFILING_ENABLED`
- `PCG/Public/Elements/PCGPrintElement.h:56`; `PCG/Public/Helpers/PCGHelpers.h:35-38`
