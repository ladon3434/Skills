# Widgets and CommonUI

## The C++ / WBP split

- Behaviour lives in C++: a `UUserWidget` (or `UCommonActivatableWidget`) subclass marked `UCLASS(Abstract)`,
  so the bare C++ class never shows up as a placeable widget and every concrete widget is a `WBP_*`.
- The `WBP_*` asset is visual only: layout, the bound elements, styling, animations.
- No procedural Slate fallback that builds the layout when the WBP is missing: one source of the layout.
- Bindings:
  ```cpp
  UPROPERTY(meta = (BindWidget))
  TObjectPtr<UTextBlock> Txt_Title;
  ```
  A required binding is `check()`ed in `NativeConstruct` — a missing element is a broken asset, not a state
  to tolerate. `BindWidgetOptional` only for a sub-widget that is optional by design (and then branch on it).
  The project usually has a naming convention for bound elements (e.g. `Typ_Name`); follow it — the name
  is the contract between the C++ and the designer.
- A widget that must be configured (a style, a data asset) validates that in `IsDataValid` like any other
  designer-set value.

## CommonUI input

- `UCommonActivatableWidget::GetDesiredInputConfig()` returns `TOptional<FUIInputConfig>`. When a screen
  returns nothing, the action router applies its default, which for a menu is `ECommonInputMode::Menu` —
  and Menu swallows game input. A screen states the input it needs:
  ```cpp
  TOptional<FUIInputConfig> UMyHud::GetDesiredInputConfig() const
  {
      return FUIInputConfig(ECommonInputMode::Game, EMouseCaptureMode::CapturePermanently);
  }
  ```
- **The recurring bug:** a screen that returns to play (pause menu, dialogue, inventory) must give the game
  back itself when it closes — unpause, `FInputModeGameOnly`, cursor hidden, mouse captured — in its
  deactivation path. Do not rely on the router or the stack below it to restore that: the stack may still
  count the popped widget as active during the same frame, and the input config of whatever is now on top
  may be Menu or unset.
- Push screens through the project's layer/stack (`UCommonActivatableWidgetStack` per layer); a widget added
  to the viewport directly bypasses the router and its input config.
- Check the CommonUI plugin is enabled and `CommonGameViewportClient` is the viewport client class
  (Project Settings → General Settings → Game Viewport Client Class); without it CommonUI input routing is
  inactive.
