# 01. Ability System Component (ASC)

Details — `GAS_WorkingReference.md` §2, full document §4.1.

## IAbilitySystemInterface
The ASC owner and the avatar implement `IAbilitySystemInterface` — GAS finds an actor's ASC through it.
```cpp
class AMyCharacter : public ACharacter, public IAbilitySystemInterface
{
	virtual UAbilitySystemComponent* GetAbilitySystemComponent() const override;
};
```

## OwnerActor and AvatarActor
- **OwnerActor** — the actor the component sits on: `PlayerState` (attributes and effects survive pawn death) or the
  `Character`/actor itself.
- **AvatarActor** — the physical representation in the world (`Pawn`/`Character`).

## Creation — C++ only, in the owner's constructor
```cpp
AbilitySystemComponent = CreateDefaultSubobject<UAbilitySystemComponent>(TEXT("AbilitySystemComponent"));
AbilitySystemComponent->SetIsReplicated(true);
AbilitySystemComponent->SetReplicationMode(EGameplayEffectReplicationMode::Mixed);
```

## Replication mode
| Mode | For | What replicates |
|-------|------|-------------------|
| `Full` | single-player | all GEs to everyone |
| `Mixed` | networked player | owner — all GEs; others — tags and Cues. The owner of the ASC's owner must be a controller |
| `Minimal` | networked AI | GEs to nobody, tags and Cues only |

## Initialisation: `InitAbilityActorInfo(Owner, Avatar)` — after the controller is assigned
| Where the ASC lives | Server | Client |
|---------------|--------|--------|
| `PlayerState` (player) | `Pawn::PossessedBy()` | `Pawn::OnRep_PlayerState()` |
| The player's `Pawn` | `Pawn::PossessedBy()` + `SetOwner(NewController)` | `PlayerController::AcknowledgePossession()` |
| `Pawn`/actor without a player (AI, destructible) | `BeginPlay()` (or `PossessedBy()`) | `BeginPlay()` |

A single-player game only needs the server path.

```cpp
// ASC on the PlayerState
void AMyCharacter::PossessedBy(AController* NewController)
{
	Super::PossessedBy(NewController);
	if (auto* PS = GetPlayerState<AMyPlayerState>())
	{
		PS->GetAbilitySystemComponent()->InitAbilityActorInfo(PS, this);
	}
}

void AMyCharacter::OnRep_PlayerState()
{
	Super::OnRep_PlayerState();
	if (auto* PS = GetPlayerState<AMyPlayerState>())
	{
		PS->GetAbilitySystemComponent()->InitAbilityActorInfo(PS, this);
	}
}
```
