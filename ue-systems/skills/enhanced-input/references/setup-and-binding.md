# Setup, contexts and binding (UE 5.8)

## 1. Module and plugin

- The `EnhancedInput` plugin is `EnabledByDefault`; nothing to add to the `.uproject` unless the project
  disables default plugins.
- `Build.cs`: `EnhancedInput` (and `InputCore` for `FKey`/`EKeys`). Put it in `PublicDependencyModuleNames`
  if IA/IMC types or `FInputActionValue` appear in public headers. Input-mode tags additionally need
  `GameplayTags`.
- Headers: `EnhancedInputComponent.h`, `EnhancedInputSubsystems.h`, `InputAction.h`, `InputMappingContext.h`,
  `InputActionValue.h`.

## 2. Project settings

`Config/DefaultInput.ini`, section `[/Script/Engine.InputSettings]` (Project Settings → Input → Default Classes):

```ini
DefaultPlayerInputClass=/Script/EnhancedInput.EnhancedPlayerInput
DefaultInputComponentClass=/Script/EnhancedInput.EnhancedInputComponent
```

The engine defaults are `UPlayerInput` and `UInputComponent`; templates set the two lines above. Without them:
the pawn receives a plain `UInputComponent` (the `Cast<UEnhancedInputComponent>` fails), and the local-player
subsystem's `GetPlayerInput()` returns null, so `AddMappingContext` does nothing and logs nothing.
A single pawn or controller can override with `OverrideInputComponentClass` / `OverridePlayerInputClass`.

Enhanced Input's own settings — `[/Script/EnhancedInput.EnhancedInputDeveloperSettings]` in `DefaultInput.ini`
(Project Settings → Engine → Enhanced Input): `DefaultMappingContexts` (applied to every local player when its
controller changes), `bEnableUserSettings` (default true), `bEnableInputModeFiltering` (default true),
`bSendTriggeredEventsWhenInputIsFlushed` (default true), `bShouldOnlyTriggerLastActionInChord` (default true),
`bEnableWorldSubsystem` (default false, experimental).

## 3. Assets

**Input Action** — one per intent. Key fields:

| Field | Default | Meaning |
|-------|---------|---------|
| `ValueType` | `Boolean` | Boolean / Axis1D (float) / Axis2D (FVector2D) / Axis3D (FVector). Every key value is cut to this type. |
| `Triggers`, `Modifiers` | empty | Action-level; combined with the mapping's own (see `triggers-and-modifiers.md`). |
| `bConsumeInput` | true | A mapping of this action blocks the same key in **lower-priority** contexts. |
| `bTriggerWhenPaused` | false | Without it the action never triggers while the game is paused. |
| `AccumulationBehavior` | `TakeHighestAbsoluteValue` | Several keys on one action: highest magnitude wins; `Cumulative` sums (W+S cancel out). |
| `bReserveAllMappings` | false | Advisory for mapping queries; not enforced by the rebuild. |
| `PlayerMappableKeySettings` | null | Makes mappings of this action remappable (see `remapping-and-ui.md`). |

**Input Mapping Context** — a list of `FEnhancedActionKeyMapping` (key, action, triggers, modifiers,
optional player-mappable settings). Several mappings may share a key inside one context. Other fields:
`InputModeFilterOptions` (project default query / custom / do not filter) and `RegistrationTrackingMode`
(`Untracked` default — one `RemoveMappingContext` removes it however many times it was added;
`CountRegistrations` — removed after as many removes as adds).

## 4. Priorities and consumption

Contexts are processed from the highest priority down. When a mapping's action has `bConsumeInput`, its key
is added to the "applied keys" after that context, and **lower-priority contexts' mappings of the same key are
dropped**. Mappings inside one context never hide each other. Mappings with a Chorded trigger never consume.
Adding the same `Untracked` context again does not duplicate it — it overwrites the stored priority.

Typical layout: gameplay 0, vehicle/aim overlay 1, UI/menu context higher.

## 5. Where to add contexts

The subsystem is per **local player**: `ULocalPlayer::GetSubsystem<UEnhancedInputLocalPlayerSubsystem>(PC->GetLocalPlayer())`.
It works only once the controller has its `PlayerInput`, which `APlayerController::InitInputSystem` creates when
the local player is attached. A remote client's controller on the server has no local player — guard with
`IsLocalController()` / `IsLocalPlayerController()`.

