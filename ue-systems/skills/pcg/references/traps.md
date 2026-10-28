# PCG traps (UE 5.8)

Each trap: symptom → cause → fix. Source root: `<engine>/Engine/Plugins/PCG/Source/PCG/` (`PCG/`).

## Works in the editor, not in the build

1. **Landscape sampling returns nothing in PIE / packaged** — error "PCG Landscape cache (on the PCG World Actor)
   is not set to be serialized and will not work in non-editor modes". The landscape cache defaults to
   `NeverSerialize`; outside the editor no entry is built and projection/sampling on the landscape fails.
   → On the `PCGWorldActor`, set the landscape cache `SerializationMode` to `SerializeOnlyAtCook` (saved into the
   cook) or `AlwaysSerialize`; or do not sample the landscape at runtime (bake in the editor).
2. **Graph missing in the cooked build** — `UPCGGraph::ShouldCook` (per platform) off: the graph, its compiled
   data and every component / graph instance referencing it are stripped from the cook.
3. **GPU nodes do nothing / fall over in the build** — cooked builds cannot compile compute graphs; they need the
   compilation data cooked with the graph. → Cook the graph (and recook after changing it).
4. **Editor-only nodes in a runtime graph** — they produce nothing or an error outside the editor: Get Editor
   Cameras, Get Data From Selection (warning, no data), Get Asset List (error), Save Texture To Asset (error); the
   nodes in `Elements/Editor` (Apply Spline To Component, Remove Actors From World, Teleport) are editor tooling.
   Generate Grass Maps is disabled in game worlds unless `grass.GrassMap.AlwaysBuildRuntimeGenerationResources`.
   → Keep them in editor-only graphs, or behind a branch that a runtime graph never takes.
5. **Density Filter keeps different points in the build** — `Keep Zero Density Points` is read only `WITH_EDITOR`;
   cooked builds always drop the rejected points. → Do not build logic on it; it is a debug view.
6. **"I changed a property / parameter at runtime and nothing regenerated"** —
   `NotifyPropertiesChangedFromBlueprint()` has an empty body outside the editor, and graph parameter change
   notifications are editor-only. → `GenerateLocal(/*bForce=*/true)` after the change.
7. **Runtime-dependent graph ignored in the game** — a GenerateOnLoad component generated and saved in the editor
   is `bGenerated` on load; `BeginPlay` skips it. Inputs set at runtime (seed, parameters, player data) never
   apply. → `GenerateOnDemand` + explicit `GenerateLocal(true)`, or `GenerateAtRuntime`.
8. **`Generate` on a runtime-generated component does nothing** — log "Generation request with trigger %d denied as
   this component is managed by the runtime generation scheduler". → Leave it to the scheduler (radii, sources).
9. **Runtime generation never starts** — no generation source: `bTreatPlayerControllersAsGenerationSources` is off
   on the PCG World Actor and nothing registered a `UPCGGenSourceComponent`; or the component is outside every
   source's generation radius; or `pcg.RuntimeGeneration.Enable 0`.

## Determinism

10. **Different result on every regenerate / between machines** — `FMath::Rand`, `FRandomStream` seeded with time,
    iteration order of `TMap`/`TSet`, order of async completion, reading the world state at generation time.
    → Seed from `Context->GetSeed()` combined with the point `Seed` (`PCGHelpers::ComputeSeed`), sort before
    order-dependent work.
11. **All instances of my custom node roll the same numbers** — the settings class does not override
    `UseSeed()`, so `GetSeed()` returns the bare constant 42 for every node of that class — not combined with the
    component seed, so changing the component `Seed` changes nothing either. → `UseSeed() { return true; }`.
12. **Two volumes produce identical scatter** — both components keep the default `Seed` 42 and identical inputs.
    → Distinct component seeds (or seed from location upstream with "Mutate Seed").

## Cleanup and resources

13. **Spawned actors survive cleanup / pile up on regenerate** — created by a custom node, a Blueprint node or a
    post-spawn function without being registered as managed resources. → `UPCGManagedActors` /
    `UPCGManagedComponent` via `AddToManagedResources` (C++) or `AddActorsToManagedResources` /
    `AddComponentsToManagedResources` (Blueprint). Recovery: `CleanupLocalDeleteAllGeneratedObjects` purges
    everything tagged `PCG Generated Actor` / `PCG Generated Component` that nobody manages.
14. **`ClearPCGLink` / stamping** — moves resources to a new actor and cuts them loose: no later cleanup by PCG.
15. **Empty generated components stay after cleanup** — `CleanupLocal(false)` soft-releases the resources (kept for
    reuse; what the next generation does not reuse is deleted at its end). `CleanupLocal(true)` hard-releases now.
