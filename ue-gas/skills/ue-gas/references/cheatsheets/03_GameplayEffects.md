# 03. Gameplay Effects (GE)

Details — `GAS_WorkingReference.md` §5–7, full document §4.5.

## Duration
| Type | Changes | Effect tags | Cue |
|-----|--------|--------------|-----|
| `Instant` | BaseValue permanently (damage, healing, payment) | never granted | `Execute` |
| `Duration` | CurrentValue for a time | granted and removed | `Add`/`Remove` |
| `Infinite` | CurrentValue until removed (auras, equipment) | granted, removed manually | `Add`/`Remove` |

`Duration`/`Infinite` with a `Period` behave like `Instant` on every tick (DOT).

## Applying
```cpp
// to self
ASC->ApplyGameplayEffectToSelf(EffectClass.GetDefaultObject(), Level, ASC->MakeEffectContext());

// to a target
const FGameplayEffectSpecHandle Spec = ASC->MakeOutgoingSpec(EffectClass, Level, ASC->MakeEffectContext());
if (Spec.IsValid())
{
	ASC->ApplyGameplayEffectSpecToTarget(*Spec.Data.Get(), TargetASC);
}
```

## SetByCaller
1. In the GE: modifier → Magnitude Calculation Type `Set by Caller`, tag `Data.Damage`.
2. In code — the value **must** be set, otherwise an error and 0:
```cpp
Spec.Data->SetSetByCallerMagnitude(TAG_Data_Damage, 50.f);
```

## Modifiers add up, they do not multiply
`Multiply` 1.5 and 1.5 give ×2.0, not ×2.25; 0.5 and 0.5 give ×0. Formula and variants — `GAS_WorkingReference.md` §6.

## MMC
`UGameplayModMagnitudeCalculation`, override `CalculateBaseMagnitude_Implementation(const FGameplayEffectSpec&)`;
captured attributes go into `RelevantAttributesToCapture` in the constructor. Works with any duration.
