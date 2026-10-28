---
name: enhanced-input
description: >
  Enhanced Input in Unreal Engine 5.8 C++ projects: set up (module, project settings, Input Actions, Mapping
  Contexts and priorities), add and remove contexts at the right point of possession, bind in C++ with the right
  ETriggerEvent, pick triggers and modifiers, player key remapping through UEnhancedInputUserSettings, CommonUI
  input routing, debugging and injecting input in tests; review input code against a checklist. Use for
  "Enhanced Input", "input action", "mapping context", "IMC priority", "BindAction", "ETriggerEvent", "hold / tap
  trigger", "rebind keys", "key remapping", "input not working", "action fires every frame", "input fires twice",
  "showdebug enhancedinput", "inject input in a test". Russian: «инпут», «маппинг клавиш», «переназначение
  клавиш», «не работает ввод», «экшен срабатывает каждый кадр», «ввод срабатывает дважды».
---

# enhanced-input — Enhanced Input in C++

Paths are relative to the skill folder (`<skill>`). Every non-obvious claim in `references/` ends with a
"Verified at" list pointing into the 5.8 engine source. Engine root — from the `.uproject`
`EngineAssociation`; plugin source — `<engine>/Engine/Plugins/EnhancedInput/Source/EnhancedInput/`. On a
different engine version re-check the claim you rely on there (with the code-analysis plugin —
`engine-api <Symbol>`). C++ idioms (`TObjectPtr`, log categories, data assets) — `ue-cpp-authoring`, if
installed, and the project's own rules win.

## The model in five lines

1. **Input Action** (`UInputAction`, data asset) — what the player wants; has a `ValueType`
   (Boolean / Axis1D / Axis2D / Axis3D) and optional action-level triggers and modifiers.
2. **Input Mapping Context** (`UInputMappingContext`) — key → action mappings with per-mapping triggers and
   modifiers. Contexts are applied **per local player** to the PlayerController's `UEnhancedPlayerInput`, with a
   priority; they survive pawn swaps.
3. **Binding** — `UEnhancedInputComponent::BindAction(Action, ETriggerEvent, Object, &Handler)` on an input
   component in the controller's input stack (pawn, controller, or a pushed component).
4. Each tick: key value → mapping modifiers → mapping triggers → action modifiers → action triggers → trigger
   *state* (None / Ongoing / Triggered) → *event* from the state change → your delegate.
5. Nothing is mapped until a context is added; nothing fires until something is bound.

## Modes

### 1. Set up or extend input
Read `references/setup-and-binding.md` (module, project settings, assets, where to add contexts and bind,
C++ skeleton). Then pick the event and triggers from `references/triggers-and-modifiers.md` — the state → event
table there decides which `ETriggerEvent` to bind, not intuition.

### 2. Remapping, UI, input modes
`references/remapping-and-ui.md`: player-mappable keys, `UEnhancedInputUserSettings`, saving, CommonUI
(`bEnableEnhancedInputSupport`, activatable-widget contexts, Menu/Game modes), Enhanced Input input-mode tags.

### 3. "Input does not work" / debugging / tests
`references/debugging-and-tests.md`: a symptom table, `showdebug enhancedinput`, the console commands,
`InjectInputForAction` and continuous injection in automation tests.

### 4. Review input code
A post-check without redesign. Report `file:line — problem → fix`.

- [ ] `Build.cs` has `EnhancedInput`; project settings use `EnhancedPlayerInput` and `EnhancedInputComponent`
      (engine defaults are the legacy `UPlayerInput` / `UInputComponent`).
- [ ] `SetupPlayerInputComponent` uses `Cast`/`CastChecked<UEnhancedInputComponent>` and fails loudly
      (log or `ensure`), not silently.
- [ ] Every IA / IMC `UPROPERTY` used in a bind is checked for null — `BindAction(nullptr, …)` is accepted and
      never fires.