16. **Nested PCG on spawned actors does not run** — Spawn Actor with `GenerationTrigger = Default` generates
    their PCG components only if those are GenerateOnLoad. → `ForceGenerate` or set their trigger.

## Custom C++ node

17. **Stale results after changing external data** — `IsCacheable` returns true (the default) while the node reads
    state PCG does not track. In the editor the cache returns the old output. → Return false, or make the external
    data an input pin.
18. **Crash / corrupt data in a custom node** — writing through a value range taken before `SetNumPoints` /
    `AllocateProperties` (they invalidate ranges); `NewObject` from a worker thread instead of
    `FPCGContext::NewObject_AnyThread`; mutating input data (`FPCGTaggedData::Data` is `const` — inputs are shared
    and may be cached).
19. **World access from a worker thread** — spawning or touching actors in `ExecuteInternal` without
    `CanExecuteOnlyOnMainThread` returning true.
20. **Several output pins, data lands nowhere** — output tagged data with a label that is not an output pin:
    error "Output data generated for non-existent output pin". Only single-output nodes are relabelled for you.

## Network

21. **Clients do not see generated content** — `Generate`/`Cleanup`/`SetGraph` are NetMulticast, but the
    component is not replicated by default; the call runs on the server only. → Replicate the actor and the
    component, or call the `...Local` variant on each client (content generated locally is not replicated).
22. **Dedicated server spends time on visual scatter** — `pcg.RuntimeGeneration.Server.Mode` defaults to 2 (all
    sources) and the default scheduling policy's `NetworkMode` is `All`. → Set the policy's `NetworkMode` to
    `Client` for visual-only components; keep gameplay-relevant (collision) content on the server.

## Verified at

- `PCG/Private/Grid/PCGLandscapeCache.cpp:884-892` no cache entry outside the editor when `NeverSerialize`;
  `PCG/Public/Grid/PCGLandscapeCache.h:25-30, 160-161` modes and default; `PCG/Private/Utils/PCGLogErrors.cpp:212` message;
  `PCG/Private/Data/PCGLandscapeData.cpp:346-351` projection fails without an entry
- `PCG/Public/PCGGraph.h:752-762` `ShouldCook`; `:775-780`, `PCG/Private/Graph/PCGGraphCompiler.cpp:96-98` cooked compute graphs
- `PCG/Private/Elements/Editor/PCGGetEditorCameras.cpp:189-190`; `PCG/Private/Elements/Editor/PCGGetEditorSelection.cpp:86-87`;
  `PCG/Private/Elements/IO/PCGGetAssetList.cpp:132-133`; `PCG/Private/Elements/PCGSaveTextureToAsset.cpp:272`;
  `PCG/Private/Elements/PCGGenerateLandscapeTextures.cpp:635-638`
- `PCG/Private/Elements/PCGDensityFilter.cpp:33-37`
- `PCG/Private/PCGComponent.cpp:1188-1194` notify no-op; `PCG/Private/PCGGraph.cpp:3173-3175`
- `PCG/Private/PCGComponent.cpp:1763-1771` BeginPlay; `:373-383` runtime denial message
- `PCG/Public/PCGWorldActor.h:80-82`; `PCG/Private/RuntimeGen/PCGRuntimeGenScheduler.cpp:57-60`
- `PCG/Private/PCGSettings.cpp:723-726`; `PCG/Public/PCGCommon.h:336`; `PCG/Public/PCGComponent.h:314`
- `PCG/Public/PCGComponent.h:196-207, 242-243, 266-271`; `PCG/Public/Helpers/PCGHelpers.h:35-38`;
  `PCG/Private/PCGManagedResource.cpp:238-251`; `PCG/Private/PCGManagedResource.cpp:602-626` component soft/hard release;
  `PCG/Private/PCGComponent.cpp:1646` → `PCG/Private/PCGManagedResourceContainer.cpp:148-170` `bRemoveComponents` = hard release
- `PCG/Public/Elements/PCGSpawnActor.h:24-31`
- `PCG/Public/PCGElement.h:151-157`; `PCG/Private/PCGElement.cpp:1325-1328, 1223-1228`;
  `PCG/Public/Data/PCGBasePointData.h:129-131`; `PCG/Public/PCGContext.h:330-345`; `PCG/Public/PCGData.h:199-201`
- `PCG/Public/PCGComponent.h:252-257`; `PCG/Private/PCGComponent.cpp:112-127`;
  `PCG/Private/RuntimeGen/PCGGenSourceManager.cpp:36-39`;
  `PCG/Public/RuntimeGen/SchedulingPolicies/PCGSchedulingPolicyDistanceAndDirection.h:12-17, 65-66`
