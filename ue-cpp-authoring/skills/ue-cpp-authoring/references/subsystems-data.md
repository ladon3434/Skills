# Managers, data assets, validators

Where global logic and tunable data live, and how data is checked before it ships. Names and folders are the
project's; the shapes are engine API (checked against UE 5.8).

## «A manager», «a singleton», «a global class» → a subsystem

| Lives as long as | Base | Typical |
| --- | --- | --- |
| the game instance (whole run, survives map travel) | `UGameInstanceSubsystem` | save/progress, session services |
| one world | `UWorldSubsystem` (`UTickableWorldSubsystem` if it must tick) | per-level registries, spawners' coordinator |
| a local player | `ULocalPlayerSubsystem` | per-player UI/input state |
| the engine / the editor | `UEngineSubsystem` / `UEditorSubsystem` (editor module) | tooling |

- Lifecycle: `Initialize(FSubsystemCollectionBase&)` / `Deinitialize()`. A dependency on another subsystem —
  `Collection.InitializeDependency<UOther>()` inside `Initialize`. A world subsystem also gets `PostInitialize()`
  and `OnWorldBeginPlay(UWorld&)`; actors exist only from the latter.
- A world subsystem is created for every world type, editor preview worlds included. Restrict it with
  `DoesSupportWorldType` (or `ShouldCreateSubsystem`) when it only makes sense in game/PIE.
- Access needs no hand-made singleton: `GetGameInstance()->GetSubsystem<T>()`, `GetWorld()->GetSubsystem<T>()`;
  Blueprint gets a getter node for every subsystem automatically. A static `Get(const UObject* WorldContext)`
  helper is a convenience, not a requirement.
- A subsystem is not an actor: no transform, no components. Something that must exist in the scene is an actor the
  subsystem spawns or registers.
- Periodic work — engine timers or a tickable subsystem, not a hand-rolled `FTickableGameObject`.

## Tunable data → a data asset, not constants in code

- Balance numbers, item stats, references to meshes and sounds: a `UDataAsset` subclass (local settings of one
  system) or `UPrimaryDataAsset` (a catalogue the Asset Manager loads and unloads by id: items, weapons).
  `UPrimaryDataAsset` already implements `GetPrimaryAssetId()` (type = the native class); override it only for a
  different type name, and register the type in Project Settings → Asset Manager.
- Fields: `UPROPERTY(EditDefaultsOnly, BlueprintReadOnly, Category = "...")` — the same for every user of the asset,
  so not `EditAnywhere`. A number with a sensible range gets `meta = (ClampMin = "...", ClampMax = "...")`.
- The consumer holds `TObjectPtr<const UMyConfig>` (or a soft pointer if loaded on demand); the header
  forward-declares the class, the `.cpp` includes it.
- Which numbers to put there is a design decision, not a code one.

## Validation: the asset checks itself, or a validator checks others

| Need | Tool |
| --- | --- |
| a class checks **its own** fields (empty slot, out-of-range value, duplicate entry) | override `IsDataValid(FDataValidationContext&) const` under `#if WITH_EDITOR` (`Misc/DataValidation.h`); an actor placed in a level — also `CheckForErrors()` (Map Check) |
| checks across **other** assets or many types (every weapon on a level has a config; one GameMode per map) | an external validator: subclass `UEditorValidatorBase` (plugin `DataValidation`, enabled by default) |

External validator, in an **Editor** module only (`Type: Editor`; depends on `DataValidation`) — in a runtime
module the game target stops linking:

```cpp
UCLASS()
class UMyWeaponValidator : public UEditorValidatorBase
{
    GENERATED_BODY()
protected:
    virtual bool CanValidateAsset_Implementation(const FAssetData& InAssetData, UObject* InObject,
        FDataValidationContext& InContext) const override;            // cheap filter: class / path
    virtual EDataValidationResult ValidateLoadedAsset_Implementation(const FAssetData& InAssetData,
        UObject* InAsset, FDataValidationContext& Context) override;  // the check
};
```

- Report with `Context.AddError(FText)` (blocks the save / fails the run) or `Context.AddWarning(FText)`;
  `AssetFails` / `AssetPasses` set the validator's own verdict. The pre-5.4 overloads without `FAssetData` /
  with `TArray<FText>&` are deprecated.
- Keep it fast: no full asset-registry sweeps inside one `ValidateLoadedAsset`.
- Do not repeat in a validator what the class's own `IsDataValid` already checks, and do not re-check at runtime
  what validation guarantees and play cannot break. Runtime checks are for what can actually go wrong in play
  (`ensureMsgf` + safe branch).
- Run: Tools → Validate Data, saving the asset, or headless — the `DataValidation` commandlet
  (`UnrealEditor-Cmd <uproject> -run=DataValidation`); the ue-build-test skill knows the headless runner.
