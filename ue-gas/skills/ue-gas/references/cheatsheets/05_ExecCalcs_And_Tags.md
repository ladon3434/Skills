# 05. ExecCalc and Gameplay Tags

Details — `GAS_WorkingReference.md` §3, §8, full document §4.2, §4.5.12.

## ExecCalc
Complex calculations that change several attributes (damage minus armour minus resistances). Works **only with
`Instant` and periodic** effects, C++ only, not predicted.

```cpp
struct FMyDamageStatics // unique name per ExecCalc: these structs share one namespace
{
	DECLARE_ATTRIBUTE_CAPTUREDEF(Armor);
	DECLARE_ATTRIBUTE_CAPTUREDEF(Damage);

	FMyDamageStatics()
	{
		DEFINE_ATTRIBUTE_CAPTUREDEF(UMyAttributeSet, Armor, Target, false);
		DEFINE_ATTRIBUTE_CAPTUREDEF(UMyAttributeSet, Damage, Source, true);
	}
};

static const FMyDamageStatics& MyDamageStatics()
{
	static FMyDamageStatics Statics;
	return Statics;
}

UMyDamageExecCalc::UMyDamageExecCalc()
{
	RelevantAttributesToCapture.Add(MyDamageStatics().ArmorDef);
	RelevantAttributesToCapture.Add(MyDamageStatics().DamageDef);
}

void UMyDamageExecCalc::Execute_Implementation(const FGameplayEffectCustomExecutionParameters& Params,
	FGameplayEffectCustomExecutionOutput& OutExecutionOutput) const
{
	FAggregatorEvaluateParameters Eval;
	Eval.SourceTags = Params.GetOwningSpec().CapturedSourceTags.GetAggregatedTags();
	Eval.TargetTags = Params.GetOwningSpec().CapturedTargetTags.GetAggregatedTags();

	float Armor = 0.f;
	Params.AttemptCalculateCapturedAttributeMagnitude(MyDamageStatics().ArmorDef, Eval, Armor);
	Armor = FMath::Max(Armor, 0.f); // capture does not call PreAttributeChange — clamp here

	const float Damage = FMath::Max(0.f, /* ... */ 0.f - Armor);
	OutExecutionOutput.AddOutputModifier(
		FGameplayModifierEvaluatedData(UMyAttributeSet::GetDamageAttribute(), EGameplayModOp::Additive, Damage));
}
```

## Gameplay Tags
Hierarchical labels instead of state bools and enums. Native ones — the compiler catches typos:
```cpp
// .h
UE_DECLARE_GAMEPLAY_TAG_EXTERN(TAG_State_Stunned);
// .cpp
UE_DEFINE_GAMEPLAY_TAG(TAG_State_Stunned, "State.Stunned");
```
```cpp
if (ASC->HasMatchingGameplayTag(TAG_State_Stunned)) { /* ... */ }
ASC->RegisterGameplayTagEvent(TAG_State_Stunned, EGameplayTagEventType::NewOrRemoved)
	.AddUObject(this, &AMyActor::OnStunChanged);
```
A Cue tag must start with `GameplayCue.`.
