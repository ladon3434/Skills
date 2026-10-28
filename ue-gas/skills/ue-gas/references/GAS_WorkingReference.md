# GAS — working digest

A condensed version of [GASDocumentation_Tranek.md](GASDocumentation_Tranek.md) (3705 lines) — only what you need to
make decisions and avoid the known pitfalls. Links like **§4.5.4** point to a section number of the full document:
the details, complete code examples and screenshots are there.

Checked against the GAS source in UE 5.8 where the engine diverged from the Tranek document (which describes 5.3):
such places are marked "5.5+" / "5.8".

**How to work:** look for the answer here first. If it is not here, is incomplete, or the task goes beyond the
section — **open the full document at the given §** and read there. Do not guess the GAS API from memory: versions
differ a lot in details, and the cost of a mistake is a mechanic that silently doesn't work.

## Contents

1. [What a single-player game needs](#1)
2. [ASC — the heart of the system](#2)
3. [GameplayTags](#3)
4. [Attributes and AttributeSet](#4)
5. [GameplayEffects](#5)
6. [The modifier aggregation formula and its traps](#6)
7. [Spec, Context, SetByCaller](#7)
8. [MMC and ExecCalc — which to choose](#8)
9. [Cost and Cooldown](#9)
10. [GameplayAbilities](#10)
11. [AbilityTasks](#11)
12. [GameplayCues](#12)
13. [Targeting and TargetData](#13)
14. [Debugging](#14)
15. [Diagnosis by symptom](#15)
16. [What the digest leaves out](#16)

---

<a name="1"></a>
## 1. What a single-player game needs

First find out whether the game is networked (the project's design document, sessions/replication in the code). If
it is **single-player**, that removes roughly half of GAS's complexity. Keep this in mind while reading the full
document: it is written for multiplayer, and a large part of it does not apply to a single-player game. For a
networked game the section below is the opposite — a list of what it cannot work without.

**A single-player game can ignore entirely:**

| Topic | Why it is not needed | §  |
|------|-----------------|----|
| Prediction, Prediction Key, Scoped Prediction Windows, `WaitNetSync` | Prediction exists so the client doesn't wait for the server. There is no client. | §4.10 |
| Replication Mode `Mixed` / `Minimal` | A single-player game uses `Full`. | §4.1.1 |
| `Net Execution Policy` other than `Server Only` | A single-player game is always `Server Only`. | §4.6.8 |
| `Net Security Policy` | Protection against cheating clients. | §4.6.16 |
| Ability Batching, GameplayCue Batching | RPC count optimisation. | §4.6.15, §4.8.7 |
| Attribute Proxy Replication, ASC Lazy Loading | Fortnite optimisations for hundreds of players. | §7.4, §7.5 |
| Predictive actor spawning | Same. | §4.10.3 |

**What remains and is the core of the work:** ASC, tags, attributes and their clamping, GameplayEffects with their
modifiers, MMC/ExecCalc, cost and cooldown, abilities, AbilityTasks, GameplayCues.

**One important consequence.** With no prediction, the main restriction on `ExecutionCalculation` — "it cannot be
predicted" — disappears. So in a single-player game **ExecCalc can be used freely wherever** it is more convenient —
in multiplayer it is a trade-off.

---

<a name="2"></a>
## 2. ASC — the heart of the system

`UAbilitySystemComponent` is a `UActorComponent`. Any actor that needs abilities, attributes or effects must have
an ASC. **§4.1**

Two roles that are easy to mix up:

- **OwnerActor** — the actor the component sits on;
- **AvatarActor** — the physical representation in the world.

They can be the same (a simple AI unit) or different (ASC on the `PlayerState`, avatar is the `Character`).
The ASC goes on the `PlayerState` when attributes and effects must survive a respawn. Both actors must implement
`IAbilitySystemInterface` with `GetAbilitySystemComponent()` — that is how ASCs find each other.

**Creation — C++ only**, in the OwnerActor's constructor:

```cpp
AbilitySystemComponent = CreateDefaultSubobject<UAbilitySystemComponent>(TEXT("AbilitySystemComponent"));
AbilitySystemComponent->SetIsReplicated(true);
```

**Initialisation** — `InitAbilityActorInfo(OwnerActor, AvatarActor)` after the controller is assigned, on the
server and on the client. A single-player game only needs the server path. **§4.1.2**

| Where the ASC lives | Server | Client |
|---------------|--------|--------|
| `PlayerState` (player) | `Pawn::PossessedBy()` | `Pawn::OnRep_PlayerState()` |
| The player's `Pawn` | `Pawn::PossessedBy()` | `PlayerController::AcknowledgePossession()` |
| `Pawn`/actor without a player (AI, destructible) | `BeginPlay()` (or `PossessedBy()`) | `BeginPlay()` |

Replication mode: single-player — `Full`; networked player — `Mixed` (then the owner of the ASC's owner must be a
controller: `SetOwner(NewController)`); networked AI — `Minimal`. **§4.1.1**

What the ASC holds: active effects in `FActiveGameplayEffectsContainer ActiveGameplayEffects`, granted abilities in
`FGameplayAbilitySpecContainer ActivatableAbilities`.

**Trap when iterating abilities.** Before a loop over `ActivatableAbilities.Items` put `ABILITYLIST_SCOPE_LOCK();` —
it forbids changing the list. You cannot remove an ability **inside** that scope: the cleanup functions check
`AbilityScopeLockCount` and silently do nothing.

---

<a name="3"></a>
## 3. GameplayTags

`FGameplayTag` is a hierarchical name `Parent.Child.Grandchild` registered in the `GameplayTagManager`. It replaces
boolean flags and state enums. **§4.2**

- Define them up front in `DefaultGameplayTags.ini` (tag editor — Project Settings → GameplayTags) or natively in
  C++: `UE_DECLARE_GAMEPLAY_TAG_EXTERN` in the `.h`, `UE_DEFINE_GAMEPLAY_TAG` in the `.cpp` — then the compiler
  catches typos.
- Keep them in batches in an `FGameplayTagContainer`, not a `TArray<FGameplayTag>` — the container packs more
  efficiently.
- Get a tag in C++: `FGameplayTag::RequestGameplayTag(FName("Your.Tag.Name"))`.
- Parents/children — through `UGameplayTagsManager::Get()`.

**An important detail about `TagMapCount`.** Tags live in an `FGameplayTagCountContainer` with an instance counter.
A tag can physically be in the container with `TagMapCount == 0`. Every `HasTag()`/`HasMatchingTag()` checks the
counter and returns false. This regularly confuses debugging: the tag is visible in a dump, but the check doesn't
find it.

**Loose tags.** Tags granted by a GameplayEffect replicate. `AddLooseGameplayTag()` / `RemoveLooseGameplayTag()`
add a tag outside an effect — such tags **do not replicate** and are managed manually. Edit the counter by hand only
for loose tags, and preferably through these two functions rather than directly.

**Reacting to a change:**

```cpp
ASC->RegisterGameplayTagEvent(FGameplayTag::RequestGameplayTag(FName("State.Debuff.Stun")),
    EGameplayTagEventType::NewOrRemoved).AddUObject(this, &AMyActor::StunTagChanged);
// void StunTagChanged(const FGameplayTag CallbackTag, int32 NewCount);
```

`EGameplayTagEventType` chooses whether to react only to appearance/disappearance or to any counter change.

Filtering in the editor: `Meta = (Categories = "GameplayCue")` on a property, `Meta = (GameplayTagFilter = "...")`
on a function parameter. Containers in function parameters cannot be filtered. **§4.2**

---

<a name="4"></a>
## 4. Attributes and AttributeSet

An attribute is an `FGameplayAttributeData`, a float with history. It lives in a `UAttributeSet`, which also
replicates it. **Attributes can only be defined in C++.** **§4.3, §4.4**

### BaseValue versus CurrentValue

- **BaseValue** — the permanent value;
- **CurrentValue** — BaseValue plus temporary modifiers from effects.

Speed 600 → buff +50 → CurrentValue 650, BaseValue still 600. The buff ends — CurrentValue goes back to 600.

**Who changes what:** `Instant` and periodic effects change **BaseValue**; `Duration` and `Infinite` change
**CurrentValue**.

**A common beginner mistake:** treating BaseValue as the maximum. It is not. A maximum that abilities or the UI look
at is a **separate attribute** (`MaxHealth`). Hard limits used only for clamping are plain hard-coded floats in the
AttributeSet.

### Meta Attributes

A placeholder attribute for an intermediate value. The classic is `Damage`: the effect does not touch health
directly but writes the damage into `Damage`, buffs adjust it in the ExecCalc, and the AttributeSet then decides
what to do with it (take it from the shield first, the rest from health). Not replicated, no persistence,
overwritten by every effect.

The point of the split: the effect answers "how much damage", the AttributeSet answers "what to do with that
damage". Different characters with different attribute sets distribute the damage differently without changing the
effect. **§4.3.3**

### Declaring an attribute

The macro block at the top of the AttributeSet header:

```cpp
#define ATTRIBUTE_ACCESSORS(ClassName, PropertyName) \
    GAMEPLAYATTRIBUTE_PROPERTY_GETTER(ClassName, PropertyName) \
    GAMEPLAYATTRIBUTE_VALUE_GETTER(PropertyName) \
    GAMEPLAYATTRIBUTE_VALUE_SETTER(PropertyName) \
    GAMEPLAYATTRIBUTE_VALUE_INITTER(PropertyName)
```

```cpp
UPROPERTY(BlueprintReadOnly, Category = "Health", ReplicatedUsing = OnRep_Health)
FGameplayAttributeData Health;
ATTRIBUTE_ACCESSORS(UMyAttributeSet, Health)
```

In the `.cpp` — the `OnRep` through the macro the prediction system requires:

```cpp
void UMyAttributeSet::OnRep_Health(const FGameplayAttributeData& OldHealth)
{
    GAMEPLAYATTRIBUTE_REPNOTIFY(UMyAttributeSet, Health, OldHealth);
}
```

And in `GetLifetimeReplicatedProps`:

```cpp
DOREPLIFETIME_CONDITION_NOTIFY(UMyAttributeSet, Health, COND_None, REPNOTIFY_Always);
```

`REPNOTIFY_Always` makes `OnRep` fire even when the local value already equals the one received. Non-replicated
attributes (meta attributes) need neither `OnRep` nor `GetLifetimeReplicatedProps`. **§4.4.3**

### Initialisation

Epic recommends an `Instant` GameplayEffect. The `ATTRIBUTE_ACCESSORS` macro also generates `InitHealth(100.f)`,
which can be called directly. **§4.4.4**

### Clamping — three places, and they must not be confused

Checked against `AttributeSet.h`, UE 5.8.

| Function | When it is called | Used for |
|---------|------------------|----------|
| `PreAttributeChange(Attribute, float& NewValue)` | before any change of **CurrentValue** — from a setter, an effect, an effect's removal, immunity, stacks | clamp `NewValue` (Epic: "Health = Clamp(Health, 0, MaxHealth)"); **does not touch BaseValue** |
| `PreAttributeBaseChange(Attribute, float& NewValue) const` | before a change of **BaseValue**, when the attribute has an aggregator | clamp BaseValue together with CurrentValue; no events |
| `PostGameplayEffectExecute(const FGameplayEffectModCallbackData&)` | after an `Instant`/periodic effect changed **BaseValue** | distribute meta attributes (damage → shield → health), clamp BaseValue, gameplay events (death) |

The usual scheme: `PreAttributeChange` clamps what queries and the UI see; `PostGameplayEffectExecute` (or
`PreAttributeBaseChange`) clamps what is stored. `PreAttributeChange` alone is not enough: BaseValue goes past the
limit, and the next buff removal returns an "impossible" value.

Three warnings:

1. **Clamping in `PreAttributeChange` does not change the modifier itself on the ASC** — only the returned value.
   So anything that recomputes CurrentValue from modifiers again (ExecCalc, MMC) **must clamp again**. This is a
   source of discrepancies: the value is right or wrong depending on who computed it.
2. **`PreAttributeChange` is not a place for gameplay events**, as Epic itself writes in the comments. Hook events
   to `GetGameplayAttributeValueChangeDelegate()`.
3. In `PostGameplayEffectExecute` the change has already happened but not yet replicated — clamping here does not
   cause two network updates.

### Reacting to an attribute change

```cpp
ASC->GetGameplayAttributeValueChangeDelegate(AttributeSet->GetHealthAttribute())
    .AddUObject(this, &AMyActor::HealthChanged);
// void HealthChanged(const FOnAttributeChangeData& Data);  // NewValue, OldValue, ModCallbackData
```

The `FGameplayEffectModCallbackData` inside is filled **only on the server**. **§4.3.4**

### Derived attributes

An attribute computed from others: an `Infinite` effect with `Attribute Based` modifiers or an MMC. It recomputes
itself when any source changes. If calculation order matters, do everything inside one MMC. **§4.3.5**

### How many AttributeSets

The overhead is negligible, so it is a matter of organisation. One monolithic set for the whole game with unused
attributes simply ignored is fine. Several by topic, granted selectively, is fine too. **But no more than one set of
a given class per ASC** — otherwise the system takes the first one it finds. Hence the limitation: "an AttributeSet
per item" cannot hold two items of the same type. **§4.4.2**

**Removing an AttributeSet at runtime is dangerous:** if the set is removed on the client before the server, an
incoming attribute change will not find its set and will crash the game. For item attributes (ammo, durability)
Tranek recommends **plain floats on the item itself**, not an AttributeSet. **§4.4.2.3**

---

<a name="5"></a>
## 5. GameplayEffects

`UGameplayEffect` (GE) is a **data-only class**; there must be no logic in it. It changes attributes and tags.
Usually made as Blueprint subclasses. **§4.5**

### Three durations

| Type | Changes | GameplayCue | Tags | When |
|-----|--------|-------------|------|-------|
| `Instant` | BaseValue, permanently | `Execute` | **never applied at all, not even for a frame** | damage, healing, payment |
| `Duration` | CurrentValue | `Add` + `Remove` | applied, removed when it expires | temporary buffs |
| `Infinite` | CurrentValue | `Add` + `Remove` | applied, removed only manually | permanent states |

`Duration` and `Infinite` can be **periodic** (`Period`): every X seconds they apply their modifiers, and then they
behave like `Instant` — change BaseValue and call `Execute` on the Cue. These are DOT effects.

`Duration`/`Infinite` can be **temporarily switched off without removing them** — through `Ongoing Tag
Requirements`. A switched-off effect removes its modifiers and tags but stays applied; when the requirements are met
again it turns back on.

**GEs are not instanced.** On application a `GameplayEffectSpec` is created from the CDO; a successfully applied spec
is wrapped into an `FActiveGameplayEffect` inside `ActiveGameplayEffects` on the ASC.

### Modifiers

One modifier changes **one** attribute with one operation: `Add`, `Multiply`, `Divide`, `Override`. `Override`
wins; the last one applied takes over. Use `Multiply` for percentage changes so it applies after addition.
**§4.5.4**

Four kinds of value source:

| Type | Essence |
|-----|------|
| `Scalable Float` | a value from a DataTable row by effect level, times a coefficient. Without a table the value is 1 and the coefficient acts as a constant |
| `Attribute Based` | takes the CurrentValue or BaseValue of an attribute on the Source or Target, plus a coefficient and additions. `Snapshot` = captured when the spec is created, without it — on application |
| `Custom Calculation Class` | the value from an MMC |
| `Set By Caller` | a value put into the spec at runtime by tag |

**The `SetByCaller` modifier trap:** if the effect class declares a modifier as `SetByCaller` and the spec has no
"tag → value" pair, there is a runtime error and the **value is 0**. For a `Divide` operation that is effectively a
division by zero. **§4.5.4, §4.5.9.1**

### Stacks

Only work for `Duration` and `Infinite`. By default every application creates a new spec instance that knows nothing
about the previous ones. With stacking, the counter of the existing instance changes instead of a new instance being
created. **§4.5.5**

| Type | Meaning |
|-----|-------|
| Aggregate by Source | a separate stack set per source |
| Aggregate by Target | one shared stack set regardless of source |

Plus policies for expiration, duration refresh and period reset.

### Tags on an effect

Five containers with different behaviour — mixing them up is expensive. **§4.5.7**

| Container | What it does |
|-----------|------------|
| Asset Tags | only describe the effect itself, do nothing |
| Granted Tags | granted to the target for the effect's lifetime, removed with it. `Duration`/`Infinite` only |
| Ongoing Tag Requirements | switch an already applied effect on and off |
| Application Tag Requirements | decide whether the effect applies at all |
| Remove Gameplay Effects with Tags | on successful application removes effects with these tags from the target |

### Immunity

`GrantedApplicationImmunityTags` checks the **source's** tags and grants immunity to everything from certain
sources. `Granted Application Immunity Query` checks the incoming spec with a query. Unlike plain `Application Tag
Requirements`, the immunity mechanism provides the delegate
`UAbilitySystemComponent::OnImmunityBlockGameplayEffectDelegate`. **§4.5.8**

### Granting abilities from an effect

`Duration` and `Infinite` effects can grant abilities. The technique: to make someone do something (knockback,
pull), give them an effect with an auto-activating ability. Removal policies: cancel immediately / let it finish and
remove / leave it (the ability stays forever). **§4.5.6**

### Applying, removing, observing

All the many `ApplyGameplayEffectTo*` functions end up in `UAbilitySystemComponent::ApplyGameplayEffectSpecToSelf()`
on the target. Outside an ability (for example from a projectile) — get the target's ASC and apply on it. Likewise
`RemoveActiveGameplayEffect*` ends up in `FActiveGameplayEffectsContainer::RemoveActiveEffects()`. **§4.5.2, §4.5.3**

```cpp
ASC->OnActiveGameplayEffectAddedDelegateToSelf.AddUObject(this, &AMyActor::OnEffectAdded);
ASC->OnAnyGameplayEffectRemovedDelegate().AddUObject(this, &AMyActor::OnEffectRemoved);
```

Both delegates concern only `Duration` and `Infinite`.

### Recomputing modifiers manually

If an MMC computes from data that are not attributes, the effect does not recompute itself. The technique: call
`SetActiveGameplayEffectLevel()` with the **same** level it already has. **§4.5.16** — the same section shows how to
change the remaining time of an active effect (through `const_cast`; not necessarily intended by Epic, but it works).

### Dynamic effects at runtime

**Only `Instant`** effects can be built from scratch at runtime in C++. `Duration` and `Infinite` cannot: on
replication they look up a class definition that does not exist. Instead, make an archetype class in the editor and
configure the spec. **§4.5.17**

---

<a name="6"></a>
## 6. The modifier aggregation formula and its traps

This is where intuition fails most often, and the consequences go straight into the balance. **§4.5.4.1**

CurrentValue is computed in `FAggregatorModChannel::EvaluateWithBase`:

```
((BaseValue + Additive) * Multiplicitive) / Division
```

But `Multiplicitive` and `Division` are **not a product** of the multipliers but a biased sum. For `Multiply` and
`Divide` the bias (`Bias`) is 1, for `Add` it is 0:

```
1 + (Mod1 - 1) + (Mod2 - 1) + ...
```

Hence the counter-intuitive results:

| Multipliers | Expected | Actual |
|-----------|----------|------------|
| `1.5` | ×1.5 | ×1.5, correct |
| `1.5`, `1.5` | ×2.25 | **×2.0** (+50% and another +50% = +100%) |
| `5`, `5` | ×25 | **×9** (sum minus count plus one) |
| `0.5` | ×0.5 | ×0.5, correct |
| `0.5`, `0.5` | ×0.25 | **×0** |
| `1.1`, `0.5` | ×0.55 | ×0.6 |

The formula was designed for Paragon and implicitly requires: **at most one value below 1**, any number of values in
[1, 2), or a single value ≥ 2. Paragon worked around it by applying only the strongest of the negative modifiers.

**What the project should do is a decision, not a setting; find out whether it has been made (design document,
balance rules).** Options: (1) "like Paragon" — don't patch the engine, accept that multipliers add up, and write the
balance in percentages (`+50 %`) rather than multipliers; close the "two debuffs zero the attribute" case with the
stock `MostNegativeMod_AllPositiveMods` (see below); (2) change `EvaluateWithBase` to `MultiplyMods` (full document,
§4.5.4.1) — ties the project to its own source build of the engine, impossible with an installed engine; (3) custom
rules through `AggregatorEvaluateMetaData`. Don't choose silently for the project owner.

**A related mechanism — `AggregatorEvaluateMetaData`.** It lets you define which modifiers take part in aggregation
at all. A ready example from the engine is `MostNegativeMod_AllPositiveMods`: apply all positive modifiers, but only
the strongest negative one. Configured in `UAttributeSet::OnAttributeAggregatorCreated()`. Modifiers that don't
qualify are **not removed** from the ASC; they are simply not counted and may "qualify" later, when the strongest one
expires. **§4.4.7**

---

<a name="7"></a>
## 7. Spec, Context, SetByCaller

**`FGameplayEffectSpec`** is what actually gets applied; an instance of an effect. Created through
`UAbilitySystemComponent::MakeOutgoingSpec()`, freely editable before application. It does not have to be applied
right away: a typical technique is to hand the spec to a projectile that applies it on hit. **§4.5.9**

The spec holds: the effect class, level, duration, period, stack count, context, attributes captured by snapshot,
`DynamicGrantedTags`, `DynamicAssetTags`, the `SetByCaller` maps.

**`FGameplayEffectContext`** — who created the spec, plus `TargetData`. A good place to carry arbitrary data through
to MMC, ExecCalc, AttributeSet and Cue. Subclassing takes six steps (override `GetScriptStruct`, `Duplicate`,
`NetSerialize` if needed, declare `TStructOpsTypeTraits`, override `AllocGameplayEffectContext()` in your own
`AbilitySystemGlobals`). **§4.5.10**

**`SetByCaller`** — `TMap<FGameplayTag, float>` and `TMap<FName, float>` on the spec:

```cpp
Spec->SetSetByCallerMagnitude(FGameplayTag::RequestGameplayTag(FName("Data.Damage")), 42.f);
float V = Spec.GetSetByCallerMagnitude(Tag, /*WarnIfNotFound=*/false, /*Default=*/0.f);
```

Use the **tag version**, not the `FName` one — it protects against typos. As a modifier it must be declared up front
on the effect class, otherwise an error and 0 (see §5). As a mere number carrier it need not be declared; reading a
missing value returns the default. **§4.5.9.1**

---

<a name="8"></a>
## 8. MMC and ExecCalc — which to choose

| | `ModifierMagnitudeCalculation` (MMC) | `GameplayEffectExecutionCalculation` (ExecCalc) |
|---|---|---|
| Returns | one float | changes anything, as much as it likes |
| Attributes changed | one (through a modifier) | many |
| Effect durations | any, including `Instant`, `Duration`, `Infinite`, periodic | **only `Instant` and periodic** |
| Implementation | Blueprint or C++ | **C++ only** |
| Predictable | yes | no (irrelevant in single-player, see §1) |

**§4.5.11, §4.5.12**

An MMC overrides `CalculateBaseMagnitude_Implementation(const FGameplayEffectSpec&)`. It can capture any number of
attributes from the Source and Target and read tags and `SetByCaller` from the spec.

**Attribute capture — rules shared by both:**

| Snapshot | Source | Capture happens | Updates when the attribute changes (`Duration`/`Infinite`) |
|---------|----------|-------------------|-----------------------------------------------------------|
| yes | Source | when the spec is created | no |
| yes | Target | on application | no |
| no | Source | on application | yes |
| no | Target | on application | yes |

Two mandatory conditions people trip over:

1. **Capture definitions must be added to `RelevantAttributesToCapture` in the constructor.** Otherwise capturing
   gives an error about a missing Spec. If no attributes are needed, add nothing.
2. **Capture recomputes CurrentValue from modifiers and does NOT call `PreAttributeChange`.** Clamping has to be
   repeated here by hand (see §4).

**The naming trap in ExecCalc.** The struct with capture definitions (the ActionRPG pattern) must be named
**uniquely** for each ExecCalc — they share one namespace, and identical names lead to capturing the values of the
wrong attributes. A nasty symptom: it computes silently and wrongly. **§4.5.12**

Ways to pass data into an ExecCalc: `SetByCaller` from the spec; a `Backing Data Attribute` through a
`CalculationModifier`; a `Temporary Variable` (in C++ — a `Transient Aggregator`, declared through
`ValidTransientAggregatorIdentifiers.AddTag(...)`); a custom `GameplayEffectContext`. **§4.5.12.1**

Suppress Cues inside an ExecCalc: `OutExecutionOutput.MarkGameplayCuesHandledManually()` and send the event yourself.
**§4.8.6**

**`CustomApplicationRequirement` (CAR)** — an advanced "can this be applied" check, richer than tags: for example
"the target must have N stacks" or "so much of an attribute". Override `CanApplyGameplayEffect_Implementation()`.
The technique: return false and extend the existing instance instead of applying a new one. **§4.5.13**

---

<a name="9"></a>
## 9. Cost and Cooldown

An ability has two optional effects with built-in logic. **§4.5.14, §4.5.15, §4.6.12**

**Cost GE** — an `Instant` effect with modifiers that subtract from attributes. It decides whether there are enough
resources to activate.

**Cooldown GE** — a `Duration` effect **with no modifiers** and a unique tag in `Granted Tags` (the "Cooldown Tag").
Crucially, the ability checks for the **tag**, not for the effect.

Order: `CanActivateAbility()` calls `CheckCost()` and `CheckCooldown()`. After activation the ability may at any
moment run `CommitAbility()` (= `CommitCost()` + `CommitCooldown()`), and that is the last chance to fail: attributes
may have changed since activation.

Both effects were designed to be predictable, so it is recommended **not to use ExecCalc** in them — an MMC fits and
is welcome. In a single-player game this restriction is moot, but there is no reason to break it either.

**Reusing one Cost/Cooldown GE for many abilities** works **only for instanced** abilities. Two techniques: an MMC
that reads the value from the ability instance through `Spec.GetContext().GetAbilityInstance_NotReplicated()`; or
`SetByCaller` plus overriding `GetCooldownTags()` and `ApplyCooldown()`. Full code for both — **§4.5.15**.

**Remaining cooldown time** — the query `FGameplayEffectQuery::MakeQuery_MatchAnyOwningTags(CooldownTags)` and
`GetActiveEffectsTimeRemainingAndDuration()`; a ready function in **§4.5.15.1**.

**What to subscribe to in order to catch the start and end of a cooldown** (an important asymmetry, **§4.5.15.2**):

- **start** — the addition of the Cooldown GE (`OnActiveGameplayEffectAddedDelegateToSelf`): that way the spec is
  visible too;
- **end** — the removal of the **tag**, not of the effect. Reason: the server's effect removes the locally predicted
  one, and the effect-removed delegate fires although the cooldown is still running. The tag doesn't change at that
  moment.

A single-player game does not hit the second problem, but the rule is safe and correct in general.

---

<a name="10"></a>
## 10. GameplayAbilities

`UGameplayAbility` (GA) — an action or skill. Several can be active at once. **§4.6**

Good for: jump, sprint, shoot, passive block, using an item, opening a door, gathering a resource, building.
**Not** good for: basic movement, UI operations (don't make a shop purchase an ability).

Abilities run on the owner and/or the server according to the `Net Execution Policy`, but **never on simulated
proxies**. Anything others must see goes through AbilityTasks and GameplayCues.

Override `ActivateAbility()`; extra logic goes into `EndAbility()`.

### Instancing Policy

| Policy | Essence | When |
|----------|------|-------|
| Instanced Per Actor | one instance per ASC, reused between activations; one active at a time | the main choice (since 5.5 Epic's recommended default); reset variables between activations manually |
| Instanced Per Execution | a new instance per activation | variables are always clean, but more expensive; instance replication is not supported |
| Non-Instanced | runs on the CDO, no instances | **deprecated since UE 5.5** (`UE_DEPRECATED_FORGAME`: "Use InstancedPerActor as the default"). Do not use in new code; migrate old code to Instanced Per Actor |

**§4.6.7** (the Tranek document still recommends Non-Instanced for simple abilities — for 5.5+ that is wrong)

### Ability tags

Ten containers, and **none of them replicates**. **§4.6.9**

| Container | What it does |
|-----------|------------|
| `Ability Tags` | describe the ability itself |
| `Cancel Abilities with Tag` | cancels other abilities with these tags on activation |
| `Block Abilities with Tag` | blocks activation of other abilities while this one is active |
| `Activation Owned Tags` | granted to the owner while active |
| `Activation Required Tags` | **all** are needed to activate |
| `Activation Blocked Tags` | **any** blocks activation |
| `Source Required` / `Source Blocked` | the same for the source; filled only on event activation |
| `Target Required` / `Target Blocked` | the same for the target; filled only on event activation |

### Activation

Besides input binding: `TryActivateAbilitiesByTag()`, `TryActivateAbilityByClass()`, `TryActivateAbility()` by
handle, and **by event** — `UAbilitySystemBlueprintLibrary::SendGameplayEventToActor()` with a payload (requires
`Triggers` configured on the ability). Triggers can also activate an ability when a tag is added or removed.
**§4.6.4**

**Don't forget `EndAbility()`** — except for passive abilities that always run.

**Passive abilities:** override `OnAvatarSet()` (called when the ability is granted and the avatar is set) and call
`TryActivateAbility()` from it. Epic calls this the right place for `BeginPlay`-level things. Usually `Server Only`.
**§4.6.4.1**

**Diagnosing failed activations.** Create `Activation.Fail.*` tags and register them in `DefaultGame.ini` under
`[/Script/GameplayAbilities.AbilitySystemGlobals]` (`ActivateFailCooldownName`, `ActivateFailCostName`,
`ActivateFailTagsBlockedName`, `ActivateFailTagsMissingName`, `ActivateFailIsDeadName`,
`ActivateFailNetworkingName`). After that the refusal reason shows up in the log and in `showdebug abilitysystem`
instead of silence. **Set this up right away, before the first debugging session.** **§4.6.4.2**

### Granting, cancelling, finding

Granted on the server through `GiveAbility(FGameplayAbilitySpec(Class, Level, InputID, SourceObject))`. **§4.6.3**

Cancelling: `CancelAbility()` from inside; from outside — `CancelAbility(UGameplayAbility*)`,
`CancelAbilityHandle()`, `CancelAbilities(WithTags, WithoutTags, Ignore)`, `CancelAllAbilities()`. **Note:**
`CancelAllAbilities()` works poorly when `Non-Instanced` abilities are present — `CancelAbilities()` is more reliable.
**§4.6.5**

**"How do I get the active ability?"** — the question is wrong: several can be active, there is no "the one". Search
by tag in `GetActivatableAbilities()` or through `GetActivatableGameplayAbilitySpecsByAllMatchingTags()`, then
`IsActive()` on the spec found. **§4.6.6**

### Passing data into an ability

Four ways, each with its own cost. **§4.6.11**

| Way | Limitation |
|--------|-------------|
| event activation with a payload | cannot be activated by an input press |
| `WaitGameplayEvent` AbilityTask | the task does not replicate the event — only for `Local Only` and `Server Only` |
| `TargetData` | good for arbitrary data |
| replicated variables on the actor | flexible and input-compatible, but no guarantee the data arrive before activation |

### Three options better left off

- **Replication Policy** — the name is misleading, it is not needed; specs already replicate to the owner. Epic wants
  to remove it. **§4.6.1.1**
- **Server Respects Remote Ability Cancellation** — makes the server version end after the client's, even if it has
  not finished. Usually turn it off. **§4.6.1.2**
- **Replicate Input Directly** — Epic recommends the stock `Generic Replicated Events` in the built-in input tasks
  instead. **§4.6.1.3**

### Levelling up an ability

Either remove it and grant it again at the new level (an active ability is interrupted), or raise the level on the
`GameplayAbilitySpec` and mark it dirty (not interrupted). The choice depends on whether it should be interrupted.
**§4.6.13**

---

<a name="11"></a>
## 11. AbilityTasks

An ability executes within one frame. Anything that lasts over time or waits for a delegate is done with latent
`AbilityTask`s. **§4.7**

Out of the box: movement through `RootMotionSource`, playing montages, waiting for attribute changes, waiting for
effect changes, reacting to input and more.

**Limit: 1000 simultaneously live AbilityTasks for the whole game.** In 5.8 it is the CVar
`AbilitySystem.AbilityTask.MaxCount` (debugging — `AbilitySystem.AbilityTask.Debug.RecordingEnabled` and
`...Debug.PrintCounts`; first understand why there are so many tasks, then raise the limit). Matters for games with
hundreds of characters at once.

Anatomy of a custom task: a static factory function, result delegates, `Activate()`, `OnDestroy()` for cleanup
(including unbinding from external delegates), callbacks, fields.

Three limitations and peculiarities:

1. **A task can have only one output delegate type.** All delegates must be of that type, even those that don't use
   the parameters — pass default values for unused ones.
2. A task runs only where its ability runs. To make it run on simulated clients too: `bSimulatedTask = true`,
   override `InitSimulatedTask()`, replicate the needed fields. All `RootMotionSource` tasks are built this way.
3. Ticking: `bTickingTask = true` and `TickTask(float DeltaTime)`. Needed for smooth interpolation.

**In C++ you must call `ReadyForActivation()`** after creating the task and binding its delegates. In Blueprint
`K2Node_LatentGameplayTaskCall` does it for you, and it also calls `BeginSpawningActor()`/`FinishSpawningActor()` —
in C++ those must be called by hand too. Cancelling — `EndTask()`. **§4.7.3**

---

<a name="12"></a>
## 12. GameplayCues

A `GameplayCue` (GC) is **cosmetics only**: sounds, particles, camera shake. Nothing gameplay-related. **§4.8**

The tag must start with the parent **`GameplayCue.`** — otherwise it won't fire.

| Class | Event | Effect type | Meaning |
|-------|---------|-------------|-------|
| `GameplayCueNotify_Static` | `Execute` | `Instant`, periodic | runs on the CDO, no instances. One-off effects such as hits |
| `GameplayCueNotify_Actor` | `Add` / `Remove` | `Duration`, `Infinite` | creates an instance, can last. Looping sounds and particles |

**Trap:** enable `Auto Destroy on Remove` on a `GameplayCueNotify_Actor`, otherwise repeated `Add`s of the same tag
stop working.

Four events. **§4.8.8**

| Event | When |
|---------|-------|
| `OnActive` | on addition |
| `WhileActive` | while the Cue is active — including for those who joined later. **It is not a tick**, called once |
| `Removed` | on removal (`OnRemove` in Blueprint) |
| `Executed` | an instant effect or a periodic tick (`OnExecute` in Blueprint) |

The split rule: `OnActive` holds what can be skipped if you arrive later (the explosion itself), `WhileActive` holds
what lasts and a latecomer must see (the fire burning after the explosion). `OnRemove` removes what both created.

**Cues are fundamentally unreliable** and unfit for anything that affects gameplay: they are unreliable multicast
RPCs. If something in a Cue must be reliable — apply it through an effect, add the effect in `WhileActive` and remove
it in `OnRemove`. **§4.8.9**

**Loading.** By default the `GameplayCueManager` scans the whole game directory and **asynchronously loads into
memory all** Cues at startup, together with all their sounds and particles — in a big game that is hundreds of
megabytes of unneeded data and hitches at startup. The fix: narrow `GameplayCueNotifyPaths` in `DefaultGame.ini`
and/or subclass `UGameplayCueManager` with `ShouldAsyncLoadRuntimeObjectLibraries()` → `false` to load on first use.
**§4.8.5**

Turn Cues off entirely on a particular ASC: `bSuppressGameplayCues = true`.

Local Cues (not sent over the network — projectile hits, melee, Cues from montages) — through
`GetGameplayCueManager()->HandleGameplayCue(...)` directly. What was added locally must be removed locally. **§4.8.3**

---

<a name="13"></a>
## 13. Targeting and TargetData

`FGameplayAbilityTargetData` is a struct for target data designed for network transfer. Don't use the base struct
directly, only subclass it; several ready subclasses are in `GameplayAbilityTargetTypes.h`. It is passed not directly
but through an `FGameplayAbilityTargetDataHandle` (internally an array of pointers — that gives polymorphism).
**§4.11**

Who creates it: `Target Actors` or code by hand. Who consumes it: AbilityTasks and effects through the
`EffectContext` — which means ExecCalc, MMC, Cue and AttributeSet functions can reach the data.

**A mandatory condition for `TargetData` in UE 4.24 through 5.2:** a one-time call to
`UAbilitySystemGlobals::Get().InitGlobalData()`. Without it — `ScriptStructCache` errors and clients disconnecting
from the server. Fortnite called it from `UAssetManager::StartInitialLoading()`. **Since 5.3 it is called
automatically**, so on 5.3+ there is no need to do it by hand — checked in the 5.8 source: `GameplayAbilitiesModule.cpp`
calls `InitGlobalData()` inside `GetAbilitySystemGlobals()` on the first access to the singleton (lazily, not at a
fixed startup point), and the method itself in `AbilitySystemGlobals.cpp` returns immediately if initialisation has
already happened — with Epic's comment "we call InitGlobalData automatically in UE5.3+". **§4.9.1**

---

<a name="14"></a>
## 14. Debugging

**`showdebug abilitysystem`** in the console — three pages, switched with `AbilitySystem.Debug.NextCategory`: the
CurrentValue of all attributes; active `Duration`/`Infinite` effects with stacks, tags and modifiers; granted
abilities with active and blocked flags plus task state. Tags are shown on all three. **§6.1**

Two conditions without which the command doesn't work:

- the `GameMode` must have a **real HUD class** selected, otherwise the console answers "Unknown Command";
- switching the target (`PageUp`/`PageDown`, `NextDebugTarget`) needs `bUseDebugTargetFromHud=true` in
  `[/Script/GameplayAbilities.AbilitySystemGlobals]`.

**Gameplay Debugger** — the `'` key, Abilities category. Needed to see the tags, effects and abilities of **other**
characters. It does not show the target's attribute values. **§6.2**

**Logs.** The GAS source has many `ABILITY_LOG()` calls; the default level is `Display` — nothing above reaches the
console. `log LogAbilitySystem VeryVerbose` turns them on, `log LogAbilitySystem Display` turns them back.
`log list` — all categories. Other categories: `LogAbilitySystemComponent`, `LogGameplayEffects`,
`LogGameplayEffectDetails`, `LogGameplayCueDetails`, `LogGameplayCueTranslator`, `LogGameplayTags`,
`LogGameplayTasks`, `VLogAbilitySystem`. **§6.3**

**When the debugger won't step into a function.** Even in `DebugGame Editor` part of the code is optimised. Wrap the
function in `UE_DISABLE_OPTIMIZATION` / `UE_ENABLE_OPTIMIZATION` (from `CoreMiscDefines.h`) — and **be sure to remove
it after debugging**. Has no effect on plugin code without rebuilding the plugin from source. **§6**

General rules for placing breakpoints and analysing crashes are in the `code-analysis` skill (debugging); here only
the GAS specifics.

---

<a name="15"></a>
## 15. Diagnosis by symptom

| Symptom | Cause | §  |
|---------|---------|----|
| `Can't activate LocalOnly or LocalPredicted ability ... when not local!` | the ASC is not initialised on the client | §9.1 |
| `ScriptStructCache` errors, clients get kicked from the server | `InitGlobalData()` not called (not needed on 5.3+) | §9.2 |
| Montages are not visible to others | `PlayMontage` used instead of `PlayMontageAndWait` — only the task replicates | §9.3 |
| AttributeSet pointers became nullptr | an engine bug when duplicating Blueprint actors. Workaround: don't keep your own pointers, call `ASC->AddSet<T>()` in `PostInitializeComponents()`, read through `GetNumericAttribute()` / `SetNumericAttributeBase()` | §9.4 |
| `unresolved external symbol UEPushModelPrivate::MarkPropertyDirty` | add `NetCore` to `PublicDependencyModuleNames` | §9.5 |
| `warning C4996: Enum names are now represented by path names` | pass an `FTopLevelAssetPath`, not an `FString`, to `BindAbilityActivationToInputComponent()` | §9.6 |
| The tag is visible in a dump but `HasTag()` returns false | `TagMapCount == 0` | §4.2 |
| A `SetByCaller` modifier gives 0 or a division by zero | the "tag → value" pair was not put into the spec | §4.5.4 |
| ExecCalc computes the wrong attributes | a non-unique capture struct name — they share a namespace | §4.5.12 |
| Clamping works sometimes and sometimes not | recomputation in MMC/ExecCalc doesn't call `PreAttributeChange`; repeat the clamping | §4.4.5 |
| Two ×1.5 multipliers give ×2, not ×2.25 | `Multiply` modifiers add up rather than multiply | §4.5.4.1 |
| An error about a missing Spec when capturing an attribute | the definition was not added to `RelevantAttributesToCapture` in the constructor | §4.5.11 |
| A repeated `Add` of a Cue tag doesn't fire | `Auto Destroy on Remove` is not enabled on the `GameplayCueNotify_Actor` | §4.8.1 |
| An ability silently doesn't activate, reason unknown | `Activation.Fail.*` tags not set up in `DefaultGame.ini` | §4.6.4.2 |
| Hitches and hundreds of extra megabytes in memory at startup | the `GameplayCueManager` loads all Cues at once | §4.8.5 |
| `CancelAllAbilities()` doesn't cancel some abilities | some of them are `Non-Instanced` — use `CancelAbilities()` | §4.6.5 |
| Attribute values drifted after the effect level changed | modifiers not based on attributes don't recompute themselves | §4.5.1 |

---

<a name="16"></a>
## 16. What the digest leaves out

Deliberately skipped — open the full document if needed:

- **§2, §3** — an overview of Tranek's demo project and setting up a project from scratch;
- **§4.4.2.3** — three ways to do item attributes, with the pros and cons of each (relevant for ammo or equipment
  durability: the recommendation is plain floats on the item);
- **§4.5.18, §8.1** — `GameplayEffectContainers` from Action RPG: not part of stock GAS, but handy when effects have
  to be passed to projectiles;
- **§4.7.4** — `RootMotionSource` tasks for knockback, dashes, pulls;
- **§4.11.2 onwards** — `Target Actors` and targeting methods;
- **§5** — recipes for typical abilities: stun, sprint, aim down sights, lifesteal, critical hits, a random number in
  sync on client and server, non-stacking effects with the highest magnitude, generating targets while paused, a
  one-button interaction system;
- **§8.2** — a Blueprint AsyncTask for binding to ASC delegates from UMG (handy for UI; remember they must be destroyed
  manually, otherwise they live in memory forever);
- **§10** — the list of abbreviations;
- **§11.1** — Q&A with Dave Ratti from Epic: useful to understand the system authors' intentions;
- **§12** — the GAS changelog by engine version (up to 5.3). **Check it when changing the engine version**; changes
  after 5.3 are only in the plugin source.
