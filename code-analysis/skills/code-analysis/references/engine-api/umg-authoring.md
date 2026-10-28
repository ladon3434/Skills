---
grounded: 2026-07-20
---

# Engine API cache — headless UMG / Widget Blueprint authoring (UE 5.8)

Grounded signatures, kept so nobody grounds them twice. Read by `engine-api.cmd <Symbol>`, which
searches this directory **before** the engine — a section heading IS the lookup key, so a heading must be
the bare symbol name.

Every entry carries its `file:line`. **A line number is a hint, not a contract** — if it no longer points at
the symbol, re-ground it and correct the entry in the same pass. A cache nobody corrects is
worse than no cache.

Source: grounded against the UE 5.8 source; the grounding floor is the `grounded:` field above. Paths are relative to
`Engine/`.

---

## FWidgetBlueprintOperationUtils

`Source/Editor/UMGEditor/Public/WidgetBlueprintOperationUtils.h:21`. Exists in 5.8.

**Every static carries `UE_API`** — 5.8 declares the export per symbol, not once per class as
`UMGEDITOR_API`. Copy the macro along with the signature or the declaration will not match the engine's.

```cpp
// :41
static UE_API UWidgetBlueprint* CreateWidgetBlueprint(UObject* InParent, FName Name,
    EBlueprintType BlueprintType, TSubclassOf<UUserWidget> ParentClass,
    TSubclassOf<UWidget> RootWidgetClass = nullptr, FName CallingContext = NAME_None,
    bool bRegisterAndCompile = true);

// :49
static UE_API bool AddWidget(UWidgetBlueprint* WidgetBlueprint, UWidget* NewWidget, UWidget* ParentWidget,
    int32 ChildIndex, FText& OutErrorMessage);

// :82
static UE_API void ToggleWidgetAsVariable(UWidgetBlueprint* Blueprint, UWidget* Widget, bool bToVariable,
    bool bMarkBlueprintModified = true);
```

**Prefer `AddWidget` over a raw `UPanelWidget::AddChild`.** It also calls `OnVariableAdded` and
`MarkBlueprintAsStructurallyModified` (`WidgetBlueprintOperationUtils.cpp:402/428`). Skipping
`OnVariableAdded` trips `ensure(WidgetVariableNameToGuidMap.Contains(...))` at
`Source/Editor/UMGEditor/Private/WidgetBlueprintCompiler.cpp:1538` — i.e. the failure surfaces later, in
the compiler, far from the code that caused it.

## UWidgetTree

`Source/Runtime/UMG/Public/Blueprint/WidgetTree.h`

```cpp
// :106 — TEMPLATE ONLY (there is no non-template overload) and [[nodiscard]]
template <typename WidgetT = UWidget>
[[nodiscard]] inline WidgetT* ConstructWidget(TSubclassOf<WidgetT> WidgetClass = WidgetT::StaticClass(),
                                              FName WidgetName = NAME_None);

// :34   UWidget* FindWidget(const FName& Name) const;
// :65   void GetAllWidgets(TArray<UWidget*>& Widgets) const;
// :150  TObjectPtr<UWidget> RootWidget;
```

`Blueprint->WidgetTree` is declared on `UBaseWidgetBlueprint`, not on `UWidgetBlueprint` —
`Source/Editor/UnrealEd/Public/BaseWidgetBlueprint.h:17`. **That is why UnrealEd is a mandatory
dependency** for any module touching the widget tree of a blueprint.

## UPanelWidget::AddChild

`Source/Runtime/UMG/Public/Components/PanelWidget.h:59`

```cpp
UPanelSlot* AddChild(UWidget* Content);   // cast the result: Cast<UVerticalBoxSlot>(Slot)
```

## Panel slot setters

Uniform across the box panels: `SetPadding(FMargin)`, `SetHorizontalAlignment(EHorizontalAlignment)`,
`SetVerticalAlignment(EVerticalAlignment)`. Beyond that they differ, and the differences are what a
layout compiler must respect:

