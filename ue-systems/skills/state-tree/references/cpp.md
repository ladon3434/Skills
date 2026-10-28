# StateTree in C++ (UE 5.8)

`ST` = `<engine>/Engine/Plugins/Runtime/StateTree/Source`,
`GST` = `<engine>/Engine/Plugins/Runtime/GameplayStateTree/Source/GameplayStateTreeModule`.
Best engine templates to copy from: `ST/StateTreeModule/Private/Tasks/StateTreeDelayTask.*` (ticking + scheduled
tick), `GST/Private/Tasks/StateTreeRunEnvQueryTask.cpp` (async finish through the weak context),
`ST/StateTreeModule/Public/Conditions/StateTreeCommonConditions.h` (conditions).

## 0. Module setup

```csharp
PublicDependencyModuleNames.AddRange(new[] { "StateTreeModule", "GameplayStateTreeModule", "GameplayTags" });
// + "AIModule" for AI tasks / AAIController
```
`.uproject`: plugins `StateTree`, `GameplayStateTree`.

## 1. The shape of every node

```cpp
USTRUCT()
struct FMyTaskInstanceData            // ALL per-instance state lives here
{
	GENERATED_BODY()

	UPROPERTY(EditAnywhere, Category = "Context")   // auto-bound to the schema's Actor
	TObjectPtr<AActor> Actor = nullptr;

	UPROPERTY(EditAnywhere, Category = "Input")     // must be bound (or meta=(Optional))
	TObjectPtr<AActor> Target = nullptr;

	UPROPERTY(EditAnywhere, Category = "Parameter") // value or optional binding
	float AcceptAngleDeg = 5.f;

	UPROPERTY(VisibleAnywhere, Category = "Output") // readable by later nodes
	bool bAligned = false;

	FTimerHandle Timer;                             // private runtime state, not a property
};

USTRUCT(meta = (DisplayName = "Face Target", Category = "MyGame"))
struct FMyFaceTargetTask : public FStateTreeTaskCommonBase   // CommonBase — or the Component schema hides it
{
	GENERATED_BODY()

	using FInstanceDataType = FMyTaskInstanceData;
	virtual const UStruct* GetInstanceDataType() const override { return FInstanceDataType::StaticStruct(); }

	// Node fields = asset config, shared by every instance, read-only at runtime (methods are const).
};
```
Rules: the node methods are `const`; never `mutable`/`const_cast` node fields for runtime state. UObject pointers in
instance data are `UPROPERTY` (normal reflection GC rule). Access: `FInstanceDataType& Data = Context.GetInstanceData(*this);`.

## 2. Task — flags and return values

Flags (set in the constructor; defaults in brackets):

| Flag | Default | Meaning |
|---|---|---|
| `bShouldCallTick` | `true` | `Tick()` is called. Not ticking → no property copy before tick. |
| `bShouldCallTickOnlyOnEvents` | `false` | Tick only when events are pending (ignored if `bShouldCallTick`). |
| `bShouldCopyBoundPropertiesOnTick` | `true` | Refresh bindings before `Tick()`. |
| `bShouldCopyBoundPropertiesOnExitState` | `true` | Refresh bindings before `ExitState()`. |
| `bShouldStateChangeOnReselect` | `true` | Enter/Exit also on `Sustained` reselection. `false` for "hold while children run". |
| `bShouldAffectTransitions` | `false` | `TriggerTransitions()` is called during transition processing. |
| `bConsideredForScheduling` | `true` | The flags above are used to decide whether the tree may sleep. |

`EnterState` / `Tick` return: `Running` — keep going; `Succeeded` / `Failed` — the task is finished; with state
`TasksCompletion = Any` (default) that completes the state and triggers completion transitions. `Failed` from a task
stops the following tasks of the state. `ExitState` runs on every task whose `EnterState` was called — including
the one that returned `Failed` — so it must tolerate a partial start.

### 2a. Ticking task

