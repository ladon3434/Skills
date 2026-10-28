---
grounded: 2026-08-04
---

# Engine API cache — CommonUI runtime (UE 5.8)

Read by `engine-api.cmd <Symbol>` before the engine; a section heading is the lookup key.
Source: the UE 5.8 engine tree; paths relative to `Engine/Plugins/Runtime/CommonUI/Source/CommonUI/`; line numbers are hints.

---

## UCommonActivatableWidget

`Public/CommonActivatableWidget.h`. The input-config hook is what decides whether a pushed widget takes
control away from the game — a widget that must stay on screen without stealing input overrides it.

```cpp
// :108 — the native hook; TOptional means "no opinion", not "no input".
UE_API virtual TOptional<FUIInputConfig> GetDesiredInputConfig() const;

// :165 — the Blueprint-side counterpart, returning the config by value.
UE_API FUIInputConfig BP_GetDesiredInputConfig() const;
```

## UCommonActivatableWidget::NativeGetDesiredFocusTarget — who gives a viewport widget keyboard focus

```cpp
// Public/CommonActivatableWidget.h:150 — the native hook; :78 is the BlueprintCallable reader,
// :157 the BP counterpart. bSupportsActivationFocus (:209) defaults to true.
UE_API virtual UWidget* NativeGetDesiredFocusTarget() const;
```

A widget added with `AddToViewport()` + `ActivateWidget()` — rather than pushed onto a
`CommonActivatableWidgetStack` — still gets focus, and this is the hook that decides where. The action
router subscribes to `UCommonActivatableWidget::OnRebuilding` GLOBALLY
(`Private/Input/CommonUIActionRouterBase.cpp:322`), so ANY activatable widget enters its tree; one with no
activatable parent becomes a ROOT, and the router focuses the root's desired target on activation and
restores the previous root's on deactivation.

The consequence worth knowing before writing a `NativeOnKeyDown` on such a widget: without this override
there is no focus and the handler never fires, however focusable the widget is. `SetIsFocusable(true)` is
necessary and not sufficient. Returning `this` needs a `const_cast` — the hook is const and returns a
non-const `UWidget*`.

## FUIInputConfig

`Public/Input/UIActionBindingHandle.h:94`. Note the header — it is NOT in a `CommonUIInputTypes.h`, which
is the natural guess.

```cpp
// :103-105
UE_API FUIInputConfig();
UE_API FUIInputConfig(ECommonInputMode InInputMode, EMouseCaptureMode InMouseCaptureMode,
    bool bInHideCursorDuringViewportCapture = true);
UE_API FUIInputConfig(ECommonInputMode InInputMode, EMouseCaptureMode InMouseCaptureMode,
    EMouseLockMode InMouseLockMode, bool bInHideCursorDuringViewportCapture = true);

// :98-101 — accessors
ECommonInputMode GetInputMode() const;
EMouseCaptureMode GetMouseCaptureMode() const;
EMouseLockMode GetMouseLockMode() const;
bool HideCursorDuringViewportCapture() const;
```

## ECommonInputMode

`Plugins/Runtime/CommonUI/Source/CommonInput/Public/CommonInputModeTypes.h:11` — note it sits under CommonUI's `CommonInput`
module, NOT a separate `CommonInput` plugin.

```cpp
enum class ECommonInputMode : uint8
{
    Menu,   // Input is received by the UI only
    Game,   // Input is received by the Game only
    All,    // Input is received by UI and the Game
    MAX
};
```

`Menu` is CommonUI's default for a pushed screen and takes control away from the game. `All` is what an
overlay that must stay skippable without stopping play wants: the widget still gets its key events while
the player keeps driving.
