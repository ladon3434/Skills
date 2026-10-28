# 04. Gameplay Abilities

Details — `GAS_WorkingReference.md` §9–11, full document §4.6–4.7.

## Instancing Policy (checked against UE 5.8)
- `InstancedPerActor` — **the default**: one instance per ASC, state lives between activations (reset it
  manually), task delegates can be bound.
- `InstancedPerExecution` — a new instance per activation; more expensive, instance replication is not supported.
- `NonInstanced` — **deprecated since 5.5** (`UE_DEPRECATED_FORGAME`). Do not use in new code.

## Granting and activating
Grant **on the server only** (`HasAuthority()`).
```cpp
ASC->GiveAbility(FGameplayAbilitySpec(AbilityClass, Level, InputID, SourceObject));
ASC->TryActivateAbilitiesByTag(FGameplayTagContainer(TAG_Ability_Dash));
```
By event: `UAbilitySystemBlueprintLibrary::SendGameplayEventToActor()` + `Triggers` on the ability.
Passive ability: `OnAvatarSet()` → `TryActivateAbility()`.

## Net Execution Policy
- `LocalPredicted` — the client runs at once, the server confirms (responsive input in a networked game).
- `ServerInitiated`, `ServerOnly`, `LocalOnly`.
- Single-player — `ServerOnly` / `LocalPredicted` behave the same; don't overcomplicate.

## Lifecycle
- `ActivateAbility()` → `CommitAbility()` (cost + cooldown; can fail) → `EndAbility()`.
- **Every branch must reach `EndAbility()`** (except passives) — otherwise the ability "hangs" active.

## AbilityTasks
```cpp
auto* Task = UAbilityTask_PlayMontageAndWait::CreatePlayMontageAndWaitProxy(this, NAME_None, Montage);
Task->OnCompleted.AddDynamic(this, &UMyAbility::OnMontageDone);
Task->OnBlendOut.AddDynamic(this, &UMyAbility::OnMontageDone);
Task->OnInterrupted.AddDynamic(this, &UMyAbility::OnMontageCancelled);
Task->OnCancelled.AddDynamic(this, &UMyAbility::OnMontageCancelled);
Task->ReadyForActivation(); // mandatory in C++
```
Limit — 1000 live tasks per game (CVar `AbilitySystem.AbilityTask.MaxCount`).

## Cost and Cooldown
Cost — an `Instant` GE with negative modifiers; Cooldown — a `Duration` GE with no modifiers and a unique tag in
Granted Tags: the ability checks the **tag**.