```cpp
EStateTreeRunStatus FMyFaceTargetTask::EnterState(FStateTreeExecutionContext& Context,
	const FStateTreeTransitionResult& Transition) const
{
	FInstanceDataType& Data = Context.GetInstanceData(*this);
	if (!Data.Target)
	{
		return EStateTreeRunStatus::Failed;   // ExitState still follows
	}
	Data.bAligned = false;
	return EStateTreeRunStatus::Running;
}

EStateTreeRunStatus FMyFaceTargetTask::Tick(FStateTreeExecutionContext& Context, const float DeltaTime) const
{
	FInstanceDataType& Data = Context.GetInstanceData(*this);  // Target re-copied before this call
	if (!Data.Target)
	{
		return EStateTreeRunStatus::Failed;
	}
	// ... rotate Data.Actor toward Data.Target ...
	Data.bAligned = /* angle <= Data.AcceptAngleDeg */ false;
	return Data.bAligned ? EStateTreeRunStatus::Succeeded : EStateTreeRunStatus::Running;
}
```

### 2b. Async task (no tick) — finish from a callback

```cpp
FMyWaitTask::FMyWaitTask()
{
	bShouldCallTick = false;                       // nothing to do per frame
	bShouldCopyBoundPropertiesOnTick = false;
	bShouldCopyBoundPropertiesOnExitState = false;
}

EStateTreeRunStatus FMyWaitTask::EnterState(FStateTreeExecutionContext& Context,
	const FStateTreeTransitionResult& Transition) const
{
	FInstanceDataType& Data = Context.GetInstanceData(*this);
	UWorld* World = Context.GetWorld();
	if (!World)
	{
		return EStateTreeRunStatus::Failed;
	}
	World->GetTimerManager().SetTimer(Data.Timer,
		FTimerDelegate::CreateLambda([WeakContext = Context.MakeWeakExecutionContext()]()
		{
			// Fails safely if the state is no longer active or the owner is gone.
			WeakContext.FinishTask(EStateTreeFinishTaskType::Succeeded);
		}),
		Data.Duration, false);
	return EStateTreeRunStatus::Running;
}

void FMyWaitTask::ExitState(FStateTreeExecutionContext& Context, const FStateTreeTransitionResult& Transition) const
{
	FInstanceDataType& Data = Context.GetInstanceData(*this);
	if (UWorld* World = Context.GetWorld())
	{
		World->GetTimerManager().ClearTimer(Data.Timer);   // left early by a transition — cancel
	}
}
```
To write results from the callback: `const FStateTreeStrongExecutionContext Strong = WeakContext.MakeStrongExecutionContext();`
then `if (FInstanceDataType* Data = Strong.GetInstanceDataPtr<FInstanceDataType>()) { ...; Strong.FinishTask(...); }`
(exactly what `FStateTreeRunEnvQueryTask` does).

`Context.FinishTask(*this, EStateTreeFinishTaskType::Succeeded)` — only from inside this task's own
Enter/Exit/StateCompleted/Tick/TriggerTransitions. Inside tick processing the state completes immediately;
outside it the request is buffered to the next tick. The 5.5-style `FinishTask(FFinishedTask, ...)` and
`FStateTreeWeakTaskRef` overloads are deprecated since 5.6.

### 2c. Task-driven transition

`Context.RequestTransition(StateHandle, Priority)` or the weak context's `RequestTransition`. A handle comes from
an instance-data `FStateTreeStateLink` property (designer picks the state; use its `StateHandle`). Outside transition processing the
request is buffered to the next transition phase.

## 3. Condition

```cpp
USTRUCT()
struct FMyHasAmmoConditionInstanceData
{
	GENERATED_BODY()
	UPROPERTY(EditAnywhere, Category = "Input")     int32 Ammo = 0;
	UPROPERTY(EditAnywhere, Category = "Parameter") int32 Min = 1;
};

USTRUCT(meta = (DisplayName = "Has Ammo"))
struct FMyHasAmmoCondition : public FStateTreeConditionCommonBase
{
	GENERATED_BODY()
	using FInstanceDataType = FMyHasAmmoConditionInstanceData;
	virtual const UStruct* GetInstanceDataType() const override { return FInstanceDataType::StaticStruct(); }

	virtual bool TestCondition(FStateTreeExecutionContext& Context) const override
	{
		const FInstanceDataType& Data = Context.GetInstanceData(*this);
		return (Data.Ammo >= Data.Min) ^ bInvert;
	}

	UPROPERTY(EditAnywhere, Category = "Parameter")  // config on the node is fine — it never changes at runtime
	bool bInvert = false;
};
```
Conditions are pure: no side effects in `TestCondition` (it runs during selection, possibly for states that are
then not entered).

