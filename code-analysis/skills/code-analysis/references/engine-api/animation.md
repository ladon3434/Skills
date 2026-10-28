---
grounded: 2026-07-21
---

# Engine API — animation

Grounded against **UE 5.8**; the grounding floor is the `grounded:` field above. Each entry: signature and `file:line`.
A line number is a hint, not a contract — if an entry no longer points at its symbol, re-ground it and correct it in the same pass.

## EVisibilityBasedAnimTickOption

`Source/Runtime/Engine/Classes/Components/SkinnedMeshComponent.h:96`

```cpp
UENUM(BlueprintType)
enum class EVisibilityBasedAnimTickOption : uint8
{
    AlwaysTickPoseAndRefreshBones,
    AlwaysTickPose,
    OnlyTickMontagesAndRefreshBonesWhenPlayingMontages,
    OnlyTickMontagesWhenNotRendered,
    OnlyTickPoseWhenRendered,
};
```

## USkinnedMeshComponent::VisibilityBasedAnimTickOption

`Source/Runtime/Engine/Classes/Components/SkinnedMeshComponent.h:794` (public, after the `public:` at `:787`)

```cpp
UPROPERTY(Interp, EditAnywhere, AdvancedDisplay, BlueprintReadWrite, Config, Category=Optimization)
EVisibilityBasedAnimTickOption VisibilityBasedAnimTickOption;
```

**There is NO `SetVisibilityBasedAnimTickOption()` anywhere in `Engine/Source`** — verified by grepping all headers. It is assigned directly as a field. Secondary sources name a setter that does not exist.

**Why this matters headless:** bones are refreshed only for `AlwaysTickPoseAndRefreshBones` or when the mesh was recently rendered, and in a headless test world there is no viewport so "recently rendered" is permanently false. `ACharacter` defaults its mesh to `AlwaysTickPose`. Leaving it there makes every bone assertion silently read the reference pose **and pass**.

## USkeletalMeshComponent::SetSkeletalMeshAsset

`Source/Runtime/Engine/Classes/Components/SkeletalMeshComponent.h:369`

```cpp
UFUNCTION(BlueprintCallable, Category = "Components|SkeletalMesh")
void SetSkeletalMeshAsset(USkeletalMesh* NewMesh) { SetSkeletalMesh(NewMesh, false); }
```

## USkeletalMeshComponent::SetAnimationMode

`Source/Runtime/Engine/Classes/Components/SkeletalMeshComponent.h:1246`

```cpp
UFUNCTION(BlueprintCallable, Category = "Components|Animation", meta = (Keywords = "Animation"))
ENGINE_API void SetAnimationMode(EAnimationMode::Type InAnimationMode, bool bForceInitAnimScriptInstance = true);
```

## USkeletalMeshComponent::PlayAnimation

`Source/Runtime/Engine/Classes/Components/SkeletalMeshComponent.h:1258`

```cpp
UFUNCTION(BlueprintCallable, Category = "Components|Animation", meta = (Keywords = "Animation", UnsafeDuringActorConstruction = "true"))
ENGINE_API void PlayAnimation(class UAnimationAsset* NewAnimToPlay, bool bLooping);
```

## USkinnedMeshComponent::GetBoneTransform

`Source/Runtime/Engine/Classes/Components/SkinnedMeshComponent.h:1516`

```cpp
UFUNCTION(BlueprintCallable, Category="Transformation", meta=(Keywords="Bone"))
FTransform GetBoneTransform(FName InBoneName, ERelativeTransformSpace TransformSpace = RTS_World) const { return GetSocketTransform(InBoneName, TransformSpace); }
```

Note the default is **world** space; pass `RTS_Component` when asserting a pose independently of where the actor stands.

## Sync markers (foot phase)

Sync markers are what keep two clips in step when one is swapped for another mid-stride; a marker the **skeleton** does not know about is worse than none, because the sync group silently degrades to time-based blending instead of erroring.

