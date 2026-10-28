# Debugging and testing Enhanced Input (UE 5.8)

## 1. "Input does not work" — by symptom

| Symptom | Likely cause | Check |
|---------|--------------|-------|
| Nothing fires, no log | Project still on `UPlayerInput` / `UInputComponent` | `DefaultInput.ini` default classes; `Cast<UEnhancedInputComponent>` result |
| Nothing fires, component is Enhanced | Context never added for this player, or added before the controller existed | `showdebug enhancedinput` lists applied contexts; `HasMappingContext` |
| Works in standalone, not on a client | Context added in `BeginPlay`/`PossessedBy` (server-only or before the controller replicates) | add in `NotifyControllerChanged` / `PawnClientRestart`, local controllers only |
| Fires twice | `BindAction` ran twice on a persistent component (PC re-possession path), or two contexts map the key to two actions that call the same code | count bindings: `GetActionEventBindings().Num()`; showdebug |
| Fires every frame | Bound to `Triggered` with no trigger / `Down` | bind `Started` or add `Pressed` |
| Hold never fires | Released before `HoldTimeThreshold` → `Canceled` | bind `Canceled` to see it; showdebug shows `Hold:x/y` |
| One key does nothing while another context is up | Higher-priority context maps the same key with `bConsumeInput` | priorities in showdebug |
| Plain key dead while a modifier key is held | Chord blocker from a `Chorded Action` mapping on the same key | expected; move the chord or the plain action |
| Key ignored right after a context switch | `bIgnoreAllPressedKeysUntilRelease` (Boolean actions) | release and press again, or set the option false |
| Nothing fires while paused | Action without `bTriggerWhenPaused` | IA asset |
| Y of the stick is always 0 | Action is Axis1D, or the handler does `Get<float>()` | `ValueType`, the `Get<T>` in the handler |
| W moves sideways | Missing Swizzle (YXZ) on W/S | IMC modifiers |
| Remap does not stick after restart | `SaveSettings` never called | user settings |
| UI open, character still moves | No `UCommonGameViewportClient`, or Menu mode with viewport mouse capture | `GameViewportClientClass`; input config |
| Context from a CommonUI widget never applies | `bEnableEnhancedInputSupport` off | Common Input settings |
| Contexts all stopped after a mode change | `SetInputMode` dropped `EnhancedInput.Modes.Default` | `GetInputMode()` |

## 2. Tools