| Owner of the context | Add | Remove |
|----------------------|-----|--------|
| Whole session (UI, global keys) | PC `SetupInputComponent()` (runs from `InitInputSystem`, once per PC) — the `TP_ThirdPerson` template does this | never / PC `EndPlay` |
| Pawn-specific controls | `NotifyControllerChanged()` (runs on possess, unpossess, and on the client from `OnRep_Controller`) or `PawnClientRestart()` (local controllers only) | `NotifyControllerChanged()` for `PreviousController`, or `UnPossessed()` on the server |
| Ability / widget / vehicle seat | where it activates | where it deactivates — same owner |

Not in a pawn's constructor (no controller) and not in a bare `BeginPlay` (on a client the controller may not
be replicated yet; the call silently finds no local player).

```cpp
void AMyCharacter::NotifyControllerChanged()
{
	// PreviousController still points to the old one until Super updates it.
	if (const APlayerController* OldPC = Cast<APlayerController>(PreviousController))
	{
		if (auto* Subsystem = ULocalPlayer::GetSubsystem<UEnhancedInputLocalPlayerSubsystem>(OldPC->GetLocalPlayer()))
		{
			Subsystem->RemoveMappingContext(DefaultMappingContext);
		}
	}
	if (const APlayerController* PC = Cast<APlayerController>(GetController()); PC && PC->IsLocalController())
	{
		if (auto* Subsystem = ULocalPlayer::GetSubsystem<UEnhancedInputLocalPlayerSubsystem>(PC->GetLocalPlayer()))
		{
			Subsystem->AddMappingContext(DefaultMappingContext, /*Priority*/ 0);
		}
	}
	Super::NotifyControllerChanged();
}
```

`AddMappingContext` / `RemoveMappingContext` / `ClearAllMappings` / `SetInputMode` only **request** a rebuild;
the rebuild runs in the Enhanced Input module tick. Pass `FModifyContextOptions` with `bForceImmediately = true`
when the next line depends on the new mappings (one context — not in a loop). The subsystem's
`ControlMappingsRebuiltDelegate` fires after a rebuild.

`FModifyContextOptions::bIgnoreAllPressedKeysUntilRelease` (default true): a key already held when a new
mapping appears is ignored by Boolean actions until released and pressed again. Set false when a context is
swapped while the player keeps holding the key and the action must continue.

## 6. Binding in C++

```cpp
void AMyCharacter::SetupPlayerInputComponent(UInputComponent* PlayerInputComponent)
{
	Super::SetupPlayerInputComponent(PlayerInputComponent);

	UEnhancedInputComponent* Input = Cast<UEnhancedInputComponent>(PlayerInputComponent);
	if (!ensureMsgf(Input, TEXT("%s: not an Enhanced Input component - check DefaultInputComponentClass"), *GetName()))
	{
		return;
	}
	if (!ensure(MoveAction && JumpAction))
	{
		return; // BindAction(nullptr, ...) is accepted and never fires
	}
	Input->BindAction(MoveAction, ETriggerEvent::Triggered, this, &ThisClass::Move);   // void Move(const FInputActionValue&)
	Input->BindAction(JumpAction, ETriggerEvent::Started, this, &ACharacter::Jump);    // void()
	Input->BindAction(JumpAction, ETriggerEvent::Completed, this, &ACharacter::StopJumping);
}

void AMyCharacter::Move(const FInputActionValue& Value)
{
	const FVector2D Axis = Value.Get<FVector2D>(); // MoveAction.ValueType == Axis2D
	// ...
}
```

Handler signatures accepted by `BindAction`: `void()`, `void(const FInputActionValue&)`,
`void(const FInputActionInstance&)` (value plus elapsed/triggered time), or a `UFUNCTION` by name. There are
also `BindActionValueLambda`, `BindActionInstanceLambda`, and `BindActionValue(Action)` (no delegate; a binding
whose `GetValue()` you poll). Outside a callback: `UEnhancedPlayerInput::GetActionValue(Action)` or
`FindActionInstanceData(Action)`.

Legacy `BindAction(FName, …)`, `BindAxis`, `BindKey` are `= delete` on `UEnhancedInputComponent` unless the
module defines `ENHANCED_INPUT_ALLOW_LEGACY_BINDING=1`.

### Lifetime of bindings