- `Source/Runtime/Engine/Public/Animation/AnimTypes.h:479` — `USTRUCT(BlueprintType) struct FAnimSyncMarker` with `FName MarkerName`, `float Time`, and (under `WITH_EDITORONLY_DATA`) `int32 TrackIndex` and `FGuid Guid`.
- `Source/Runtime/Engine/Classes/Animation/AnimSequence.h:702` — `UPROPERTY() TArray<FAnimSyncMarker> AuthoredSyncMarkers;` — **public**, assigned directly (the `public:` is at `:699`, outside the `WITH_EDITOR` block that closes at `:690`).
- `AnimSequence.h:705` — `TArray<FName> UniqueMarkerNames;` — the republished list the sync groups actually read. Not written by hand.
- `AnimSequence.h:694` — `ENGINE_API void RefreshSyncMarkerDataFromAuthored();` — sorts the authored list and republishes `UniqueMarkerNames`. **Call it after mutating `AuthoredSyncMarkers`** or the markers exist but nothing consumes them.
- `Source/Runtime/Engine/Classes/Animation/Skeleton.h:494` — `void RegisterMarkerName(FName MarkerName)` (adds unique + sorts) and `:491` — `const TArray<FName>& GetExistingMarkerNames() const`. Registering on the owning skeleton is part of authoring a marker, not an optional extra.

Our tools: `PatchAnimSequence(..., MarkersListJson)` rebuilds the set (`[]` clears, empty string leaves untouched) and registers every name on the skeleton; `VerifyAnimSequence(..., MarkersListJson)` checks the set exactly and asserts both `UniqueMarkerNames` and the skeleton registration.

## UIKRetargetBatchOperation::RunBatchRetarget + FIKRetargetBatchOperationInputs

`Plugins/Animation/IKRig/Source/IKRigEditor/Public/RetargetEditor/IKRetargetBatchOperation.h:117` (struct), `:180-194` (entry). Module `IKRigEditor` (`IKRIGEDITOR_API`), editor-type; the `UIKRetargeter` asset type itself is runtime `IKRig`. Include `"RetargetEditor/IKRetargetBatchOperation.h"`.

```cpp
USTRUCT(BlueprintType) struct FIKRetargetBatchOperationInputs
{
    TArray<FAssetData> AssetsToRetarget;
    TObjectPtr<USkeletalMesh> SourceMesh = nullptr;
    TObjectPtr<USkeletalMesh> TargetMesh = nullptr;
    TObjectPtr<UIKRetargeter> IKRetargetAsset = nullptr;
    TArray<FName> InOverrideSetNames;
    FString Search, Replace, Prefix, Suffix, TargetPath; // all default empty
    bool bUseSourcePath = false;
    bool bIncludeReferencedAssets = true;
    bool bOverwriteExistingFiles = false;
    bool bRetainAdditiveFlags = true;
};

UFUNCTION(BlueprintCallable, Category=IKBatchRetarget)
static UE_API TArray<FAssetData> RunBatchRetarget(const FIKRetargetBatchOperationInputs& Inputs);
```

`DuplicateAndRetarget(...)` is still public static but `UE_DEPRECATED(5.8)` — every online snippet quoting it is stale; do not use. Executed headless by `TheAnimation.BatchRetargetSpike` — see the spike test for a working call.

## Pose Search — montage and root-motion support

These correct widely-repeated claims that Motion Matching cannot use montages and requires root motion.

- `Plugins/Animation/PoseSearch/Source/Runtime/Private/PoseSearchAssetSampler.cpp:398,436-450,566-598` — `UAnimMontage` **is** sampled (pose extraction and root-transform extraction). The only limitation is explicit in the log text at `:57-59`, `:401-403`, `:445`: *"so far we support only montages with one SlotAnimTracks"*.
- `Plugins/Animation/PoseSearch/Source/Runtime/Public/PoseSearch/PoseSearchDatabase.h:395` — `FPoseSearchDatabaseAnimMontage` is `UE_DEPRECATED(5.7, "Use FPoseSearchDatabaseAnimationAsset instead")`: montages were folded into the generic asset path, not removed.
- `PoseSearchDatabase.h:86` — `virtual bool IsRootMotionEnabled() const { return false; }` — a per-asset-type virtual defaulting to false, not an entry barrier; root motion is applied optionally through `IAnimRootMotionProvider` (`AnimNode_MotionMatching.h:197`).
- `PoseSearchDerivedData.h:39` — `FAsyncPoseSearchDatabasesManagement::RequestAsyncBuildIndex(db, NewRequest|WaitForCompletion)`: the index build is a callable function, so database authoring is headless. The derived-data header is `#if WITH_EDITOR`.