## 4. Evaluator

```cpp
USTRUCT(meta = (DisplayName = "Threat"))
struct FMyThreatEvaluator : public FStateTreeEvaluatorCommonBase
{
	GENERATED_BODY()
	using FInstanceDataType = FMyThreatEvaluatorInstanceData;   // Context Actor + Output float Threat
	virtual const UStruct* GetInstanceDataType() const override { return FInstanceDataType::StaticStruct(); }

	virtual void TreeStart(FStateTreeExecutionContext& Context) const override;
	virtual void Tick(FStateTreeExecutionContext& Context, const float DeltaTime) const override; // DeltaTime 0 in preselection
	virtual void TreeStop(FStateTreeExecutionContext& Context) const override;
};
```
An evaluator has no status. If it must end the tree, it is a global task instead.

## 5. Consideration (utility)

```cpp
USTRUCT(meta = (DisplayName = "Health Need"))
struct FMyHealthConsideration : public FStateTreeConsiderationCommonBase
{
	GENERATED_BODY()
	using FInstanceDataType = FMyHealthConsiderationInstanceData;  // Input float Health01
	virtual const UStruct* GetInstanceDataType() const override { return FInstanceDataType::StaticStruct(); }
protected:
	virtual float GetScore(FStateTreeExecutionContext& Context) const override   // protected in the base
	{
		return 1.f - Context.GetInstanceData(*this).Health01;   // clamped to 0..1 by GetNormalizedScore
	}
};
```
Used only by a parent with `TrySelectChildrenWithHighestUtility` / `...AtRandomWeightedByUtility`.

## 6. External data (subsystems, components)

```cpp
TStateTreeExternalDataHandle<UMyWorldSubsystem> SubsystemHandle;   // node field, filled at link time

virtual bool Link(FStateTreeLinker& Linker) override
{
	Linker.LinkExternalData(SubsystemHandle);
	return true;
}
// in Enter/Tick:  UMyWorldSubsystem& Sub = Context.GetExternalData(SubsystemHandle);
```
The Component schema resolves actors, actor components and world subsystems. Prefer a `Context` property when the
object is the owner itself.

## 7. Running a tree on an actor

- Actor: add `UStateTreeComponent`; AI: `UStateTreeAIComponent` **on the AIController** (AI schema; the controlled
  pawn reaches the tree as the `Actor` context when it matches `ContextActorClass`).
- Asset: `StateTreeRef` (`FStateTreeReference`, includes parameter overrides). `SetStateTree` /
  `SetStateTreeReference` are ignored while running.
- `bStartLogicAutomatically` (default `true`) → `StartLogic()` in `BeginPlay`. Manual: set it `false`
  (`SetStartLogicAutomatically`) and call `StartLogic()`.
- `StopLogic(Reason)`; `RestartLogic()` = start again (a running instance is stopped first, so tasks get `ExitState`).
- `PauseLogic` / `ResumeLogic`; `IsRunning()`; `GetStateTreeRunStatus()`; `OnStateTreeRunStatusChanged`
  (dynamic multicast — handler must be a `UFUNCTION`).
- Tree finished (`Succeeded`/`Failed`) does not restart by itself — react to `OnStateTreeRunStatusChanged` or
  design the root never to complete.
- Do not call `StartLogic`/`StopLogic`/`RestartLogic` from inside a task or a callback that runs during the tree's
  own tick: "Reentrant call ... is not allowed." Finish the task / transition to a `Succeeded`/`Failed` target instead.

Custom owner (no component): `FStateTreeExecutionContext Context(Owner, *StateTree, InstanceData);` per call, set
context data (`SetContextDataByName`) and `SetCollectExternalDataCallback`, then `Start` / `Tick` / `Stop` — the
pattern documented at the top of `StateTreeExecutionContext.h` and implemented by `UStateTreeComponent::StartTree`.

## 8. Sending events from C++