- [ ] Contexts are added only for a **local** player controller and only once the controller exists
      (`PawnClientRestart`, `NotifyControllerChanged`, or the PC's `SetupInputComponent`) — not in a pawn's
      constructor or a bare `BeginPlay`.
- [ ] Every context a pawn/ability/widget adds is removed by the same owner on the way out (unpossess,
      `EndPlay`, deactivation). Contexts live on the controller and outlive the pawn.
- [ ] No binds on a persistent component (the PlayerController's `InputComponent`) from code that runs on
      every possession — `BindAction` appends, a second call means the handler fires twice. Bind once, or keep
      the returned handle and `RemoveBinding` it.
- [ ] One-shot actions (jump, interact, fire-once) are bound to `Started`, or the action has a
      `Pressed` / `Tap` / `Released` trigger. `Triggered` with no trigger fires **every tick** while held.
- [ ] Axis handlers bound to `Triggered` do not expect a final zero: when the stick returns to rest the
      handler is not called — reset in a `Completed` binding if state is kept.
- [ ] A hold-to-confirm action handles `Canceled` (released early) as well as `Triggered`.
- [ ] The handler reads the value with the action's own type (`Get<FVector2D>()` on an Axis2D action);
      a mismatch silently returns zeros in the missing components.
- [ ] One-key-to-Y mappings on 2D actions use `Swizzle Input Axis Values` (YXZ), opposite keys use `Negate`.
- [ ] Priorities are deliberate: a higher context with `bConsumeInput` (default true) hides the same key
      from lower contexts.
- [ ] Mapping is not split across languages: C++ binds an action whose context is added only by some
      Blueprint graph — move the `AddMappingContext` next to the bind, or assert with `HasMappingContext`.
- [ ] No new code on deprecated API: `UInputTriggerCombo` (deprecated in 5.8), `UPlayerMappableInputConfig`
      (deprecated since 5.3 — use `UEnhancedInputUserSettings`).
- [ ] Remapping: mapping has `PlayerMappableKeySettings` with a unique `Name`, the context is registered with
      the user settings, `MapPlayerKey`'s `FailureReason` is checked, settings are saved explicitly.

## Traps (details and sources in the references)

- **Context added, still nothing** — the PlayerController's `PlayerInput` is not `UEnhancedPlayerInput`
  (project setting), so the subsystem has no player input and `AddMappingContext` is a silent no-op.
- **Mappings are rebuilt later, not in the call** — `AddMappingContext` / `RemoveMappingContext` only request a
  rebuild; it happens in the module tick. `HasMappingContext` is true at once, `QueryKeysMappedToAction` is
  not, unless `FModifyContextOptions::bForceImmediately`.
- **A key held while a context is added is ignored until re-pressed** (Boolean actions, default
  `bIgnoreAllPressedKeysUntilRelease = true`).
- **`Pressed` / `Hold(bIsOneShot)` → `Completed` arrives the next tick while the key is still held** —
  "Completed" means "trigger went back to None", not "key released".
- **`Started` and `Triggered` in the same tick** for instant triggers; `Started` delegates fire first.
- **Pause** — an action does not trigger while the game is paused unless `bTriggerWhenPaused` is set on it.
- **Removing a context mid-press** delivers a closing `Completed`/`Canceled` to the handlers.
- **`SetInputMode` replaces the tag container** — dropping `EnhancedInput.Modes.Default` disables every
  context that uses the project default query. Prefer `AppendTagsToInputMode` / `RemoveTagsFromInputMode`.
- **CommonUI Menu mode blocks game input only through `UCommonGameViewportClient`**; the activatable widget's
  `InputMapping` works only with CommonInput's `bEnableEnhancedInputSupport`.
- **`showdebug enhancedinput` shows "Debug Target is not valid"** without a pawn possessed by a local player,
  and nothing at all without a HUD.
- **One `InjectInputForAction` call is a one-tick press** — it is released on the next input tick unless
  injected again; for a hold use continuous injection.

## Sources
Engine source only (UE 5.8): `Engine/Plugins/EnhancedInput/Source/`, `Engine/Source/Runtime/Engine/`
(Pawn, PlayerController, InputSettings), `Engine/Plugins/Runtime/CommonUI/Source/`, the `TP_ThirdPerson`
template. Each reference ends with its "Verified at" list.