- The pawn's `InputComponent` is created in `PawnClientRestart()` **only if it is null**, then
  `SetupPlayerInputComponent` runs on it; `UnPossessed()` destroys it. So binds in `SetupPlayerInputComponent`
  are fresh on every possession and never doubled.
- The PlayerController's `InputComponent` lives as long as the PC. Binding into it from `OnPossess`,
  `NotifyControllerChanged`, `BeginPlay` of a respawning actor, etc. stacks a new binding every time —
  `BindAction` appends without de-duplication. Bind there in `SetupInputComponent` only, or keep the returned
  `FEnhancedInputActionEventBinding&`'s handle (`GetHandle()`) and call `RemoveBindingByHandle` /
  `RemoveBinding`; `ClearBindingsForObject(Obj)` drops everything an object bound.
- Only `UEnhancedInputComponent`s get Enhanced Input events; a legacy component in the stack is ignored by
  the Enhanced Input pass.
- Input stack order: components pushed with `PushInputComponent` (highest first), then the PC's own, level
  script actors, and the possessed pawn's component last. A binding's `SetShouldConsume(true)` stops the same
  action's delegates on components further down the stack (CVar `EnhancedInput.EnableListenerConsumption`,
  default on).

## Verified at

- Plugin enabled by default — `Engine/Plugins/EnhancedInput/EnhancedInput.uplugin:13`
- Engine defaults are legacy classes — `Engine/Source/Runtime/Engine/Private/UserInterface/InputSettings.cpp:52-53`;
  template lines — `Templates/TP_ThirdPerson/Config/DefaultInput.ini:81-82`
- Subsystem player input is a cast of `PC->PlayerInput` — `EnhancedInput/Private/EnhancedInputSubsystems.cpp:73-84`;
  `AddMappingContext` does nothing without it — `EnhancedInputSubsystemInterface.cpp:260-304`
- Default contexts applied on controller change — `EnhancedInputSubsystems.cpp:43-71`
- Developer settings defaults — `EnhancedInput/Private/EnhancedInputDeveloperSettings.cpp:11-21`
- Action defaults (`bTriggerWhenPaused`, `bConsumeInput`, `ValueType`, `AccumulationBehavior`) —
  `EnhancedInput/Public/InputAction.h:92,96,116,127`; accumulation — `EnhancedPlayerInput.cpp:244-277`
- `Untracked` / `CountRegistrations` — `InputMappingContext.h:47-60,148`; `EnhancedInputSubsystemInterface.cpp:260-348`
- Priority sort and key consumption, chords never consume — `EnhancedInputSubsystemInterface.cpp:946-947,1041-1055,1091`
- Deferred rebuild, `bForceImmediately` — `EnhancedInputSubsystemInterface.cpp:430-440`; rebuild in module tick —
  `EnhancedInputModule.cpp:323-328`
- Held keys ignored on new mappings (Boolean only) — `EnhancedInputSubsystemInterface.cpp:1170-1183`;
  option doc — `EnhancedInputSubsystemInterface.h:57-76`
- `PlayerInput` created in `InitInputSystem`, `SetupInputComponent` called there —
  `Engine/Private/PlayerController.cpp:756-765`; only for local players — `PlayerController.cpp:5369-5377`
- PC component created once — `PlayerController.cpp:2649-2656`; stack order — `PlayerController.cpp:2668-2720`
- Pawn component created only if null, `SetupPlayerInputComponent` — `Engine/Private/Pawn.cpp:496-527`;
  destroyed in `UnPossessed` — `Pawn.cpp:713-736,800-807`
- `NotifyControllerChanged` from possess/unpossess/`OnRep_Controller`, `PreviousController` update —
  `Pawn.cpp:643,709,735,740-751`; `PreviousController` is public — `Classes/GameFramework/Pawn.h:203,215`
- Template adds contexts in PC `SetupInputComponent` — `Templates/TP_ThirdPerson/Source/TP_ThirdPerson/TP_ThirdPersonPlayerController.cpp:36-60`
- `BindAction` appends — `EnhancedInput/Public/EnhancedInputComponent.h:480-492`; handler signatures —
  `EnhancedInputComponent.h:24-33`; removal API — `EnhancedInputComponent.h:429-475`; legacy binds deleted —
  `EnhancedInputComponent.h:600-635`
- Only `UEnhancedInputComponent` processed; listener consumption — `EnhancedPlayerInput.cpp:734,839-844,900-905`