```cpp
UE_DEFINE_GAMEPLAY_TAG(TAG_AI_Event_Heard, "AI.Event.Heard");   // native tag

FMyHeardPayload Payload{ Location, Loudness };                    // USTRUCT = the transition's PayloadStruct
StateTreeComponent->SendStateTreeEvent(TAG_AI_Event_Heard, FConstStructView::Make(Payload), TEXT("Hearing"));
```
- From a node: `Context.SendEvent(Tag, Payload, Origin)`; from a callback: `WeakContext.SendEvent(...)`.
- Before `StartLogic` the component drops the event with a warning.
- A task reading events directly: `Context.ForEachEvent(...)` / `GetEventsToProcessView()`, `ConsumeEvent(...)`;
  pair with `bShouldCallTickOnlyOnEvents = true` to wake only on events.

## 9. Blueprint nodes (when designers own the logic)

`UStateTreeTaskBlueprintBase`: events `EnterState`/`Tick`/`ExitState`/`StateCompleted`; status through the
`Finish Task` node (`FinishTask(bool bSucceeded)`); the same flags as C++ tasks; class properties are the instance
data. Also `SendEvent`, `RequestTransition` on `UStateTreeNodeBlueprintBase`.

## Verified at
- Task flags and defaults — `ST/StateTreeModule/Public/StateTreeTaskBase.h:23-37`, `107-133`
- Return-value contract — `StateTreeTaskBase.h:40-81`
- `FStateTreeTaskCommonBase` — `StateTreeTaskBase.h:164-168`
- Component schema accepts only CommonBase — `GST/Private/Components/StateTreeComponentSchema.cpp:37-44`
- `GetInstanceData(*this)` — `ST/StateTreeModule/Public/StateTreeExecutionContext.h:718-725`
- `FinishTask` contract — `StateTreeExecutionContext.h:781-796`
- `RequestTransition` (buffered outside transition processing) — `StateTreeExecutionContext.h:761-779`; weak `StateTreeAsyncExecutionContext.h:300-310`; `FStateTreeStateLink::StateHandle` — `StateTreeTypes.h:1292`, `1330-1332`
- Weak `FinishTask` / `SendEvent` — `ST/StateTreeModule/Public/StateTreeAsyncExecutionContext.h:298`, `348`
- Strong context + `GetInstanceDataPtr` + `FinishTask` in a callback — `GST/Private/Tasks/StateTreeRunEnvQueryTask.cpp:37-68`; abort in ExitState `:75-85`
- Non-ticking task flags pattern — `GST/Private/Tasks/StateTreeRunEnvQueryTask.cpp:14-19`; `ST/StateTreeModule/Private/Tasks/StateTreeDelayTask.cpp:10-15`
- ExitState after a failed EnterState — `ST/StateTreeModule/Private/StateTreeExecutionContext.cpp:3832`, `4015-4017`
- Condition example (`bInvert` on node, data in instance) — `ST/StateTreeModule/Public/Conditions/StateTreeCommonConditions.h:19-62`
- Evaluator API — `ST/StateTreeModule/Public/StateTreeEvaluatorBase.h:26-39`
- Consideration `GetScore` protected — `ST/StateTreeModule/Public/StateTreeConsiderationBase.h:24-28`
- External data handle / `Link` — `ST/StateTreeModule/Public/StateTreeExecutionTypes.h:150-169`; `StateTreeLinker.h:49-73`
- Component API (Set*, SendStateTreeEvent, run status delegate) — `GST/Public/Components/StateTreeComponent.h:54-128`
- Auto start in BeginPlay — `GST/Private/Components/StateTreeComponent.cpp:95-102`
- Restart = StartTree; Start stops a running instance — `StateTreeComponent.cpp:166-170`; `ST/StateTreeModule/Private/StateTreeExecutionContext.cpp:1486-1490`
- Re-entrant call refused — `StateTreeComponent.cpp:131-135`, `181-185`
- Set* ignored while running — `StateTreeComponent.cpp:478`, `499`
- Event dropped before start — `StateTreeComponent.cpp:577-583`
- AI component is meant for an AIController — `GST/Public/Components/StateTreeAIComponent.h:11-14`
- Blueprint task API — `ST/StateTreeModule/Public/Blueprint/StateTreeTaskBlueprintBase.h:37-87`, `121-148`
- `FConstStructView::Make` — `<engine>/Engine/Source/Runtime/CoreUObject/Public/StructUtils/StructView.h:246`
