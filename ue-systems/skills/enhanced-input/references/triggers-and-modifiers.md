# Trigger events, triggers, modifiers, value types (UE 5.8)

## 1. From trigger state to ETriggerEvent

Every tick each action ends up in a trigger **state**: `None`, `Ongoing` or `Triggered`. The **event** your
delegate is bound to is derived from the change between last tick's state and this tick's:

| Last → New | Event raised |
|------------|--------------|
| None → Ongoing | `Started` |
| None → Triggered | `Started` **and** `Triggered` (same tick; `Started` delegates run first) |
| Ongoing → Ongoing | `Ongoing` |
| Ongoing → Triggered | `Triggered` |
| Ongoing → None | `Canceled` |
| Triggered → Triggered | `Triggered` (again, every tick) |
| Triggered → Ongoing | `Ongoing` |
| Triggered → None | `Completed` |

Consequences:
- `Completed` means "the state left Triggered", **not** "the key was released". With a trigger that returns
  to None while the key is held (`Pressed`, `Hold` with `bIsOneShot`), `Completed` arrives one tick after
  `Triggered`, with the key still down.
- `Triggered` repeats every tick for as long as the state stays Triggered — with no trigger or `Down`, that is
  every tick the key is actuated.
- An action with no change and no key event this tick raises nothing — an axis that returns to zero gives one
  `Completed` and then silence, never a `Triggered` with zero.
- The engine comment on `Completed`: it will not fire if any trigger reports Ongoing in the same tick (e.g. a
  Hold + Pressed combination raises only `Ongoing`) — prefer two actions over a clever single one.

## 2. Built-in triggers — event sequences

No triggers at all = "Down with a zero threshold": Triggered while the value is non-zero.

| Trigger | Press | While held | Release | Bind for |
|---------|-------|-----------|---------|----------|
| *(none)* / `Down` | Started + Triggered | Triggered every tick | Completed | movement, look, continuous fire |
| `Pressed` | Started + Triggered | — (next tick: **Completed**) | — | one-shot on press |
| `Released` | Started (Ongoing) | Ongoing | Triggered, next tick Completed | one-shot on release |
| `Hold` (`HoldTimeThreshold` 1.0, `bIsOneShot` false) | Started | Ongoing until threshold, then Triggered every tick | before threshold: **Canceled**; after: Completed | charge, hold-to-confirm |
| `Hold` with `bIsOneShot` | Started | Ongoing, one Triggered at threshold, next tick Completed | before threshold: Canceled | "hold 1 s to interact" |
| `HoldAndRelease` (0.5) | Started | Ongoing | after threshold: Triggered; before: Canceled | release-to-throw after charge |
| `Tap` (`TapReleaseTimeThreshold` 0.2) | Started | Ongoing; past threshold → Canceled | within threshold: Triggered | tap vs hold on one key (pair with a Hold action) |
| `RepeatedTap` (2 taps, `RepeatDelay` 0.5) | Started | Ongoing between taps | Triggered on the Nth tap | double tap |
| `Pulse` (`Interval` 1.0, `bTriggerOnStart` true, `TriggerLimit` 0) | Started + Triggered | Triggered every `Interval` | Canceled (Completed only at the limit or right after a pulse) | auto-repeat |
| `Chorded Action` (`ChordAction`) | — | Triggered only while `ChordAction` is Triggered | — | Shift+key style modifiers |
| `Combo (Beta)` | — | — | — | **deprecated in 5.8** — do not use in new code |

All timed triggers count real (non-dilated) time unless `bAffectedByTimeDilation` is set.

### How several triggers combine
- Each trigger is **Explicit** (default), **Implicit** or **Blocker**. The state is Triggered when at least one
  explicit trigger is triggered (if any exist) **and** all implicit ones are; any blocker in Triggered blocks.
  `Chorded Action` is implicit, so it gates whatever explicit triggers sit next to it.
- Mapping-level triggers (in the IMC) and action-level triggers (in the IA) are both evaluated; when the
  mapping has triggers, the final state is the lower of the two.
- Chords: the rebuild puts mappings of chording actions first and injects a blocker into lower mappings of the
  **same key**, so `Shift+E` (chorded) suppresses a plain `E` mapping while Shift is held. With
  `bShouldOnlyTriggerLastActionInChord` (default true) the chording action's own delegates (the Shift action)
  are skipped in the tick the chorded action triggers. The chording action must itself be mapped in an active
  context.

### Which event for which job

| Job | Bind | Trigger on the mapping/action |
|-----|------|-------------------------------|
| Move / look (axis) | `Triggered` | none (+ DeadZone on sticks) |
| Jump start / stop | `Started` / `Completed` | none |
| Interact once | `Started`, or `Triggered` | `Pressed` if `Triggered` |
| Hold to confirm | `Triggered` (+ `Canceled` for UI feedback, `Ongoing` for progress via `FInputActionInstance::GetElapsedTime()`) | `Hold`, `bIsOneShot` |
| Tap = dodge, hold = sprint on one key | two actions on the same key: Tap → dodge `Triggered`; Hold → sprint `Triggered`/`Completed` | `Tap` / `Hold` |
| Aim while held | `Started` / `Completed` (or `Triggered`/`Completed`) | none |

