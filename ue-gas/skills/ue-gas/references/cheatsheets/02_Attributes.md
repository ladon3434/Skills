# 02. Attributes and AttributeSet

Details — `GAS_WorkingReference.md` §4, full document §4.3–4.4.

## Declaration (C++ only)
```cpp
#define ATTRIBUTE_ACCESSORS(ClassName, PropertyName) \
	GAMEPLAYATTRIBUTE_PROPERTY_GETTER(ClassName, PropertyName) \
	GAMEPLAYATTRIBUTE_VALUE_GETTER(PropertyName) \
	GAMEPLAYATTRIBUTE_VALUE_SETTER(PropertyName) \
	GAMEPLAYATTRIBUTE_VALUE_INITTER(PropertyName)

UPROPERTY(BlueprintReadOnly, Category = "Health", ReplicatedUsing = OnRep_Health)
FGameplayAttributeData Health;
ATTRIBUTE_ACCESSORS(UMyAttributeSet, Health)
```
```cpp
void UMyAttributeSet::OnRep_Health(const FGameplayAttributeData& OldHealth)
{
	GAMEPLAYATTRIBUTE_REPNOTIFY(UMyAttributeSet, Health, OldHealth);
}

void UMyAttributeSet::GetLifetimeReplicatedProps(TArray<FLifetimeProperty>& OutLifetimeProps) const
{
	Super::GetLifetimeReplicatedProps(OutLifetimeProps);
	DOREPLIFETIME_CONDITION_NOTIFY(UMyAttributeSet, Health, COND_None, REPNOTIFY_Always);
}
```
Meta attributes (`Damage`) are not replicated: neither `OnRep` nor `DOREPLIFETIME`.

## BaseValue and CurrentValue
- **BaseValue** — the stored value; changed by `Instant` and periodic effects.
- **CurrentValue** — BaseValue + temporary `Duration`/`Infinite` modifiers.
- The maximum is a separate attribute (`MaxHealth`), not BaseValue.

## Clamping (checked against `AttributeSet.h`, UE 5.8)
| Function | What it changes | Used for |
|---------|------------|----------|
| `PreAttributeChange(Attribute, float& NewValue)` | CurrentValue (any source) | clamp `NewValue`; no events |
| `PreAttributeBaseChange(Attribute, float& NewValue) const` | BaseValue (when an aggregator exists) | clamp BaseValue; no events |
| `PostGameplayEffectExecute(Data)` | after an effect changed BaseValue | meta attributes, BaseValue clamping, events (death) |

`PreAttributeChange` alone is not enough: BaseValue goes past the limit. Recalculation in MMC/ExecCalc does not call
`PreAttributeChange` — clamp there again.

```cpp
void UMyAttributeSet::PreAttributeChange(const FGameplayAttribute& Attribute, float& NewValue)
{
	Super::PreAttributeChange(Attribute, NewValue);
	if (Attribute == GetHealthAttribute())
	{
		NewValue = FMath::Clamp(NewValue, 0.f, GetMaxHealth());
	}
}

void UMyAttributeSet::PostGameplayEffectExecute(const FGameplayEffectModCallbackData& Data)
{
	Super::PostGameplayEffectExecute(Data);
	if (Data.EvaluatedData.Attribute == GetDamageAttribute())
	{
		const float LocalDamage = GetDamage();
		SetDamage(0.f); // the meta attribute is zeroed at once
		if (LocalDamage > 0.f)
		{
			SetHealth(FMath::Clamp(GetHealth() - LocalDamage, 0.f, GetMaxHealth()));
			if (GetHealth() <= 0.f) { /* death */ }
		}
	}
}
```

## Initial values
An `Instant` effect with the starting values (Epic's recommendation) or `InitHealth(100.f)` from `ATTRIBUTE_ACCESSORS`.
Attributes change through effects or the AttributeSet's own setters, not by assigning fields from outside.