## Plugin maturity (animation), read from the `.uplugin` files

Doc pages disagree with these and the `.uplugin` is the authority.

| Plugin | VersionName | IsBetaVersion | IsExperimentalVersion |
| --- | --- | --- | --- |
| `Animation/PoseSearch` | 1.0 | absent | absent |
| `Chooser` | 1.0 | absent | absent |
| `Animation/BlendStack` | 1.0 | absent | absent |
| `Animation/PhysicsControl` | 1.0 | false | false |
| `Animation/AnimationWarping` | 1.0 | false | false |
| `Animation/MotionWarping` | **0.1** | **true** | false |
| `Animation/DeformerGraph` | 0.9 | true | absent |
| `Experimental/UAF/UAFChooser` | 0.1 | false | **true** |
| `Experimental/UAF/UAFPoseSearch` | 0.1 | false | **true** |

The "Experimental Chooser" that appears on a 5.8 doc page is `UAFChooser`, a different plugin from the classic `Chooser`. `MotionWarping` is the least mature of the animation plugins our projects enable.

## FAnimNode_BlendStack_Standalone — usable without Motion Matching

`Plugins/Animation/BlendStack/Source/Runtime/Private/AnimNode_BlendStack.cpp:1108-1134` and `BlendStack.Build.cs`.

The BlendStack runtime module depends only on `Core`, `CoreUObject`, `Engine`, `AnimationCore`, `AnimGraphRuntime` — **no `PoseSearch`**. PoseSearch is reached solely through the `IPoseSearchProvider` interface and only for the optional `StitchDatabase`; when absent the node logs and *"Defaulting to regular blend"*. So N-deep automatic cross-fading is available without adopting Motion Matching.

## FReferenceSkeleton — the rest pose a skeleton holds

`Source/Runtime/Engine/Public/ReferenceSkeleton.h:99` (struct), `:251` `GetRawBoneNum()`, `:267` `GetRefBonePose()`, `:315` `FindBoneIndex()`, `:351` `GetParentIndex()`

```cpp
int32 GetRawBoneNum() const;
const TArray<FTransform>& GetRefBonePose() const;   // BONE-SPACE, one per bone
int32 FindBoneIndex(const FName& BoneName) const;
int32 GetParentIndex(const int32 BoneIndex) const;
FName GetBoneName(const int32 BoneIndex) const;
```

`GetRefBonePose()` is bone-space, so a bone's direction in the character's frame is not readable from it directly.
Reached from `USkeletalMesh::GetRefSkeleton()` and `USkeleton::GetReferenceSkeleton()`.

## FAnimationRuntime::FillUpComponentSpaceTransforms

`Source/Runtime/Engine/Public/AnimationRuntime.h:707`

```cpp
static ENGINE_API void FillUpComponentSpaceTransforms(const FReferenceSkeleton& RefSkeleton, const TArrayView<const FTransform>& BoneSpaceTransforms, TArray<FTransform>& ComponentSpaceTransforms);
```

The engine's own bone-space → component-space accumulation; hand-rolling the parent walk is the defect it prevents.
Feed it `RefSkeleton.GetRefBonePose()` to get the rest pose in the character's frame.

## AnimBlueprint clone-and-patch by state name

The editor side — what a tool walks to reach a state:

```cpp
// UnrealEd, Kismet2/BlueprintEditorUtils.h:505 — finds nodes nested in state graphs too, because
// placement appends each state's BoundGraph to the parent graph's UEdGraph::SubGraphs.
template<class T> static void FBlueprintEditorUtils::GetAllNodesOfClass(const UBlueprint*, TArray<T*>&);

// AnimGraph, AnimGraphNode_StateMachineBase.h:23 / :48
TObjectPtr<UAnimationStateMachineGraph> EditorStateMachineGraph;
FString GetStateMachineName();

// AnimGraph, AnimStateNode.h:31 / AnimStateNode.cpp:73 — a state's NAME *is* its bound graph's name.
TObjectPtr<UEdGraph> BoundGraph;
virtual FString GetStateName() const override;   // returns BoundGraph->GetName()

// AnimGraph, AnimGraphNode_AssetPlayerBase.h:46 — the ONLY way in from outside: the struct fields
// FAnimNode_SequencePlayer::Sequence and FAnimNode_BlendSpacePlayer::BlendSpace are protected/private
// with a friend list, so writing them from tool code is a compile error, not a silent no-op.
virtual void SetAnimationAsset(UAnimationAsset* Asset);
virtual UAnimationAsset* GetAnimationAsset() const;
```