## 3. Modifiers

Order: mapping modifiers (IMC) first, then action modifiers (IA), each list in array order.

| Modifier | Default | Use |
|----------|---------|-----|
| `Negate` | X, Y, Z all on | S / A on a movement axis; invert look Y (uncheck X, Z) |
| `Swizzle Input Axis Values` | `YXZ` | put a 1D key on the Y axis of a 2D action (W/S on Move) |
| `Dead Zone` | Lower 0.2, Upper 1.0, `Smoothed Radial` | sticks; remaps [Lower, Upper] → [0, 1]; `Axial` per axis, `UnscaledRadial` without smoothing |
| `Scalar` | (1,1,1) | sensitivity; does nothing on Boolean actions |
| `Scale By Delta Time`, `Smooth`, `Smooth Delta`, `Response Curve - Exponential / User Defined`, `FOV Scaling`, `To World Space` | — | as named |

The classic WASD → Axis2D `Move`:

| Key | Modifiers |
|-----|-----------|
| D | — |
| A | Negate |
| W | Swizzle (YXZ) |
| S | Swizzle (YXZ), Negate |
| Gamepad Left Thumbstick 2D-Axis | Dead Zone |

Legacy axis properties (`AxisConfig` dead zone / sensitivity / invert) are turned into modifiers in front of
yours — by default for mouse keys only.

## 4. Value types

- The action's `ValueType` wins: each key's raw value is cut to it before modifiers — Boolean/Axis1D keep X,
  Axis2D keeps X and Y. A 2D stick mapped to an Axis1D action loses Y; a key mapped to Axis2D lands on X.
- `FInputActionValue::Get<T>()` does not check the type: `Get<FVector2D>()` on an Axis1D value returns `(X, 0)`,
  `Get<bool>()` is "any component non-zero". A wrong `Get` is silent.
- `IEnhancedInputSubsystemInterface::QueryMapKeyInContextSet` reports `ForcesTypePromotion` /
  `ForcesTypeDemotion` for a key whose natural type differs from the action's (Boolean → Axis1D is not
  reported) — useful in a remap UI or a validation test.
- The actuation threshold of the built-in triggers is a magnitude (`ActuationThreshold`, default 0.5): a stick
  at 0.3 with a `Pressed` trigger never fires.

## Verified at

- State → event table — `EnhancedInput/Private/EnhancedPlayerInput.cpp:120-176`; event enum and the `Completed`
  note — `EnhancedInput/Public/InputTriggers.h:34-56`
- Started fires before Triggered in a StartedAndTriggered tick — `EnhancedPlayerInput.cpp:792-806,868-882`
- No evaluation without a key event (unless an always-tick trigger) — `EnhancedPlayerInput.cpp:224-226`;
  analog keys pulse while non-zero — `EnhancedPlayerInput.cpp:594-601`
- No triggers → Triggered while non-zero — `EnhancedPlayerInput.cpp:241`
- Trigger behaviour: Down/Pressed/Released — `EnhancedInput/Private/InputTriggers.cpp:154-181`; Hold —
  `InputTriggers.cpp:183-197`; HoldAndRelease — `:209-225`; Tap — `:227-246`; RepeatedTap — `:248-300`;
  Pulse — `:346-375`; Chord — `:393-398`; timed base Ongoing while actuated — `:114-131`
- Trigger defaults — `InputTriggers.h:130` (threshold), `:245` (time dilation), `:334,338` (Hold), `:358`
  (HoldAndRelease), `:378` (Tap), `:411,419,423` (RepeatedTap), `:473,477,481` (Pulse)
- Combo deprecated in 5.8 — `InputTriggers.h:530,551,571`
- Explicit/implicit/blocker rules — `InputTriggers.h:65-80,149-152`, evaluation —
  `EnhancedInput/Private/InputAction.cpp:86-128`; Chorded is implicit — `InputTriggers.h:504`
- Mapping vs action trigger state combined with `Min` — `EnhancedPlayerInput.cpp:692-695`
- Chord ordering and blockers — `EnhancedInputSubsystemInterface.cpp:579-612,776-884`; last-action-only rule —
  `EnhancedPlayerInput.cpp:846-861`
- Pause gate — `EnhancedPlayerInput.cpp:697-702`
- Modifier order — `EnhancedInput/Public/InputAction.h:136-145`; defaults — `InputModifiers.h:182,190,193,231,259-264,420`;
  Scalar no-op on Boolean — `InputModifiers.h:228`; Swizzle meaning — `InputModifiers.h:390-405`
- Axis properties → modifiers, mouse only by default — `EnhancedInputSubsystemInterface.cpp:614-690`
- Value cut to the action type — `EnhancedPlayerInput.cpp:234-235`, `EnhancedInput/Public/InputActionValue.h:42-65`;
  unchecked `Get` — `InputActionValue.h:204-227`
- Type mismatch report — `EnhancedInputSubsystemInterface.cpp:473-482`
