---
grounded: 2026-08-12
---

# Engine API — landscape edit layers: writing and reading back

Grounded against the UE 5.8 source; the grounding floor is the `grounded:` field above. Line numbers are hints; re-ground if stale.

## The trap

`SetAlphaData` through an edit layer writes into that layer's own scratch weightmap, not the final one.
Merging into the component's `WeightmapTextures` happens in `ALandscape::TickLayers` — which never runs in a
headless authoring tool. A tool that writes, requests an update and saves the level therefore persists
nothing, and any verifier reading the final weightmap sees zeroes.

## ALandscape::RequestLayersContentUpdateForceAll

`Source/Runtime/Landscape/Private/LandscapeEditLayers.cpp:6719` (declared `Landscape.h:419`)

Deferred only: it calls `RequestHeightmapUpdate`/`RequestWeightmapUpdate` per component — flag-setting
consumed later by `TickLayers` (`LandscapeEditLayers.cpp:7634`, gated on the editor ticking). Never
sufficient on its own in tool code.

## ALandscape::ForceUpdateLayersContent

`Source/Runtime/Landscape/Classes/Landscape.h:539`, impl `LandscapeEditLayers.cpp:7608`

```cpp
LANDSCAPE_API void ForceUpdateLayersContent();
// -> UpdateLayersContent(bWaitForStreaming = true, bInSkipMonitorLandscapeEdModeChanges = true, bFlushRender = true);
```

The synchronous merge. Call it right after `SetAlphaData` + `Flush()` and before saving the level.
`ForceLayersFullUpdate()` (`LandscapeEditLayers.cpp:7619`) additionally finishes asset compilation and
blocks on streaming — reach for it when either may be in flight.

## FLandscapeEditDataInterface — which layer a read sees

`Source/Runtime/Landscape/Public/LandscapeEdit.h:128,131`

```cpp
FLandscapeEditDataInterface(ULandscapeInfo* InLandscape, bool bInUploadTextureChangesToGPU = true);
FLandscapeEditDataInterface(ULandscapeInfo* InLandscape, const FGuid& InEditLayerGUID, bool bInUploadTextureChangesToGPU = true);
```

The guid form reads that edit layer's scratch data. The no-guid form resolves through
`ALandscape::EditingLayer` (`Landscape.h:685`) — a plain non-`UPROPERTY` member that is invalid on a fresh
level load — so it falls through to the component's final `WeightmapTextures`
(`ULandscapeComponent::GetWeightmapTextures`, `Landscape.cpp:2612`). For a verifier that re-loads the level,
the no-guid form is the right one: it asserts the merged result a shipped level would carry.

## FLandscapeEditDataInterface::GetWeightData

`Source/Runtime/Landscape/Public/LandscapeEdit.h:187`, impl `LandscapeEditInterface.cpp:3403`

```cpp
LANDSCAPE_API void GetWeightData(ULandscapeLayerInfoObject* LayerInfo, int32& X1, int32& Y1, int32& X2, int32& Y2, uint8* Data, int32 Stride);
```

`Stride == 0` means tightly packed `(X2 - X1 + 1)`. `X1/Y1/X2/Y2` are in/out: the call clamps them to the
region actually covered by components (`LandscapeEditInterface.cpp:2798-2802`, `:2882-2885`). When no
component covers the request they come back inverted (`INT_MAX`/`INT_MIN`) — distinguish that from
"all samples read zero", the two mean different things.

## ULandscapeInfo::GetLandscapeExtent

`Source/Runtime/Landscape/Classes/LandscapeInfo.h:247-249`

```cpp
LANDSCAPE_API bool GetLandscapeExtent(FIntRect& LandscapeExtent) const;
LANDSCAPE_API bool GetLandscapeExtent(int32& MinX, int32& MinY, int32& MaxX, int32& MaxY) const;
```

The bounds any quad-space rectangle must be validated against before writing — outside them the edit
silently clamps to nothing.

## UE::Landscape::RetrieveTargetLayerNamesFromMaterial

`Source/Runtime/Landscape/Public/LandscapeUtils.h:367` (editor-only, inside `#if WITH_EDITOR`)

```cpp
LANDSCAPE_API TArray<FName> RetrieveTargetLayerNamesFromMaterial(UMaterialInterface* InMaterial, bool bIncludeVisibilityLayer = true);
```

The names a material's expressions actually declare — the answer to «will painting this layer change
anything». It analyses the material graph, so it sees through a Material Instance to the layer nodes of its
parent. Without it, target layers and material layers are two lists nothing compares: a weight written for a
name the material never blends is stored, reads back at full strength, and renders identically to no layer at
all. This is the call to use — `ALandscapeProxy::GetLayersFromMaterial` compiles with a deprecation warning.

## ALandscapeProxy::GetHeightAtLocation

`Source/Runtime/Landscape/Classes/LandscapeProxy.h:1101`

```cpp
LANDSCAPE_API TOptional<float> GetHeightAtLocation(FVector Location, EHeightfieldSource HeightFieldSource = EHeightfieldSource::Complex) const;
```

World-space height under a world-space point, and the way to put anything ON the terrain without reading
the heightfield by hand — `ALandscape` inherits it. The `TOptional` is the whole contract: unset means the
point is not over this landscape at all, which is a different answer from "the ground there is at zero" and
is what separates a refusal from a silently floating actor. Reading the height array through
`FLandscapeEditDataInterface` stays the right call when thousands of samples are needed (the scatter grid);
this one is for the handful.

