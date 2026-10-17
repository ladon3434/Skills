---
grounded: 2026-08-19
---

# Engine API — headless asset import

Grounded against **UE 5.8**; the grounding floor is the `grounded:` field above. Each entry: signature and `file:line`.
A line number is a hint, not a contract — if an entry no longer points at its symbol, re-ground it and correct it in the same pass.

## Which import path is live in 5.8

`UAssetToolsImpl::ImportAssetsInternal` — `Source/Developer/AssetTools/Private/AssetTools.cpp:3567`

```cpp
bUseInterchangeFramework = UInterchangeManager::IsInterchangeImportEnabled() && (SpecifiedFactory == nullptr);
```

`IsInterchangeImportEnabled()` reads the CVar `Interchange.FeatureFlags.Import.Enable`, whose code default is `false`
(`Source/Runtime/Interchange/Engine/Private/InterchangeManager.cpp:60`, accessor at `:2503`) — but
`FInterchangeImportModule::StartupModule()` force-sets it true unconditionally
(`Plugins/Interchange/Runtime/Source/Import/Private/InterchangeImportModule.cpp:179`) and the plugin is
`"EnabledByDefault": true`. **Interchange is therefore the live path for any caller that does not pass an explicit
`Factory` on the task.** Legacy `UFbxFactory`/`UFbxImportUI` is still wired and fires only as a translate-failure
fallback (`AssetTools.cpp:3749`) or when the caller sets `Task->Factory`. glTF rides the identical call chain via
`UInterchangeGltfTranslator`.

## IAssetTools::ImportAssetTasks

`Source/Developer/AssetTools/Public/IAssetTools.h:288` (accessor), impl `AssetTools.cpp:2955`

```cpp
ASSETTOOLS_API static IAssetTools& Get();
virtual void ImportAssetTasks(const TArray<UAssetImportTask*>& ImportTasks) = 0;
```

With `Task->bAsync == false` this BLOCKS: `AssetTools.cpp:3966` calls `InterchangeManager.ImportAssetWithResult(...)`,
which itself calls `FImportResult::WaitUntilDone(/*bSynchronous*/ true)` before returning
(`InterchangeManager.cpp:1562`). No `FAssetCompilingManager::FinishAllCompilation()` exists anywhere in this chain and
none is needed for an animation-only import.

## UAssetImportTask

`Source/Editor/UnrealEd/Public/AssetImportTask.h:25`

Fields that matter for a headless import: `Filename`, `DestinationPath`, `DestinationName`, `bAutomated`,
`bReplaceExisting`, `bSave`, `bAsync`, `Options`, `Factory`.

```cpp
UNREALED_API const TArray<UObject*>& GetObjects() const;   // :82 — the authoritative result
UE::Interchange::FAssetImportResultPtr AsyncResults;       // :102 — diagnostics, plain member
```

`Result` (`:97`) is `UE_DEPRECATED(5.1)` — use `GetObjects()`, which also waits on `AsyncResults` if one is set.
`bAutomated = true` is what suppresses every dialog: `ImportAssetsInternal` computes
`bAutomatedImport = Params.bAutomated || GIsAutomationTesting` (`AssetTools.cpp:3549`) and gates each
`FMessageDialog::Open` on it. `GIsAutomationTesting` is NOT required.

## UInterchangeGenericAssetsPipeline

`Plugins/Interchange/Runtime/Source/Pipelines/Public/InterchangeGenericAssetsPipeline.h:42`

```cpp
TObjectPtr<UInterchangeGenericCommonSkeletalMeshesAndAnimationsProperties> CommonSkeletalMeshesAndAnimationsProperties;  // :93
TObjectPtr<UInterchangeGenericAnimationPipeline> AnimationPipeline;                                                      // :101
```

**Hand it over wrapped, never bare.** `AssetTools.cpp:3954` reads `Task->Options` twice: a
`UInterchangePipelineStackOverride` has its `OverridePipelines` copied straight into `FImportAssetParameters`, and
anything else is passed to `InterchangeManager.ConvertImportData(Options, ImportAssetParameters)` — a converter registry
built for LEGACY settings objects (`UFbxImportUI` and friends). A bare `UInterchangeGenericAssetsPipeline` finds no
converter there, so **the override is silently dropped and the project's default pipeline stack runs instead**. Example:
an animation-only import with a pinned skeleton came out with a brand-new skeleton and the importer said
nothing at all, because the pipeline carrying the pin never entered the stack.

```cpp
const auto Override = NewObject<UInterchangePipelineStackOverride>();  // InterchangeManager.h:388
Override->AddPipeline(Pipeline);                                       // :403
Task->Options = Override;
```

