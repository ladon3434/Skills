# PCG concepts (UE 5.8)

Source root below: `<engine>/Engine/Plugins/PCG/Source/PCG/` (abbreviated `PCG/`). Line references are in
"Verified at" at the end.

## 1. Component, graph, instance, parameters

- **`UPCGComponent`** — an actor component that owns one graph execution: it holds a `UPCGGraphInstance`
  (created as a default subobject), a `Seed` (default 42), `bActivated`, `bIsComponentPartitioned`,
  `GenerationTrigger`, and the list of **managed resources** (what generation created, so cleanup can remove it).
  `APCGVolume` is a volume actor with this component as a default subobject.
- **`UPCGGraph`** — the asset: nodes (`UPCGNode`) whose behaviour is a `UPCGSettings` object; the settings create
  the element (`IPCGElement`) that runs. **`UPCGGraphInstance`** — a graph plus overridden parameters;
  `UPCGComponent::GetGraph()` returns the asset at the top of the instance hierarchy, parameters go on
  `GetGraphInstance()`.
- **Graph parameters** — `UPCGGraph::UserParameters`, an `FInstancedPropertyBag`. From C++:
  `GetGraphInstance()->SetGraphParameter<T>(Name, Value)` / `GetGraphParameter<T>`; from Blueprint —
  `UPCGGraphParametersHelpers`. Inside the graph — the "Get Graph Parameter" node (`PCGUserParameterGet`).
  Outside the editor, changing a parameter notifies nobody (the notification is `WITH_EDITOR`) — regenerate yourself.
- **Subgraph** (`UPCGSubgraphSettings`) — another graph as a node; overriding `SubgraphOverride` through its pin
  makes it a dynamic subgraph (not inlined into the parent at compile time). **Loop** (`UPCGLoopSettings`, title "Loop") — a subgraph
  executed once per data on the loop pins; feedback pins pass the previous iteration's output. Pin usage
  (`Normal`/`Loop`/`Feedback`) comes from the subgraph's input pins unless `bUseGraphDefaultPinUsage` is off.
- **Overridable settings** — a `UPROPERTY` with `meta = (PCG_Overridable)` gets an override pin fed by an
  attribute set.

## 2. Data

Everything that flows on an edge is a `FPCGDataCollection` of `FPCGTaggedData` (data + tags + pin label).
Pin types are `EPCGDataType` flags (5.7+ wraps them in `FPCGDataTypeIdentifier`, constructible from the enum):

| Type | Classes | Notes |
|---|---|---|
| Point | `UPCGBasePointData` → `UPCGPointArrayData` (SoA, default) / `UPCGPointData` (legacy AoS) | `FPCGContext::NewPointData_AnyThread` picks the class by `pcg.EnablePointArrayData` |
| Spatial | `UPCGSpatialData` subclasses: Spline, LandscapeSpline, Polygon2D (= "Curve"), Landscape, Texture, RenderTarget, VirtualTexture, Volume, Primitive, DynamicMesh; Composite = union/intersection/difference | `ToBasePointData(Context)` samples any spatial data into points |
| Attribute Set | `UPCGParamData` (`Param`) | metadata without spatial meaning: parameters, tables |
| Other | StaticMeshResource, ProxyForGPU (GPU-resident, hidden) | |

- A **point** = transform, density, bounds min/max, color, steepness, **seed**, metadata entry. In 5.6+ access is
  by value ranges: `GetConstTransformValueRange()`, `GetDensityValueRange()` etc., or `FConstPCGPointValueRanges`.
  `SetNumPoints` / `AllocateProperties` invalidate ranges — take ranges after them.
- **Metadata / attributes** — typed columns (`UPCGMetadata`) on the data; points refer to rows by metadata entry.
  Selectors: `$` prefixes a point property (`$Position`, `$Density`, `$Seed`), a bare name is an attribute, `@`
  prefixes a metadata domain (point data has `Data` and `Elements`, e.g. `@Data.MyAttr`).

## 3. Node families (titles as in the palette)

| Family | Nodes |
|---|---|
| Input | Get Actor Data, Get Landscape Data, Get Spline Data, Get Volume Data, Get Primitive Data, Get Texture Data, Get Graph Parameter |
| Samplers | Surface Sampler, Volume Sampler, Spline Sampler, (Get Texture Data samples a texture as a surface) |
| Spatial ops | Projection, Difference, Union, Inner Intersection, World Ray Hit Query, World Volumetric Query, Distance |
| Filters | Density Filter, Filter Attribute Elements (by value / by range), Filter Data By Tag, Filter By Type, Self Pruning |
| Point ops | Transform Points, Copy Points, Bounds Modifier, Merge Points, Point Match And Set |
| Attributes | Create Attribute, Attribute Noise, Attribute Remap, Attribute Partition, metadata maths/boolean/compare/vector/rotator/transform/string ops |
| Spawners | Static Mesh Spawner, Spawn Actor, Spawn Spline Mesh, Skinned Mesh Spawner |
| Structure | Subgraph, Loop, Branch, Select, Switch, Runtime Quality Branch/Select (`pcg.Quality`), Platform Switch, HiGen Grid Size |
| Custom | Execute Blueprint (a `UPCGBlueprintBaseElement` subclass), Custom HLSL (GPU) |