Making an asset-reference edit stick: `Modify()` → `SetAnimationAsset()` →
`FBlueprintEditorUtils::MarkBlueprintAsModified` (UnrealEd, `BlueprintEditorUtils.h:317` — NOT
`MarkBlueprintAsStructurallyModified`, which is for added/removed graphs) → `FKismetEditorUtilities::CompileBlueprint`
(UnrealEd, `KismetEditorUtilities.h:169`) → save. `ReconstructNode()` is not needed: the engine's own
`PostEditChangeProperty` skips it for the asset field and reserves it for pin-shape properties.

## UAnimBlueprint::TargetSkeleton and the template flag

```cpp
// Engine, Animation/AnimBlueprint.h:90 — a plain public UPROPERTY in 5.8; there is no accessor pair.
TObjectPtr<USkeleton> TargetSkeleton;
bool bIsTemplate;                                  // :100 — implies a null TargetSkeleton
```

The compiler refuses a skeleton-less blueprint only when it is neither newly created nor a template
(`AnimBlueprintCompiler.cpp:671`). `bIsTemplate` COPIES on duplication, so a clone of a template compiles
green while being unusable as an instance — a clone must clear the flag and set the skeleton, or the guard
never fires.

## Reading a compiled AnimBlueprint back without an editor window

```cpp
// Engine, Animation/AnimBlueprintGeneratedClass.h:450 / :453
virtual const TArray<FBakedAnimationStateMachine>& GetBakedStateMachines() const;
virtual const TArray<FStructProperty*>& GetAnimNodeProperties() const;
```

`FBakedAnimationStateMachine{ FName MachineName; TArray<FBakedAnimationState> States; }` and
`FBakedAnimationState{ FName StateName; TArray<int32> PlayerNodeIndices; }` (`AnimStateMachineTypes.h:368, 312`).
`StateName` is set from `StateNode->BoundGraph->GetFName()` (`AnimGraphNode_StateMachineBase.cpp:452`), the same
source as the editor name — so an address typed by a caller is the address the compiled asset carries.

A player index maps to its property REVERSED: `AnimNodeProperties[Num() - 1 - Index]`
(`AnimBlueprintGeneratedClass.h:658`). The asset then reads off the CDO by reflection, which is also how tool
code gets past the friend list:

```cpp
// CoreUObject, UObject/UnrealType.h:2894
UE_API virtual UObject* FObjectPropertyBase::GetObjectPropertyValue(const void* PropertyValueAddress) const;
```

Baked data exists only after a successful compile: a duplicated-but-unrecompiled clone still reports the
template's clips.

## USkeleton::IsCompatibleForEditor — pass the POINTER, never a path string

```cpp
// Engine, Animation/Skeleton.h:702, :707, :712
ENGINE_API bool IsCompatibleForEditor(const USkeleton* InSkeleton) const;
ENGINE_API bool IsCompatibleForEditor(const FAssetData& AssetData, const TCHAR* InTag = TEXT("Skeleton")) const;
ENGINE_API bool IsCompatibleForEditor(const FString& SkeletonAssetString) const;
```

The string overload compares against the **export-text** form — `Skeleton'/Game/Foo/SK_Bar.SK_Bar'`, quotes
and class prefix included (`Skeleton.cpp:148-154`, built by `FAssetData::GetExportTextName`). `GetPathName()`
returns the plain object path, so it never equals that string: the unconditional «check against itself»
early-out is skipped, execution falls through to `CompatibleSkeletons`, and **a skeleton with an empty
compatibility list answers FALSE about itself**. Written as
`Target->IsCompatibleForEditor(Clip->GetSkeleton()->GetPathName())` the check therefore rejects a clip that
sits on the target skeleton — a refusal with a correct-sounding message.

Use the pointer overload, which is what the engine's own compile gate uses
(`AnimGraphNode_AssetPlayerBase.cpp:357`): it builds the export-text string itself, so self-compatibility
holds by construction.

```cpp
Target->IsCompatibleForEditor(Clip->GetSkeleton());
```