`AddPipeline` stores the object's own path via implicit `FSoftObjectPath` conversion (`InterchangeManager.cpp:881`), and
`GeneratePipelineInstance` (`InterchangeManager.cpp:800`) resolves it with `TryLoad()` and `DuplicateObject`s it — which
finds an already-in-memory transient object, so **the pipeline does not have to be a saved `.uasset`**; a
`NewObject<UInterchangeGenericAssetsPipeline>()` kept alive across the call is enough.

## UInterchangeGenericCommonSkeletalMeshesAndAnimationsProperties

`Plugins/Interchange/Runtime/Source/Pipelines/Public/InterchangeGenericAssetsPipelineSharedSettings.h:183`

```cpp
bool bImportOnlyAnimations = false;      // :195
bool bTryAutoSelectSkeleton = false;     // :199
TSoftObjectPtr<USkeleton> Skeleton;      // :203
```

`Skeleton` MUST be set for an animation-only import — validated at `:244` with the error text "a valid skeleton must be set".

## UInterchangeResultsContainer / UInterchangeResult

`Source/Runtime/Interchange/Core/Public/InterchangeResultsContainer.h:20`, `InterchangeResult.h:20`

```cpp
TArray<UInterchangeResult*> GetResults() const;                  // InterchangeResultsContainer.h:74 — by value
virtual EInterchangeResultType GetResultType() const;            // InterchangeResult.h:41 — Success | Warning | Error
virtual FText GetText() const;                                   // InterchangeResult.h:46
```

Both are virtual on the BASE class, so no cast is needed to read an error message. There is no single success/failure
enum on the task: failure = an imported-objects array without the type you wanted, plus `Error`-severity entries here.
Reached as `Task->AsyncResults->GetResults()`.

## UFbxImportUI — the legacy path, and its one trap

`Source/Editor/UnrealEd/Classes/Factories/FbxImportUI.h`

Only reached when the caller forces `Task->Factory = NewObject<UFbxFactory>()`. Fields:
`MeshTypeToImport = FBXIT_Animation` (`:113`), `bImportMesh = false` (`:126`), `Skeleton` (`:130`),
`bCreatePhysicsAsset = false` (`:134`), `bImportAnimations = true` (`:178`), `AnimSequenceImportData` (`:210`).

**Trap:** `bAutomatedImportShouldDetectType` defaults `true` (`FbxFactory.cpp:1242`) and then OVERWRITES
`MeshTypeToImport` with whatever the FBX auto-detects (`FbxFactory.cpp:348`). It has to be set `false` for
`FBXIT_Animation` to stick.

## Where the source path ends up

`UAssetImportData::SanitizeImportFilename` — `Source/Runtime/Engine/Private/EditorFramework/AssetImportData.cpp:311`

Stores a path relative to the package only when the absolute source path is under the `Engine`/`Game`/plugin mount
directory (`:320`); otherwise it falls back to an `EditorPerProjectUserSettings` data-source-folder relative check
(`:330`) and ultimately to an **absolute path**. A source file outside the project therefore bakes a machine-specific
path into the imported asset and will not reimport on another machine.

## Reading an imported UAnimSequence back

All on `IAnimationDataModel` (`Source/Runtime/Engine/Classes/Animation/AnimData/IAnimationDataModel.h`), reached via
`UAnimSequenceBase::GetDataModel()` (`AnimSequenceBase.h:243`):

```cpp
double GetPlayLength() const;                          // :162
int32 GetNumberOfFrames() const;                       // :168
int32 GetNumberOfKeys() const;                         // :174
FFrameRate GetFrameRate() const;                       // :180
void GetBoneTrackNames(TArray<FName>& OutNames) const; // :245
bool IsValidBoneTrackName(const FName& Name) const;    // :231
```

`UAnimSequenceBase::SequenceLength` and the old `NumFrames`/`NumberOfKeys` members are `UE_DEPRECATED(5.0)` — the model
accessors above replaced them. Root motion: `bEnableRootMotion` is a plain member on `UAnimSequence`
(`AnimSequence.h:320`) and `HasRootMotion()` (`:407`) just returns it — it is a FLAG someone set, not evidence that the
root bone carries keys. For that, ask the model.

## Not verified in this pass

- `UInterchangeAnimSequenceFactory` internals (the factory that builds the `UAnimSequence` from the translated graph) —
  the next read if frame-rate or bake-rate come out wrong.
- Whether a still-scanning asset registry breaks an import issued immediately at headless startup. Nothing in the call
  chain demands a pre-wait, but it was not tested against a cold editor.