| Slot | size rule | extra | missing |
| --- | --- | --- | --- |
| `UVerticalBoxSlot` / `UHorizontalBoxSlot` / `UScrollBoxSlot` | `SetSize(FSlateChildSize)` | — | — |
| `UGridSlot` | — | Row/RowSpan/Column/ColumnSpan/Layer/Nudge | no size rule |
| `UUniformGridSlot` | — | Row/Column | **no padding** |
| `UOverlaySlot` / `USizeBoxSlot` / `UBorderSlot` / `UWrapBoxSlot` | — | — | no size rule |
| `UScaleBoxSlot` | — | — | no size rule, **no padding** |

**`UScaleBoxSlot::SetPadding` still exists but is `UE_DEPRECATED(5.1)`** — *"There is no padding on
ScaleBox"* (`ScaleBoxSlot.h:41-42`). Warnings are errors here, so calling it fails the build. The macro sits on the **preceding
line**, which `engine-api.cmd` prints.

## FSlateChildSize

`Source/Runtime/UMG/Public/Components/SlateWrapperTypes.h:155`

```cpp
struct FSlateChildSize
{
    float Value;
    TEnumAsByte<ESlateSizeRule::Type> SizeRule;   // :165
};
```

## ESlateSizeRule

`Source/Runtime/UMG/Public/Components/SlateWrapperTypes.h:113` — a **namespaced** enum
(`namespace ESlateSizeRule { enum Type { Automatic, Fill }; }`), so it is used as
`ESlateSizeRule::Fill` and stored as `TEnumAsByte<ESlateSizeRule::Type>`.

## BindWidget

No Blueprint variable has to be created by hand. `FWidgetBlueprintCompilerContext`
(`Source/Editor/UMGEditor/Public/WidgetBlueprintCompiler.h:54`) synthesizes the variables from
`UWidget::bIsVariable` (`Source/Runtime/UMG/Public/Components/Widget.h:318`) at
`WidgetBlueprintCompiler.cpp:1511`, and binds by matching **FName + type** against the parent class's
properties flagged by `FWidgetBlueprintEditorUtils::IsBindWidgetProperty`
(`Source/Editor/UMGEditor/Public/WidgetBlueprintEditorUtils.h:104`).

The familiar *"A required widget binding … was not found"* is emitted at
`WidgetBlueprintCompiler.cpp:1265`. This is why a compile-clean WBP subsumes the `BindWidget` contract —
the compiler already checked it, so a `Verify*` does not need to re-derive it.

## FKismetEditorUtilities::CompileBlueprint

`Source/Editor/UnrealEd/Public/Kismet2/KismetEditorUtilities.h:169` (flags enum at `:33-63`)

```cpp
static void CompileBlueprint(UBlueprint* BlueprintObj,
    EBlueprintCompileOptions CompileFlags = EBlueprintCompileOptions::None,
    FCompilerResultsLog* pResults = nullptr);
```

Despite the name, `FKismetEditorUtilities` lives in **UnrealEd**, not in the `Kismet` module — so
`Kismet`, `KismetCompiler` and `BlueprintGraph` are **not** needed in `Build.cs` just for this.

## FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified

`Source/Editor/UnrealEd/Public/Kismet2/BlueprintEditorUtils.h:307` — `static void (UBlueprint*)`.

## UPackage::SavePackage — headless

`Source/Runtime/CoreUObject/Public/UObject/Package.h:1201`

```cpp
static bool SavePackage(UPackage* InOuter, UObject* InAsset, const TCHAR* Filename,
                        const FSavePackageArgs& SaveArgs);   // keep SaveArgs.bSlowTask = false
```

**Headless-safe:** this, and `UEditorLoadingAndSavingUtils::SavePackages` (`FileHelpers.h:86`).
**NOT headless-safe:** `FEditorFileUtils::PromptForCheckoutAndSave` (`FileHelpers.h:530`) and every
`*WithDialog` variant — they block on UI that a `-RenderOffScreen` editor will never show.

## Build.cs modules for headless WBP authoring

`UMG` (widgets + slots) · `UMGEditor` (operation utils, `UWidgetBlueprint`, the compiler) · `UnrealEd`
(`FKismetEditorUtilities`, `FBlueprintEditorUtils`, `UBaseWidgetBlueprint`, save utils) · `CoreUObject`
(`SavePackage`) · `SlateCore` (`FMargin`, the alignment enums) · `AssetRegistry`.

A tool module that already depends on all of these needs **no** `Build.cs` change for a spec-compiler tool.