**Static Mesh Spawner** — a mesh selector (`MeshSelectorType`: weighted, by attribute, weighted by category),
an instance data packer (per-instance custom data from attributes), writes ISM/HISM components onto the target
actor; `bAllowDescriptorChanges` lets PCG swap HISM for ISM for Nanite meshes. Instances from different data merge
into the same ISM by default (`bAllowMergeDifferentDataInSameInstancedComponents`).

**Spawn Actor** — `Option`: `CollapseActors` (extracts the actor's meshes into instances), `MergePCGOnly` (spawns,
merges the actors' own PCG graphs into one execution), `NoMerging` (one actor per point; the default for new
nodes). `GenerationTrigger` decides whether PCG components on spawned actors generate (`Default` = only if their
trigger is GenerateOnLoad; `ForceGenerate`; `DoNotGenerateInEditor`; `DoNotGenerate`). `bSpawnByAttribute` picks
the class per point.

## 4. When generation runs — `EPCGComponentGenerationTrigger`

| Trigger | Runs | Notes |
|---|---|---|
| `GenerateOnLoad` (default) | in the editor on drop / change; at `BeginPlay` **only if not already generated** | generated + saved in the editor = baked into the level; the game does not rerun it |
| `GenerateOnDemand` | only when called (`Generate`, `GenerateLocal`) | `bGenerateOnDropWhenTriggerOnDemand` for editor convenience |
| `GenerateAtRuntime` | when the **Runtime Generation Scheduler** decides (distance to generation sources) | every other request is denied with a warning |

`ShouldGenerate`: no graph, not activated or no subsystem → nothing. Otherwise it generates if not generated yet
(and the request is valid for the trigger), or `bForce`. A component whose graph uses procedural ISMs (GPU static
mesh spawner) always regenerates — the instance data is not persistent.

Editing mode (editor): `Normal` saves the generated resources with the level; `Preview` never dirties and never
saves them; `LoadAsPreview` behaves as Normal until the next load. A GenerateAtRuntime component behaves as Preview.

## 5. Partitioned and hierarchical generation

- **Partitioned** (`bIsComponentPartitioned`) — the original component dispatches generation to local components
  on `APCGPartitionActor`s, one per grid cell. Grid size: `APCGWorldActor::PartitionGridSize` (default 25600 cm),
  unless the graph uses hierarchical generation.
- **Hierarchical generation (HiGen)** — `UPCGGraph::bUseHierarchicalGeneration`, `HiGenGridSize` (default 256 =
  25600 cm), `HiGenGridSizeMultiplier`, `bUse2DGrid`. "HiGen Grid Size" nodes put parts of the graph on coarser or
  finer grids (400 … 204800 cm). A task runs on the smallest grid of its inputs: data can come from a larger grid,
  never from a finer one. Use it for a big-to-small chain: roads and clearings on a coarse grid, grass on a fine one.

## 6. Runtime generation (GenerateAtRuntime)

- The scheduler (`FPCGRuntimeGenScheduler`, owned by `UPCGSubsystem`) ticks, finds components within the
  generation radius of a **generation source** and generates them, nearest/most-in-view first (scheduling policy
  `UPCGSchedulingPolicyDistanceAndDirection`: distance, direction, optional frustum culling, `NetworkMode`).
  Out of the cleanup radius → cleaned up. Partition actors are pooled (`pcg.RuntimeGeneration.EnablePooling`,
  `BasePoolSize` 100).
- Generation sources: every player controller if `APCGWorldActor::bTreatPlayerControllersAsGenerationSources`
  (default true); add `UPCGGenSourceComponent` ("PCG Generation Source") for anything else; the editor viewport
  if `bTreatEditorViewportAsGenerationSource`.
- Radii: `FPCGRuntimeGenerationRadii` per grid size, per quality level; default generation radius = 2× grid size,
  cleanup = 1.1× generation radius. Override per component with `bOverrideGenerationRadii`.
- Servers: `pcg.RuntimeGeneration.Server.Mode` (0 off, 1 local sources only — listen server, 2 all; default 2).
- Partitioned runtime components spawn their partition actors at runtime with `RF_Transient` — nothing is baked.

## 7. Determinism and seeds

- `FPCGContext::GetSeed()` → `UPCGSettings::GetSeed()`: with `UseSeed() == true` it is
  `PCGHelpers::ComputeSeed(NodeSeed, ComponentSeed)` (component `Seed`, default 42); without an execution source,
  the node `Seed` alone. With `UseSeed() == false` it is the bare constant 42 (`PCGValueConstants::DefaultSeed`) —
  neither the node nor the component seed takes part. No settings at all → the component seed.
