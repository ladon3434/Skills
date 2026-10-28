---
grounded: 2026-08-27
---

# Engine API — skeletal mesh authoring (editor-time geometry)

Grounded against **UE 5.8**; the grounding floor is the `grounded:` field above. Each entry: signature and `file:line`.
A line number is a hint, not a contract — if an entry no longer points at its symbol, re-ground and correct it in the same pass.

## Authoring skinned geometry headless — the route

`UDynamicMesh` + GeometryScripting, not hand-built `FMeshDescription`. Read with
`UGeometryScriptLibrary_StaticMeshFunctions::CopyMeshFromSkeletalMesh`, edit, then write the asset with
`UGeometryScriptLibrary_CreateNewAssetFunctions::CreateNewSkeletalMeshAssetFromMesh`
(`GeometryScriptingEditor/Public/GeometryScript/CreateNewAssetUtilityFunctions.h:203`), which takes the target
`USkeleton` and does the whole build itself. The dynamic mesh carries bone attributes and skin weights across
both hops, so the edit in the middle is the only part that is ever hand-written.

`FGeometryScriptCreateNewSkeletalMeshAssetOptions::Materials` (:94) is a `TMap<FName, UMaterialInterface*>`
keyed by SLOT NAME — an empty map silently gives the result exactly one slot, so a source's
`USkeletalMesh::GetMaterials()` is copied into it whenever the slots matter.

## Bone weights on a UDynamicMesh

`GeometryScriptingCore/Public/GeometryScript/MeshBoneWeightFunctions.h`

`GetVertexBoneWeights` (:326) fills `TArray<FGeometryScriptBoneWeight>` (`BoneIndex`/`Weight`, :19);
`SetVertexBoneWeights`, `MeshHasBoneWeights` (:264), `MeshCreateBoneWeights` (:279),
`CopyBonesFromSkeleton` (:477) and `DiscardBonesFromMesh` (:489) are the rest of the surface.
The skeleton is queried by NAME, not index: `GetBoneInfo` (:551) answers `FGeometryScriptBoneInfo`
(:192 — `Index`, `Name`, `ParentIndex`, transforms) and `GetBoneChildren` (:533) walks a subtree recursively,
which is how a named bone set expands to «that joint and everything under it».
`GetBoneIndex` carries a deprecation marker; `GetBoneInfo` is the call to write.

## Selecting and deleting geometry

There is no engine utility that selects faces by a bone set — that step is hand-written, and it is the ONLY
hand-written step. Everything after it is engine code: collect triangle IDs
(`MeshQueryFunctions.h:118` `GetTriangleIndices`, `:90` `GetNumTriangleIDs`), turn them into a selection with
`UGeometryScriptLibrary_MeshSelectionFunctions::ConvertIndexArrayToMeshSelection`
(`MeshSelectionFunctions.h:140`, type `EGeometryScriptMeshSelectionType::Triangles`,
`GeometryScriptSelectionTypes.h:24`), drop them with
`UGeometryScriptLibrary_MeshBasicEditFunctions::DeleteSelectedTrianglesFromMesh`
(`MeshBasicEditFunctions.h:248`), then `RemoveUnusedVertices` + `CompactMesh`
(`MeshRepairFunctions.h:234, :225`) — deletion leaves orphan vertices and ID gaps behind on its own.

## Why no bone-index remap is owed

While the `FReferenceSkeleton` is left UNCHANGED, skin-weight bone indices stay valid with zero remapping.
`CreateNewSkeletalMeshAssetFromMeshLODs` reindexes the weights against the skeleton it was handed
(`GeometryScriptingEditor/Private/CreateNewAssetUtilityFunctions.cpp:462`), and the builder regenerates each
section's `BoneMap` (`SkeletalMeshLODModel.h:293`) from whichever bones the surviving faces actually
reference. A hand-rolled remap that gets this wrong either trips the builder's validation
(`ValidateSkinWeightAttribute`, `StaticToSkeletalMeshConverter.cpp:466`) or silently skins vertices to the
wrong bone — an exploded figure at runtime, with nothing red at author time.

## FSkeletalMeshOperations::RemoveBones

`Source/Runtime/SkeletalMeshDescription/Public/SkeletalMeshOperations.h:258` (also `RemoveUnusedBones` :271,
`PartitionByMaximumUniqueBoneIndexCount` :239)

Shrinks the SKELETON, reassigning a removed bone's weights to its parent — it does not delete geometry.
Not the tool for cutting triangles out of a mesh, and easy to reach for by mistake.

## Reading a built mesh back — FMeshDescription

`USkeletalMesh::GetMeshDescription` (`Engine/Classes/Engine/SkeletalMesh.h:538`, siblings `CreateMeshDescription`
:563, `CommitMeshDescription` :622) is the writable source of truth a `USkeletalMesh` holds per LOD;
`FSkeletalMeshLODModel` is derived from it and is never hand-built. This is the surface a `Verify*` reads:
`FMeshDescription::GetVertexPosition` (`MeshDescription.h:591`), `Vertices()`/`Triangles()` (:143), and
`FSkeletalMeshConstAttributes::GetVertexSkinWeights` (`SkeletalMeshAttributes.h:125`) whose
`UE::AnimationCore::FBoneWeights` iterate as `GetBoneIndex()`/`GetWeight()` against
`FReferenceSkeleton` raw indices. Ancestry is `FReferenceSkeleton::BoneIsChildOf`
(`ReferenceSkeleton.h:400`) — the read-side counterpart of `GetBoneChildren` above.

## Standing a skeleton up in a test

`FStaticToSkeletalMeshConverter::InitializeSkeletonFromStaticMesh`
(`Source/Developer/SkeletalMeshUtilitiesCommon/Public/StaticToSkeletalMeshConverter.h:31` single root, `:50`
a root-to-end-effector CHAIN) builds a `USkeleton` from a static mesh's bounding box. The chain overload with
`InIntermediaryJointCount = 0` gives exactly two bones, named `Root` and `Joint_1`
(`StaticToSkeletalMeshConverter.cpp:27,28`) — the cheapest honest fixture for anything that selects by bone,
since on a one-bone skeleton every bone subset is the whole mesh or nothing.
`InitializeSkeletalMeshFromMeshDescriptions` (`:519`) is the reference recipe for the full manual path when
GeometryScripting is not an option: `SetRefSkeleton` → `CalculateInvRefMatrices` (`SkeletalMesh.h:2631`) →
per-LOD `CreateMeshDescription`/`CommitMeshDescription` → `IMeshUtilities::BuildSkeletalMesh` → materials and
bounds, wrapped in `FScopedSkeletalMeshPostEditChange`. `SetSkeleton` (`SkeletalMesh.h:766`) links the shared
`USkeleton` asset and is a different call from `SetRefSkeleton`, which sets the mesh's own bone array.

This surface is `WITH_EDITOR`-gated and the `PostEditChange`/`Build` half is game-thread only: usable from
the headless editor, unusable from cooked runtime.
