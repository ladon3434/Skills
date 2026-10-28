# PCG from C++ (UE 5.8)

Source root: `<engine>/Engine/Plugins/PCG/Source/PCG/` (`PCG/`). The project's own C++ rules (log categories,
`TObjectPtr`, naming) — `ue-cpp-authoring` if installed; they win over the sketches below.

## Module setup

- `Build.cs`: `PCG` in `PublicDependencyModuleNames` if PCG types appear in public headers, else private. GPU
  internals live in `PCGCompute` (a private dependency of PCG itself) — custom CPU nodes do not need it.
- The `PCG` plugin ships `EnabledByDefault: true` in 5.8; still list it in the `.uproject` if the project disables
  default plugins. Module `PCG` is `Runtime` (works in cooked builds), `PCGEditor` is editor-only.

## A custom node = settings + element

| Piece | Role |
|---|---|
| `UPCGSettings` subclass (`UCLASS`) | properties, pins, title, `CreateElement()`. Lives in the graph asset — this is what gets serialized and cached by CRC |
| `IPCGElement` subclass (plain C++ class) | `ExecuteInternal(FPCGContext*)` — stateless, `const`, may run on any worker thread |
| `FPCGContext` (optional custom subclass) | per-execution state; use `IPCGElementWithCustomContext<FMyContext>` for one |

`FSimplePCGElement` is deprecated since 5.4 — derive from `IPCGElement` directly. For "modify every point" use
`FPCGPointOperationElementBase` (time-sliced, chunked, see `PCGDensityRemapElement.cpp`); for a time-sliced
element with your own state — `TPCGTimeSlicedElementBase`.

```cpp
// MyPCGRandomKeep.h
#pragma once
#include "PCGSettings.h"
#include "PCGElement.h"
#include "MyPCGRandomKeep.generated.h"

/** Keeps each point with probability KeepRatio — deterministic per point seed. */
UCLASS(BlueprintType, ClassGroup = (Procedural))
class MYGAME_API UMyPCGRandomKeepSettings : public UPCGSettings
{
	GENERATED_BODY()

public:
#if WITH_EDITOR
	virtual FName GetDefaultNodeName() const override { return TEXT("RandomKeep"); }
	virtual FText GetDefaultNodeTitle() const override { return NSLOCTEXT("MyPCG", "RandomKeepTitle", "Random Keep"); }
	virtual EPCGSettingsType GetType() const override { return EPCGSettingsType::Filter; }
#endif
	virtual bool UseSeed() const override { return true; } // without it GetSeed() is the constant 42

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = Settings, meta = (ClampMin = "0", ClampMax = "1", PCG_Overridable))
	float KeepRatio = 0.5f;

protected:
	virtual TArray<FPCGPinProperties> InputPinProperties() const override { return Super::DefaultPointInputPinProperties(); }
	virtual TArray<FPCGPinProperties> OutputPinProperties() const override { return Super::DefaultPointOutputPinProperties(); }
	virtual FPCGElementPtr CreateElement() const override;
};

class FMyPCGRandomKeepElement : public IPCGElement
{
protected:
	virtual bool ExecuteInternal(FPCGContext* Context) const override;
	virtual bool SupportsBasePointDataInputs(FPCGContext* Context) const override { return true; }
	// IsCacheable: default true (false only for GPU nodes) — correct here: output depends only on inputs + settings.
};
```

```cpp
// MyPCGRandomKeep.cpp
#include "MyPCGRandomKeep.h"
#include "PCGContext.h"
#include "Data/PCGBasePointData.h"
#include "Helpers/PCGHelpers.h"

#define LOCTEXT_NAMESPACE "MyPCGRandomKeep"

FPCGElementPtr UMyPCGRandomKeepSettings::CreateElement() const
{
	return MakeShared<FMyPCGRandomKeepElement>();
}

bool FMyPCGRandomKeepElement::ExecuteInternal(FPCGContext* Context) const
{
	TRACE_CPUPROFILER_EVENT_SCOPE(FMyPCGRandomKeepElement::Execute);
	const UMyPCGRandomKeepSettings* Settings = Context->GetInputSettings<UMyPCGRandomKeepSettings>(); // with pin overrides applied
	check(Settings);
	const int32 Seed = Context->GetSeed(); // node seed combined with the component seed

	for (const FPCGTaggedData& Input : Context->InputData.GetInputsByPin(PCGPinConstants::DefaultInputLabel))
	{
		const UPCGSpatialData* Spatial = Cast<UPCGSpatialData>(Input.Data);
		const UPCGBasePointData* InPoints = Spatial ? Spatial->ToBasePointData(Context) : nullptr;
		if (!InPoints)
		{
			PCGE_LOG(Warning, GraphAndLog, LOCTEXT("NoPoints", "Input is not point/spatial data"));
			continue;
		}

		UPCGBasePointData* OutPoints = FPCGContext::NewPointData_AnyThread(Context);
		FPCGInitializeFromDataParams Params(InPoints);
		Params.bInheritSpatialData = false; // we write a subset, not all the points
		OutPoints->InitializeFromDataWithParams(Params); // metadata and attributes are inherited

		OutPoints->SetNumPoints(InPoints->GetNumPoints(), /*bInitializeValues=*/false);
		OutPoints->AllocateProperties(InPoints->GetAllocatedProperties());
		OutPoints->CopyUnallocatedPropertiesFrom(InPoints);

		const FConstPCGPointValueRanges Read(InPoints);         // ranges AFTER SetNumPoints/AllocateProperties
		FPCGPointValueRanges Write(OutPoints, /*bAllocate=*/false);
		int32 NumKept = 0;
		for (int32 i = 0; i < InPoints->GetNumPoints(); ++i)
		{
			FRandomStream Random(PCGHelpers::ComputeSeed(Seed, Read.SeedRange[i]));
			if (Random.FRand() < Settings->KeepRatio)
			{
				Write.SetFromValueRanges(NumKept++, Read, i);
			}
		}
		OutPoints->SetNumPoints(NumKept);

		FPCGTaggedData& Output = Context->OutputData.TaggedData.Add_GetRef(Input); // keeps tags and pin
		Output.Data = OutPoints;
	}
	return true; // false = "not finished, call me again" (time slicing)
}

#undef LOCTEXT_NAMESPACE
```

