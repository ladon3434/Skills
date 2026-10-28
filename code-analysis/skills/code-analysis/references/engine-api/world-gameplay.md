---
grounded: 2026-09-05
---

# Engine API — world & gameplay framework

## UWorld::SetGameMode

`Source/Runtime/Engine/Classes/Engine/World.h:3951`. A headless test world has no game mode, so `GetAuthGameMode()` is empty; a test that needs it sets `DefaultGameMode` and calls `SetGameMode`.

## AActor::CustomTimeDilation

`Source/Runtime/Engine/Classes/GameFramework/Actor.h:798` (`float CustomTimeDilation`), applied in `Source/Runtime/Engine/Private/Actor.cpp:379` for the actor and in `FActorComponentTickFunction::ExecuteTickHelper` (`Actor.h:4890`) for its components: their ticks get `DeltaSeconds * CustomTimeDilation`, no clamp, so 0 stands a Tick-driven mover still. It does not reach timers, audio, Chaos physics or a batched Niagara system — a Niagara component takes its own `UNiagaraComponent::SetCustomTimeDilation`. `UGameplayStatics::SetGlobalTimeDilation` clamps to `AWorldSettings::MinGlobalTimeDilation..MaxGlobalTimeDilation` (`WorldSettings.cpp:347`; 0.0001..20 in `BaseGame.ini`); `FApp`/`UWorld::DeltaRealTimeSeconds` stays undilated. Grounded 2026-10-28.
