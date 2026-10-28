# New classes and Blueprint logic moved to C++

## A new class from a description

- Prefix by base: `A` actor, `U` object/component, `F` struct, `E` enum, `I`/`U` interface pair; the project's
  own prefix after it if it has one (look at neighbouring classes). File name = class name without the type
  prefix, header and source mirrored (`Public/`/`Private/` if the module uses them).
- Header: forward declarations instead of includes wherever a pointer/reference suffices; `.generated.h` last.
- Constructor in the `.cpp`: create components (`CreateDefaultSubobject`), set defaults,
  `PrimaryActorTick.bCanEverTick = false` unless the class really ticks (timers first). No mesh/material/sound
  assignment from code — those are typed `UPROPERTY` slots filled in the Blueprint or a data asset (SKILL.md
  «Asset references»).
- Designer-facing fields `protected`/`private` with `meta = (AllowPrivateAccess = "true")` when Blueprint must see
  them; every `UPROPERTY` gets a meaningful `Category` (the system's name, never a placeholder like `"Code"`).
- Manager / singleton → `references/subsystems-data.md`; data container → a data asset (same file); test class →
  the project's test conventions (ue-build-test).

## Blueprint graph → C++

Input is copied node text (`Begin Object Class=...`) or a description. Translate the behaviour, not node by node.

| Blueprint | C++ |
| --- | --- |
| `Branch` | `if` |
| `Get Player Character` | `UGameplayStatics::GetPlayerCharacter(GetWorld(), 0)` |
| `Spawn Actor from Class` | `GetWorld()->SpawnActor<T>(Class, Transform, Params)` |
| `Delay` / `Retriggerable Delay` | `FTimerManager::SetTimer` with a handle (re-setting the same handle = retrigger) |
| `Timeline` | `UTimelineComponent` driven by a `UCurveFloat`/`UCurveVector`/`UCurveLinearColor` asset slot — keep the curve; a plain timer loses the easing |
| `Print String` | `UE_LOG` with the class's category (never `LogTemp`); a debug-only print goes behind a switch (`references/logging.md`) |
| `Cast To X` in a hot path | cache in `BeginPlay` or call through an interface |
| `Is Valid` | `IsValid(Obj)`; a required reference failing it is a logged early return, not a silent skip |

- What is authored as cosmetics — VFX, sounds, animation montages, UI flourishes — stays in the Blueprint behind a
  `BlueprintImplementableEvent` (no C++ body) or `BlueprintNativeEvent` (C++ default the Blueprint may override).
  Hardcoding it in C++ takes it away from the people who tune it.
- Debug-only nodes (prints, draw debug) are not carried over as-is.
- A Blueprint-specific type gets its exact C++ counterpart (`FGameplayTag`, `TSubclassOf<T>`, `TSoftObjectPtr<T>`),
  not a string.
- After the move: the Blueprint now calls/derives from the C++ class; the old graph is deleted only once the
  Blueprint compiles and behaves the same (rename/remove rules — `references/refactoring.md`).