Rules that matter:

- **Settings are read-only during execution**; never mutate them, never keep state in the element (one element
  instance serves many executions in parallel). State goes in a custom context.
- **New UObjects off the game thread** — `FPCGContext::NewObject_AnyThread<T>(Context)` /
  `NewPointData_AnyThread`, not `NewObject`: off the game thread they are created under a GC guard and held by the
  context until the task ends.
- **Output** — `Context->OutputData.TaggedData`. With one output pin every output is relabelled to it after
  execution, so `Add_GetRef(Input)` is fine; with several, set `Pin` to the output label yourself — data on an
  unknown label is an error "Output data generated for non-existent output pin".
- **Pins** — `FPCGPinProperties(Label, EPCGDataType::Point /* or FPCGDataTypeInfoX::AsId() */, bAllowMultipleConnections,
  bAllowMultipleData, Tooltip)`; `SetRequiredPin()` makes execution skip when unconnected/empty;
  `PCGPinConstants::DefaultInputLabel` / `DefaultOutputLabel` are `In` / `Out`.
- **Main thread** — anything that touches the world (spawning actors, adding components, loading assets
  synchronously) must return true from `CanExecuteOnlyOnMainThread(Context)` for that phase.
- **Caching** — `IsCacheable` defaults to true (false only for GPU-executed settings). Return **false** if the node
  creates artifacts (actors, components) or reads data PCG does not track (a subsystem, a global, a file, the
  current time). A wrong `true` gives stale results from the cache; a needless `false` re-runs every time.
- **Seed** — override `UseSeed()` to get a `Seed` property; combine with the per-point seed as above.
- **Logging** — `PCGE_LOG(Verbosity, GraphAndLog | LogOnly, LOCTEXT(...))` shows on the node in the graph and in
  `LogPCG`; needs a `Context` variable in scope (`PCGE_LOG_C` takes one explicitly).
- **Artifacts** — actors/components you create must become managed resources (`UPCGManagedActors`,
  `UPCGManagedComponent`, `UPCGComponent::AddToManagedResources`) or cleanup will never remove them.
  `UPCGActorHelpers::GetOrCreateManagedISMC` gives a managed ISM.
- **New nodes appear in the palette** automatically (`bExposeToLibrary` defaults to true).

## Blueprint custom node vs C++

| | Blueprint (`UPCGBlueprintBaseElement` subclass, run by "Execute Blueprint") | C++ |
|---|---|---|
| Base class | `UPCGBlueprintBaseElement`, or `UPCGBlueprintPointProcessorElement` / `UPCGBlueprintPointProcessorSimpleElement`; old `UPCGBlueprintElement` is deprecated | `UPCGSettings` + `IPCGElement` |
| Entry | `Execute(Input, Output)` (BlueprintNativeEvent) | `ExecuteInternal` |
| Thread | `bRequiresGameThread = true` by default | any thread unless you say otherwise |
| Cache | `bIsCacheable = false` by default, or `IsCacheableOverride` | `IsCacheable` default true |
| Pins | `CustomInputPins` / `CustomOutputPins`, `bHasDefaultInPin/OutPin` | `InputPinProperties` / `OutputPinProperties` |

Blueprint: prototyping, game-thread-bound logic, designers. C++: anything per-point at scale, hot paths, runtime
generation, cacheable nodes.

## Driving generation from C++

```cpp
// MyActor.h: UPROPERTY(VisibleAnywhere) TObjectPtr<UPCGComponent> PCG;
// constructor:
PCG = CreateDefaultSubobject<UPCGComponent>(TEXT("PCG"));
PCG->GenerationTrigger = EPCGComponentGenerationTrigger::GenerateOnDemand; // we decide when

// later, e.g. after the level data is ready:
PCG->SetGraphLocal(Graph);                                  // SetGraph() is NetMulticast
PCG->Seed = LevelSeed;                                      // deterministic per level
PCG->GetGraphInstance()->SetGraphParameter<double>(TEXT("Density"), 0.3);
PCG->OnPCGGraphGeneratedDelegate.AddUObject(this, &ThisClass::HandleGenerated); // native; ...External for BP
PCG->GenerateLocal(/*bForce=*/true);                        // delayed, async; not replicated

// tear down:
PCG->CleanupLocal(/*bRemoveComponents=*/true);
```

