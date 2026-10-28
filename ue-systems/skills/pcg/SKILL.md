---
name: pcg
description: >
  Procedural Content Generation (PCG) framework in Unreal Engine 5.8: PCG component, graphs, graph instances and
  parameters, point/spatial data and attributes, node families (samplers, filters, static mesh and actor spawners,
  attribute ops, subgraphs, loops), generation triggers (on load, on demand, runtime generation scheduler),
  partitioned and hierarchical generation, seeds and determinism, cleanup; custom C++ nodes (UPCGSettings +
  IPCGElement), Blueprint nodes, driving generation from C++; GPU nodes, cache, grid sizes, debugging; review
  checklist and traps verified against the engine source. Use for "PCG", "procedural generation", "PCG graph",
  "custom PCG node", "scatter foliage procedurally", "PCG does not generate in the build", "spawned actors are not
  cleaned up", "runtime generation". Russian: «PCG», «процедурная генерация», «граф PCG», «расставь процедурно»,
  «кастомная нода PCG», «PCG не генерирует в билде».
---

# pcg — Procedural Content Generation

Paths are relative to the skill folder (`<skill>`). Engine source: `<engine>/Engine/Plugins/PCG/Source/PCG/`
(engine root from the `.uproject` `EngineAssociation`). Written against 5.8; the API moves every release (5.6 point
data → `UPCGBasePointData` value ranges, 5.7 pin types → `FPCGDataTypeIdentifier`) — on another version check
the header before trusting a signature. Every reference ends with a "Verified at" list (`file:line`).

| Need | Read |
|---|---|
| Component, graph, data, node families, triggers, partition/HiGen, runtime generation, seeds, cleanup | `references/concepts.md` |
| Custom C++ node, Blueprint node, calling generation from C++ | `references/cpp.md` |
| Budget, cache, GPU, grid sizes, instance counts, debug tools | `references/performance-debugging.md` |
| "Works in the editor, not in the build", determinism, leaks, network | `references/traps.md` |

## First of all

- Plugin `PCG` (5.8: `EnabledByDefault`), C++ — `PCG` in `Build.cs`. Related engine plugins: `Plugins/PCGInterops/`
  (GeometryScript, ExternalData, Python), `Plugins/Experimental/PCGInterops/` (Water, Niagara, FastGeo …),
  `Plugins/Experimental/PCGBiomeCore` — check which the project enables before using their nodes.
- **When does it generate?** Baked in the editor (GenerateOnLoad, saved with the level), on demand from code,
  or at runtime around the player (GenerateAtRuntime). This one answer decides half the design; ask if unclear.
- **Single-player or networked?** Generation is local per machine; replication of the calls is opt-in.

## The model in ten lines

1. `UPCGComponent` (on any actor, or `APCGVolume`) runs one `UPCGGraph` through its `UPCGGraphInstance`
   (parameter overrides live on the instance).
2. Nodes are `UPCGSettings` (data, serialized) + `IPCGElement` (stateless code, any thread).
3. Edges carry `FPCGDataCollection`: points, spatial data (landscape, spline, volume, texture, primitive …),
   attribute sets; every data has metadata (attributes) and tags.
4. Typical chain: input → sampler → filters/attribute ops → spawner. Spawners write managed resources.
5. Trigger: `GenerateOnLoad` (default; skipped at BeginPlay if already generated), `GenerateOnDemand`,
   `GenerateAtRuntime` (only the Runtime Generation Scheduler may generate it).
6. Partitioned = split into grid cells (local components on partition actors); HiGen = graph parts on different
   grid sizes, data only from coarse to fine.
7. Randomness = component `Seed` × node `Seed` × point `Seed` — deterministic by construction.
8. Regenerate = soft-release old resources, generate, delete what was not reused; cleanup removes managed
   resources only.
9. Cache (editor on, runtime off by default) skips cacheable nodes with unchanged inputs.
10. GPU-capable nodes compile into compute graphs; cooked builds use the compute graphs cooked with the graph.