- Each point has its own `Seed`; samplers derive randomness from stable inputs (Surface Sampler seeds each cell
  from the cell indices). Per-point randomness = `FRandomStream(PCGHelpers::ComputeSeed(ContextSeed, PointSeed))`.
  "Mutate Seed" rehashes each point seed from its position, the node seed and the old seed.
- So the same inputs + same seeds → the same output, independent of thread scheduling. Anything else
  (`FMath::Rand`, time, iteration order of a `TMap`/`TSet`, order of async completion) breaks it — see traps.

## 8. Cleanup and regenerate

- Everything generation creates is a `UPCGManagedResource` on the component: `UPCGManagedActors`,
  `UPCGManagedComponent` (incl. ISM). Regeneration first *soft*-releases (marks unused, components may be reused,
  actors get the tag `PCG Marked For Cleanup`), then `ReleaseIfUnused` deletes what was not reused.
- `CleanupLocal(bRemoveComponents)` — local, delayed; `Cleanup(bRemoveComponents)` — NetMulticast;
  `CleanupLocalImmediate` — now; `CleanupLocalDeleteAllGeneratedObjects` also purges actors/components tagged as
  PCG-generated (`PCG Generated Actor`, `PCG Generated Component`) but no longer managed by anyone.
- What you spawn yourself (custom node, Blueprint, post-spawn function) is not cleaned up unless registered:
  `AddToManagedResources`, `AddActorsToManagedResources`, `AddComponentsToManagedResources`.
- `ClearPCGLink` moves the generated resources to a new actor and cuts them loose from the component (stamping).

## Verified at

- `PCG/Public/PCGComponent.h:77-82` — the three triggers; `:314` `Seed = 42`; `:324` `bIsComponentPartitioned`;
  `:331` `bGenerateOnDropWhenTriggerOnDemand`; `:334-347` runtime gen radii and scheduling policy;
  `:197-207` managed-resource helpers; `:252-257` `Generate`/`Cleanup` are `NetMulticast, Reliable`;
  `:242-249` `CleanupLocalDeleteAllGeneratedObjects`, `CleanupLocalImmediate`; `:266-271` `GetGeneratedGraphOutput`, `ClearPCGLink`
- `PCG/Private/PCGComponent.cpp:366-412` `ShouldGenerate` (runtime-managed denial `:373-383`, procedural ISM `:393-397`);
  `:1743-1772` `BeginPlay` generates GenerateOnLoad only when `!bGenerated`; `:117` graph instance subobject
- `PCG/Public/PCGCommon.h:588-593` editing modes; `PCG/Public/PCGComponent.h:631-632` runtime component = Preview; `:596-628` runtime radii and multipliers 2.0 / 1.1;
  `:520-534` HiGen grids; `:235-283` `EPCGDataType`; `:336` `DefaultSeed = 42`
- `PCG/Public/PCGGraph.h:718-727` HiGen settings; `:276-293` `SetGraphParameter`; `PCG/Private/PCGGraph.cpp:3158-3176`
  parameter notification only `WITH_EDITOR`
- `PCG/Private/Graph/PCGGraphCompiler.cpp:663-664` data only from a larger grid; `PCG/Private/RuntimeGen/PCGRuntimeGenScheduler.cpp:2353` transient partition actors
- `PCG/Private/Metadata/PCGAttributePropertySelector.cpp:17-19` `$` / `@` prefixes; `PCG/Private/PCGVolume.cpp:15`
- `PCG/Public/PCGWorldActor.h:59-63` partition grid 25600; `:76-82` generation sources
- `PCG/Private/RuntimeGen/PCGRuntimeGenScheduler.cpp:83-90` pooling; `PCG/Private/RuntimeGen/PCGGenSourceManager.cpp:36-39`
  server mode, `:203-233` player controllers as sources
- `PCG/Public/RuntimeGen/SchedulingPolicies/PCGSchedulingPolicyDistanceAndDirection.h:12-17, 41-66`
- `PCG/Private/PCGSettings.cpp:723-726` seed combination; `PCG/Private/PCGContext.cpp:81-91, 138-152`;
  `PCG/Private/PCGComponentExecutionState.cpp:18-22` (component seed)
- `PCG/Private/Elements/PCGSurfaceSampler.cpp:281` cell seed; `PCG/Private/Elements/PCGMutateSeed.cpp:44`
- `PCG/Public/Elements/PCGSpawnActor.h:17-31` options and generation trigger; `:57` NoMerging default for new nodes
- `PCG/Public/Elements/PCGStaticMeshSpawner.h:79-81, 118-120`
- `PCG/Public/Elements/PCGLoopElement.h:44-61`; `PCG/Public/PCGPin.h:19-28` pin usage; `PCG/Public/PCGSubgraph.h:135-155`; `PCG/Private/PCGSubgraph.cpp:500-503`
- `PCG/Public/PCGManagedResource.h:76-84` soft release; `PCG/Private/PCGManagedResource.cpp:238-251` cleanup tag;
  `PCG/Public/Helpers/PCGHelpers.h:35-38` tags
- `PCG/Public/Data/PCGBasePointData.h:129-131` ranges invalidated by `SetNumPoints`/`AllocateProperties`