- `GenerateLocal(bool)` issues a `GenerateOnDemand` request; without `bForce` it does nothing on an already
  generated component. `Generate(bool)` / `Cleanup(bool)` / `SetGraph` are `NetMulticast, Reliable` — they only
  reach clients if the owning actor and the component replicate (the component does not call `SetIsReplicated`
  in its constructor). Otherwise run the `...Local` variant on each machine that needs the content.
- A `GenerateAtRuntime` component refuses every request but the scheduler's — do not call `Generate` on it;
  `pcg.RuntimeGeneration.Refresh` (console) cleans up and regenerates all of them.
- After changing properties or graph parameters in a game: regenerate yourself with `GenerateLocal(true)`.
  `NotifyPropertiesChangedFromBlueprint()` — despite its "used in runtime cases" comment — has a body only under
  `WITH_EDITOR`, a no-op in a cooked build; graph parameter changes notify only in the editor too.
- Result data: `GetGeneratedGraphOutput()` (the graph's output pins). Generation is async — read it in the
  generated delegate, not after the call.
- `GenerateLocalGetTaskId` returns an `FPCGTaskId` for chaining (`Dependencies` on the next call).

## Verified at

- `PCG/Public/PCGElement.h:139-252` `IPCGElement` (`CanExecuteOnlyOnMainThread :151`, `IsCacheable :157`,
  `ExecuteInternal :216` "called until it returns true", `SupportsBasePointDataInputs :248`);
  `:262-268` `IPCGElementWithCustomContext`; `:271` `FSimplePCGElement` deprecated 5.4
- `PCG/Private/PCGElement.cpp:1325-1328` `IsCacheable` default = `!ShouldExecuteOnGPU()`
- `PCG/Public/PCGSettings.h:346` `UseSeed`; `:480-481` `Seed`; `:498` `bExposeToLibrary = true`; `:529`
  `CreateElement`; `:567-568` default point pins; `PCG/Private/PCGSettings.cpp:723-726` seed 42 without `UseSeed`
- `PCG/Public/PCGContext.h:170-181` `GetSeed`, `NewObject_AnyThread`, `NewPointData_AnyThread`;
  `:330-345` `NewObject_AnyThread_Impl` (`FGCScopeGuard`, `AsyncObjects`)
- `PCG/Public/PCGPin.h:57-62` pin constructor; `:103-104` required pin; `PCG/Public/Data/Registry/PCGDataTypeIdentifier.h:43` implicit from `EPCGDataType`
- `PCG/Public/Data/PCGSpatialData.h:34-62` `FPCGInitializeFromDataParams`; `:173` `ToBasePointData`
- `PCG/Public/Data/PCGBasePointData.h:114-122, 129-131, 658-700, 802`; pattern from `PCG/Private/Elements/PCGDensityFilter.cpp:97-111`
- `PCG/Public/Elements/PCGPointOperationElementBase.h` (whole file); `PCG/Private/Elements/PCGDensityRemapElement.cpp`
- `PCG/Public/PCGModule.h:21` `LogPCG`; `PCG/Public/PCGElement.h:55-71` `PCGE_LOG` / `PCGE_LOG_C`
- `PCG/Public/Elements/Blueprint/PCGBlueprintBaseElement.h:24-25, 47-48, 67-68, 140-166`;
  `PCG/Public/Elements/Blueprint/PCGBlueprintDeprecatedElement.h:29-32`; `PCG/Private/Elements/PCGExecuteBlueprint.cpp:678-689`
- `PCG/Public/PCGComponent.h:186-207, 220-221, 231-232, 252-264`; `PCG/Private/PCGComponent.cpp:112-127` (no
  `SetIsReplicated`), `:373-383` runtime-managed denial, `:517-520` `GenerateLocalGetTaskId(bool)` = OnDemand
- `PCG/Private/PCGGraph.cpp:3173-3175` parameter notification `WITH_EDITOR` only;
  `PCG/Private/PCGComponent.cpp:1188-1194` `NotifyPropertiesChangedFromBlueprint` empty outside the editor
- `PCG/Public/Helpers/PCGActorHelpers.h:133-146` `GetOrCreateManagedISMC`
- `PCG/Private/Subsystems/PCGSubsystem.cpp:77-86` `pcg.RuntimeGeneration.Refresh`
- `PCG/Private/PCGElement.cpp:1185-1194` single output pin relabel, `:1223-1228` unknown pin error;
  `PCG/Private/PCGCommon.cpp:513-514` `In` / `Out`
- `<engine>/Engine/Plugins/PCG/PCG.uplugin:13` `EnabledByDefault`; `PCG/PCG.Build.cs:31-38` `PCGCompute` private