## Modes

### 1. Design a graph / set up generation
1. Choose the trigger and partitioning (`concepts.md` §4–6). Big worlds: partitioned; layered content: HiGen;
   streaming open worlds with content around the player: GenerateAtRuntime.
2. Sample → filter → spawn; filter points, not spawned objects. Static Mesh Spawner for scatter, Spawn Actor
   only for things that must be actors.
3. Expose tunables as graph parameters, vary per placement with graph instances.
4. Runtime-generated or game-built content: walk the "Works in the editor, not in the build" section of `traps.md`.

### 2. Write a custom node
`references/cpp.md`: settings + element skeleton, pins, output routing, seeds, `IsCacheable`, main thread,
managed resources. C++ for per-point work and runtime graphs; Blueprint (`UPCGBlueprintBaseElement`) for
prototypes and game-thread logic.

### 3. Drive generation from code
`cpp.md` "Driving generation": `GenerateOnDemand` + `GenerateLocal(true)`, seed and parameters before the call,
result in `OnPCGGraphGeneratedDelegate`, `CleanupLocal(true)` to remove.

### 4. Review (graph setup or C++) — report `file:line` / `asset: node — problem → fix`

- [ ] The trigger matches the intent: runtime-dependent inputs are not on a GenerateOnLoad component baked in the
      editor; nothing calls `Generate*` on a GenerateAtRuntime component.
- [ ] No `FMath::Rand`, time-based seeds, `TMap`/`TSet` iteration order or async completion order in generation;
      randomness comes from `Context->GetSeed()` + point seed; custom settings override `UseSeed()`.
- [ ] Distinct component seeds where placements must differ.
- [ ] Runtime graphs contain no editor-only nodes (Get Editor Cameras, Get Data From Selection, Get Asset List,
      Save Texture To Asset, `Elements/Editor` nodes) and do not rely on Density Filter "Keep Zero Density Points".
- [ ] Runtime landscape sampling: the PCG World Actor's landscape cache is serialized (not `NeverSerialize`).
- [ ] Graphs used in game have `ShouldCook` on for the target platforms; GPU graphs are recooked after changes.
- [ ] After runtime property/parameter changes the code regenerates explicitly (`GenerateLocal(true)`), not via
      `NotifyPropertiesChangedFromBlueprint` (no-op outside the editor).
- [ ] Everything a custom/Blueprint node spawns is a managed resource; nothing is left on cleanup.
- [ ] Custom element: stateless; settings read via `GetInputSettings`; `NewObject_AnyThread`/`NewPointData_AnyThread`;
      value ranges taken after `SetNumPoints`/`AllocateProperties`; world access only with
      `CanExecuteOnlyOnMainThread`; `IsCacheable` false when it creates artifacts or reads untracked data;
      outputs on existing pin labels; errors via `PCGE_LOG(..., GraphAndLog, ...)`.
- [ ] Spawners: Static Mesh Spawner for mass content; Spawn Actor `NoMerging` only for few interactive actors;
      instance merging not disabled without a reason.
- [ ] Partition grid / HiGen sizes chosen for the content density, not left by accident.
- [ ] Networked game: who generates (server, clients, both) is decided; NetMulticast calls only on replicated
      components; visual-only runtime content not generated on a dedicated server (`NetworkMode`).

### 5. Diagnose
"Does not generate / generates differently / leaks / slow" — the symptom index in `references/traps.md`, then
the debug tools in `performance-debugging.md` §6. Don't guess: when the reference is silent, read the node's
settings header and element `.cpp` under `Source/PCG/Private/Elements/`.

## Debugging in one breath
Node **Debug** flag (draws output points), **Inspect** (attribute list of a node's output), errors on nodes and in
`LogPCG`, Print String node, `pcg.RuntimeGeneration.EnableDebugOverlay` (non-Shipping), `pcg.FlushCache`,
`pcg.RuntimeGeneration.Refresh`, outliner search by tag `PCG Generated Actor`.