## ELandscapeTargetLayerBlendMethod

`Source/Runtime/Landscape/Public/LandscapeEditTypes.h:32`

```cpp
enum class ELandscapeTargetLayerBlendMethod : uint8
{
    None,                        // "No Weight Blending" — weight untouched by other layers
    FinalWeightBlending,         // "Weight Blending (Legacy)" — divided by the sum of its group at merge
    PremultipliedAlphaBlending,  // "Advanced Weight Blending" — blended per edit layer, inside a BlendGroup
    Count UMETA(Hidden),
};
```

WHY A WRITE OF 255 DOES NOT MAKE A LAYER DOMINANT. Weights of `FinalWeightBlending` layers are barycentric:
`PerformFinalWeightBlendingPS` (`Engine/Shaders/Private/Landscape/LandscapeEditLayersWeightmaps.usf:355`)
computes `Final = LayerWeight / SumOfTheGroup` on the GPU while the edit layers are MERGED — not at write
time. So one layer written at 255 over ground where three others also hold 255 reads back at 64, and a strip
painted that way renders exactly like the ground around it. The `bWeightAdjust`/`bTotalWeightAdjust` arguments
carry `UE_DEPRECATED(5.7)` and the compensating arithmetic behind them is gone from `SetAlphaData`, so the
CALLER owns it: write the whole distribution, or the layer only ever gets a share. `LandscapeLayerInfoObject.cpp:276` migrates
the old `bNoWeightBlend=false` to `FinalWeightBlending`, which is why existing project layers are in the legacy
group while `ULandscapeSettings::TargetLayerDefaultBlendMethod` (`Public/LandscapeSettings.h:167`) mints new
ones as `None`.

The interactive paint tool has NO exclusive-write path for legacy layers: its exclusive mode
(`Editor/LandscapeEditor/Private/LandscapeEdModePaintTools.cpp:198-251`) only subtracts from siblings that
share a `BlendGroup` under `PremultipliedAlphaBlending`. For a legacy layer an artist erases the neighbours by
hand — there is no engine call that does it.

## ULandscapeLayerInfoObject::GetBlendMethod / SetBlendMethod

`Source/Runtime/Landscape/Classes/LandscapeLayerInfoObject.h:116,124`

```cpp
inline ELandscapeTargetLayerBlendMethod GetBlendMethod() const;
LANDSCAPE_API void SetBlendMethod(ELandscapeTargetLayerBlendMethod InBlendMethod, bool bInModify);
```

The one honest way to ask whether a layer's weight will be divided against its neighbours. `bNoWeightBlend`
carries `UE_DEPRECATED` and maps onto this: `LandscapeLayerInfoObject.cpp:276` reads `bNoWeightBlend=true` as
`BlendMethod::None`.

## FLandscapeEditDataInterface::SetAlphaData — the three overloads

`Source/Runtime/Landscape/Public/LandscapeEdit.h:197,199,201`

```cpp
void SetAlphaData(ULandscapeLayerInfoObject*, X1, Y1, X2, Y2, const uint8* Data, int32 Stride, PaintingRestriction = None);
UE_DEPRECATED(5.7, "Support for bWeightAdjust and bTotalWeightAdjust have been removed…")
void SetAlphaData(ULandscapeLayerInfoObject*, …, PaintingRestriction, bool bWeightAdjust, bool bTotalWeightAdjust);
void SetAlphaData(const TSet<ULandscapeLayerInfoObject*>& DirtyLayerInfos, …, const uint8* Data, int32 Stride, PaintingRestriction = None);
```

The single-layer form touches ONLY that layer's raw storage — it neither reads nor rescales the neighbours.
`Stride == 0` means tightly packed `(X2 - X1 + 1)`.

The `TSet` form takes an INTERLEAVED buffer — `LandscapeInfo->Layers.Num()` bytes per sample, each layer at its
`GetLayerInfoIndex()` — and `DirtyLayerInfos` only says which layers may be newly ALLOCATED on a component: the
write then overwrites every layer already allocated there from the buffer, so a layer left unfilled is
clobbered with whatever byte sits at its slot. The engine's own `CollapseLayer`
(`LandscapeEditLayers.cpp:8394`) sidesteps it and loops the single-layer form per layer instead, which is the
cheaper way to write a whole distribution when the layer set is small and known.

## FLandscapeEditDataInterface::GetWeightDataFast — every layer at once

`Source/Runtime/Landscape/Private/LandscapeEditInterface.cpp:3445`

`GetWeightDataFast(nullptr, X1, Y1, X2, Y2, TMap<FIntPoint, TArray<uint8>>& SparseData)` returns every layer's
weight per point (`FFullWeightmapAccessor::GetDataFast` uses it exactly this way). The per-point array's
ordering against `GetLayerInfoIndex()` is NOT established from the source — verify empirically before relying
on it, or read layer by layer with `GetWeightData`.

## ALandscapeProxy::VisibilityLayer

`Source/Runtime/Landscape/Classes/LandscapeProxy.h:1002`

```cpp
LANDSCAPE_API static ULandscapeLayerInfoObject* VisibilityLayer;
```

The hole mask, not a surface: it is a target layer by mechanism and must be kept out of any weight
redistribution, or repainting a surface heals or punches holes as a side effect.