- **`showdebug enhancedinput`** — the current input mode, applied contexts with priority and tracking mode,
  actions with their current trigger event, elapsed/triggered time and value, trigger debug states
  (`Hold:0.40/1.00`), and keys. On a player still using the legacy classes it says so ("This player does not
  support Enhanced Input…").
  Needs a HUD (the GameMode's `HUDClass` not None), a non-Shipping build (`ENABLE_DRAW_DEBUG`), and the debug
  target must be a pawn possessed by a local player — otherwise it prints "Debug Target is not valid".
  `showdebug WorldSubsystemInput` — the experimental world subsystem.
- Filters: `EnhancedInput.Debug.InputActionFilter <A,B>`, `EnhancedInput.Debug.ContextMappingFilter <IMC,…>`,
  `EnhancedInput.Debug.ShowKeyboardKeys / ShowGamepadKeys / ShowTouchKeys 0|1`.
- **Forced input from the console** (cheat commands, first player controller):
  `Input.+action <ActionAssetName> [value]` (value: `true`, `0.4`, `"X=1.0, Y=-2.0"`; default true) /
  `Input.-action <Name>`; `Input.+key <Key> [value]` / `Input.-key <Key>`. Forced values are re-injected every
  tick until removed.
- `log LogEnhancedInput Verbose` — rebuild decisions (skipped contexts by input mode, keys ignored until
  release, consumed listeners).
- `EnhancedInput.DumpKeyProfileToLog`, `EnhancedInput.SaveKeyProfilesToSlot`, `EnhancedInput.SetActiveKeyProfile <Id>`.
- CVars with behaviour switches (leave at default unless chasing an engine bug):
  `EnhancedInput.EnableListenerConsumption`, `EnhancedInput.OnlyTriggerLastActionInChord`,
  `EnhancedInput.ReconcileRemovedMappingDelegates`, `EnhancedInput.DetectSubTickTapsForNonAxisInputs`,
  `EnhancedInput.IgnoreHeldDigitalActionKeysOnFlush`, `EnhancedInput.EnableDefaultMappingContexts`.

## 3. Injecting input (gameplay code and tests)

Injection feeds a value straight into an action — no key, no IMC needed — and runs it through the
triggers/modifiers you pass **plus the action's own** (IMC mapping-level triggers/modifiers are not applied).

```cpp
UEnhancedInputLocalPlayerSubsystem* Subsystem =
	ULocalPlayer::GetSubsystem<UEnhancedInputLocalPlayerSubsystem>(PC->GetLocalPlayer());

Subsystem->InjectInputForAction(JumpAction, FInputActionValue(true), {}, {});            // one tick
Subsystem->InjectInputVectorForAction(MoveAction, FVector(0, 1, 0), {}, {});            // value cut to the action type

Subsystem->StartContinuousInputInjectionForAction(MoveAction, FInputActionValue(FVector2D(0, 1)), {}, {}); // held
Subsystem->UpdateValueOfContinuousInputInjectionForAction(MoveAction, FInputActionValue(FVector2D(1, 0))); // keeps trigger state
Subsystem->StopContinuousInputInjectionForAction(MoveAction);
```

Rules (from the player-input tick):
- An injection is consumed by the **next** input tick of that player; injecting after the tick has no effect
  until the following one.
- One `InjectInputForAction` call = pressed for one tick; on the next tick without a fresh injection the action
  is "released" (zero value) — so you get `Started`/`Triggered`, then `Completed`. A `Hold` trigger therefore
  needs continuous injection (or an injection every tick) for longer than its threshold.
- Works for actions that are not mapped at all; the bound delegates still need an Enhanced Input component in
  the player's input stack.
- Paused game: same `bTriggerWhenPaused` rule as real keys.
- `InjectInputForPlayerMapping(MappingName, …)` resolves the action through the user settings (fails with a
  warning if user settings are off or the name is unknown).

### Automation tests

The engine's own input test framework (`InputEditor/Private/Tests/InputTestFramework.h`) is private to the
`InputEditor` module — do not include it; write the test against a real world:
1. A PIE/game-world test (how to write and run one — `ue-build-test`, if installed): spawn or reuse the local
   player controller, possess the pawn under test, make sure the context is added (or rely on injection, which
   needs no context).
2. Each frame of the scenario: inject (or start continuous injection), then advance at least one frame before
   asserting — the delegate runs during the next player-input tick.
3. Assert on the gameplay result (velocity, ability activated, state flag) rather than on the delegate call
   count; for trigger semantics assert `UEnhancedPlayerInput::FindActionInstanceData(Action)->GetTriggerEvent()`.
4. Stop continuous injections in teardown; they live on the subsystem and survive the test otherwise.

For a key-level test (exercising the IMC mapping and its modifiers), forced keys are the console path
(`Input.+key`), or `APlayerController::InputKey` with simulated `FInputKeyEventArgs`, which is what the forced-key
path itself calls.

## Verified at

- `showdebug` hook: HUD delegate under `ENABLE_DRAW_DEBUG`, debug-target requirement and message —
  `EnhancedInput/Private/EnhancedInputModule.cpp:247-251,332-368`; what it prints —
  `EnhancedInputSubsystemInterfaceDebug.cpp:97,190-215,394,429`
- Verbose log lines — `EnhancedInputSubsystemInterface.cpp:982`, `EnhancedPlayerInput.cpp:322,587,842`
- Debug CVars — `EnhancedInput/Private/EnhancedInputSubsystemInterfaceDebug.cpp:20-43`; behaviour CVars —
  `EnhancedPlayerInput.cpp:20-50`, `EnhancedInputSubsystems.cpp:28-34`
- Console commands, cheat flag, value parsing, first PC — `EnhancedInputModule.cpp:66-104,106-140,252-279`
- Forced input re-injected each tick — `EnhancedInputSubsystemInterface.cpp:1238-1284`; module tick —
  `EnhancedInputModule.cpp:323-328`
- Key-profile commands — `Private/UserSettings/EnhancedInputUserSettings.cpp:92-105`
- Log category — `EnhancedInput/Public/EnhancedInputModule.h:15`
- Injection API and "action modifiers and triggers on top" — `EnhancedInput/Public/EnhancedInputSubsystemInterface.h:143-246`;
  vector injection cut to the action type — `EnhancedInputSubsystemInterface.cpp:136-140`
- Injected input processed with only the passed triggers/modifiers, then action-level ones —
  `EnhancedPlayerInput.cpp:646-666,679-695`
- Auto-release when not re-injected — `EnhancedPlayerInput.cpp:619-644`
- Continuous injection keeps trigger state on value update — `EnhancedInputSubsystemInterface.cpp:147-154,175-181,202-205`
- Post-tick injection applies next tick; unmapped action works — `InputEditor/Private/Tests/InputSystemTest.cpp:149-188`
- Player-mapping injection needs user settings — `EnhancedInputSubsystemInterface.cpp:231-249`
- Engine test framework is private — `InputEditor/Private/Tests/InputTestFramework.h`
- Forced keys go through `APlayerController::InputKey` — `EnhancedInputSubsystemInterface.cpp:1205-1236,1268-1278`
