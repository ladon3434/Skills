# StateTree concepts (UE 5.8)

`ST` = `<engine>/Engine/Plugins/Runtime/StateTree/Source`,
`GST` = `<engine>/Engine/Plugins/Runtime/GameplayStateTree/Source/GameplayStateTreeModule`.

## 1. Asset, schema, context

A `UStateTree` asset is edited as `UStateTreeEditorData` and compiled into a compact runtime form; nodes in the
runtime form are `const` and shared by every running instance.

The **schema** (`UStateTreeSchema` subclass, chosen in the asset) decides:
- which node structs/classes are allowed (`IsStructAllowed`, `IsClassAllowed`);
- which external data may be requested (`IsExternalItemAllowed`);
- which **context data** the tree gets (`GetContextDataDescs`) — these become bindable sources and auto-bind to
  `Context` properties;
- whether scheduled tick (sleeping) is allowed.

Schemas present in 5.8:

| Schema (display name) | Where | Context | Allowed nodes |
|---|---|---|---|
| `StateTree Component` (`UStateTreeComponentSchema`) | GameplayStateTree | `Actor` (class set by `ContextActorClass`) | `*CommonBase` conditions, evaluators, tasks, considerations, property functions; Blueprint node classes; external data: actors, components, world subsystems |
| `StateTree AI Component` (`UStateTreeAIComponentSchema`) | GameplayStateTree | `Actor` + `AIController` (`AIControllerClass`) | the above + `FStateTreeAITaskBase`, `FStateTreeAIConditionBase` |
| `UMassStateTreeSchema` | MassAI | Mass entity | Mass nodes |
| `UGameplayInteractionStateTreeSchema` | GameplayInteractions | smart-object interaction | |
| `UCameraDirectorStateTreeSchema` | GameplayCameras | camera director | |
| `UAvaTransitionTreeSchema`, `AnimNextStateTreeSchema` | Avalanche, UAF (experimental) | | |

Consequence: a C++ node deriving from `FStateTreeTaskBase` directly (not `FStateTreeTaskCommonBase`) is invisible
in a Component-schema asset. AI tasks (`FStateTreeAITaskBase`, e.g. `FStateTreeMoveToTask`) need the AI schema.

With the AI component the `Actor` context is the pawn if it matches `ContextActorClass`, otherwise the controller
(the schema resolves it from the AI owner).

## 2. States and selection

State types (`EStateTreeStateType`): `State` (tasks + children), `Group` (children only), `Linked` (continues on
a `Subtree` state of the same asset), `LinkedAsset` (continues on the Root of another asset), `Subtree` (a
linkable root, not selected by normal flow).

Selection behaviour (`EStateTreeStateSelectionBehavior`, default `TrySelectChildrenInOrder`):
- `None` — cannot be selected directly;
- `TryEnterState` — selected even if it has children;
- `TrySelectChildrenInOrder` — first child that can be entered; leaf → itself;
- `TrySelectChildrenAtRandom` — shuffled order;
- `TrySelectChildrenWithHighestUtility` — child with the highest utility score (ties → in order);
- `TrySelectChildrenAtRandomWeightedByUtility` — random, probability = normalised score;
- `TryFollowTransitions` — evaluate the state's transitions instead.

A state is entered only if its **enter conditions** pass and, if `bHasRequiredEventToEnter`, the
**required event** is present. `bCheckPrerequisitesWhenActivatingChildDirectly` (default `true`) also checks the
parent's prerequisites when a transition targets a child directly.

**Utility**: a state's score = its considerations combined (And/Or + indent like conditions), each
`GetNormalizedScore` clamped to 0..1, multiplied by `Weight`. Built-in considerations: `Constant`,
`Float Input` (with response curve), enum input.

Per-state options worth knowing: `TasksCompletion` (`Any` default / `All`), custom tick rate
(`bHasCustomTickRate`, smallest active rate wins), `bCopyParameterBindingsOnTick` (default `false`), state
`Parameters` (for `Linked`/`LinkedAsset` states — the parameters of the linked target), `Tag`
(used by linked-asset overrides).

## 3. Transitions

Editor struct `FStateTreeTransition`: `Trigger`, `RequiredEvent` (tag + `PayloadStruct` + `bConsumeEventOnSelect`),
target `State`, `Priority` (`Low`…`Critical`, default `Normal`), `bDelayTransition` + `DelayDuration` +
`DelayRandomVariance`, `Conditions`, `ReactivateTargetState` (force Changed / Sustained), `bTransitionEnabled`.

Triggers (`EStateTreeTransitionTrigger`): `OnStateCompleted` (= succeeded **or** failed — the default),
`OnStateSucceeded`, `OnStateFailed`, `OnTick`, `OnEvent`, `OnDelegate`.

Target types (`EStateTreeTransitionType`): `Succeeded` / `Failed` (stop the tree or subtree with that result),
`GotoState`, `Parent`, `NextState`, `NextSelectableState`, `NextParent`, `NextSelectableParent`, `None`.

Order inside one tick (from the transition processing code):
1. explicit transition requests (`RequestTransition`), the highest priority wins;
2. tick / event / delegate transitions and tasks' `TriggerTransitions()`, bottom-up; delayed ones are queued;
3. only if nothing fired — completion transitions, bottom-up;
4. nothing matches a completed state → **jump back to Root** (Verbose log "Could not trigger completion
   transition, jump back to root state."). Root cannot be selected → the tree stops with `Failed`.

`ChangeType` passed to Enter/Exit: `Changed` (state newly entered/left) or `Sustained` (state stays active
because a transition re-selected inside it). Tasks with `bShouldStateChangeOnReselect = false` skip Enter/Exit on
`Sustained`.

## 4. Evaluators vs global tasks

Both live at the tree level and run while the tree runs.
- **Evaluator** (`FStateTreeEvaluatorBase`): `TreeStart`, `Tick(DeltaTime)`, `TreeStop`; no status — it only
  exposes data (outputs) for bindings and conditions.
- **Global task** (`GlobalTasks`, completion mode `GlobalTasksCompletion`, default `Any`): a normal task with
  Enter/Tick/Exit and a status. **When global tasks complete, they complete the frame they belong to** — the
  whole tree for the root asset, the linked frame for a linked asset (5.6 behaviour; CVar
  `StateTree.GlobalTasksCompleteOwningFrame=0` restores 5.5 behaviour where they complete the root).
- Tick order: root evaluators → root global tasks → state tasks → linked-asset evaluators → … (CVar
  `StateTree.TickGlobalNodesFollowingTreeHierarchy`, default on).

Rule of thumb: pure data for decisions → evaluator; something with a lifetime and a possible end (a listener, a
resource held for the whole tree) → global task, and keep it `Running`.

## 5. Tasks, conditions, considerations

- **Task** (`FStateTreeTaskBase`): `EnterState` → `Running` / `Succeeded` / `Failed`; `Tick` (only if
  `bShouldCallTick`, or `bShouldCallTickOnlyOnEvents` with pending events); `ExitState`; `StateCompleted`
  (reverse order, after completion, **not** on conditional transitions); `TriggerTransitions` (only if
  `bShouldAffectTransitions`).
- Tasks of a state run in order. A task returning `Failed` stops the remaining tasks of that state from being
  entered/ticked. `ExitState` is still called on every task whose `EnterState` was called — including the one that
  failed.
- A state with no enabled tasks completes as `Succeeded` on the first tick.
- **Condition** (`FStateTreeConditionBase::TestCondition`); combined with `Operand` (And/Or) and indent;
  `EvaluationMode` can force true/false (debug); may also implement Enter/Exit/StateCompleted.
- **Consideration** (`FStateTreeConsiderationBase::GetScore`, protected) — see §2.
- **Property functions** (`FStateTreePropertyFunctionCommonBase`) — small computed values usable as binding sources.

## 6. Instance data and bindings

Each node declares `using FInstanceDataType = F...InstanceData;` and returns it from `GetInstanceDataType()`. The
execution context allocates one instance per running tree; `Context.GetInstanceData(*this)` returns it. Optional
`FExecutionRuntimeDataType` persists across state changes for the whole run.

Property role is the `Category` of the instance-data property:

| Category | Role | Compile rule |
|---|---|---|
| `Input` / `Inputs` | must be bound | unbound → compile error unless `meta=(Optional)` |
| `Output` / `Outputs` | written by the node, bindable as a source | copied out after Enter/Tick unless the task failed |
| `Context` | context object or struct | auto-bound to the schema context of matching type (name breaks ties); none → error |
| anything else (`Parameter`) | editable value, optionally bound | — |

Binding sources: context, tree parameters, evaluators, global tasks, state parameters, tasks, conditions,
considerations, transition event payload, state-selection event payload, property functions.

**When values are copied into the instance** (task): before `EnterState` always; before `Tick` only if the task
ticks **and** `bShouldCopyBoundPropertiesOnTick` (default `true`); before `ExitState` if
`bShouldCopyBoundPropertiesOnExitState` (default `true`). "Not ticking implies no property copy" (engine comment):
a task with `bShouldCallTick = false` holds the values from `EnterState` (CVar
`StateTree.CopyBoundPropertiesOnNonTickedTask` changes that globally).

## 7. Parameters

- **Tree parameters** — a property bag on the asset (`RootParameterPropertyBag`); per-instance values come from
  the `FStateTreeReference` (the component's `StateTreeRef` holds overrides; `SyncParameters` keeps the layout in
  step with the asset) or from `Start(InitialGlobalParameters)`.
- **State parameters** — per state; on `Linked`/`LinkedAsset` states they feed the target's parameters.

## 8. Linked subtrees and linked assets

- `Linked` → a `Subtree` state in the same asset; `LinkedAsset` → another `UStateTree`. Each runs as an
  execution **frame**; succeeding/failing inside it completes the linking state.
- `UStateTreeComponent::LinkedStateTreeOverrides` / `AddLinkedStateTreeOverrides(Tag, Ref)` replace the asset of a
  linked state whose `Tag` matches exactly; overrides with a different schema are rejected with a warning.
- `FStateTreeRunParallelStateTreeTask` runs another tree in parallel inside a state.

## 9. Events

`FStateTreeEvent` = `Tag` (`FGameplayTag`) + `Payload` (`FInstancedStruct`) + `Origin` (`FName`).
- Sent via `UStateTreeComponent::SendStateTreeEvent`, `Context.SendEvent`, the weak context, or
  `UStateTreeNodeBlueprintBase::SendEvent`.
- Consumed by `OnEvent` transitions and states with a required event. Match: the sent tag equals the required tag or is its child (`A.B.C` matches `A.B`, not the reverse); with a `PayloadStruct` the payload must be that struct or a child. With `bConsumeEventOnSelect` (default
  `true`) the event is consumed when it leads to a selection, so later selection cannot react to it again.
- The payload is a binding source in the target state ("transition event" / "state event").
- The queue is cleared at the end of each tick's transition phase — an event with no listener that tick is gone.
- At most 64 events per queue; the rest are dropped with an error.

## 10. Execution context

`FStateTreeExecutionContext(Owner, StateTree, InstanceData)` is **temporary** — created per call (`Start`,
`Tick`, `Stop`), never stored. The owner (component) keeps `FStateTreeInstanceData`. For later/async work a node
takes `Context.MakeWeakExecutionContext()` (`FStateTreeWeakExecutionContext`): valid while the state that made it
is active; it can `SendEvent`, `RequestTransition`, `FinishTask`, `BroadcastDelegate`, `BindDelegate`, and
`MakeStrongExecutionContext()` to reach instance data.

`FStateTreeMinimalExecutionContext` (events, scheduled tick requests) is what the component uses for
`SendStateTreeEvent`.

**Scheduled tick**: the component's tick is off by default and is driven by `GetNextScheduledTick()`; a task can
add/update/remove a custom-rate request (`AddScheduledTickRequest`, see the Delay task). Pending events,
transition requests and completed states force a next-frame tick.

## Verified at
- Schema base API — `ST/StateTreeModule/Public/StateTreeSchema.h:28-56`
- Component schema allowed nodes / external items — `GST/Private/Components/StateTreeComponentSchema.cpp:37-56`
- Component schema `Actor` context desc — `GST/Private/Components/StateTreeComponentSchema.cpp:31-34`
- Actor context resolution (pawn vs controller) — `GST/Private/Components/StateTreeComponentSchema.cpp:121-145`
- AI schema adds AI bases + `AIController` context — `GST/Private/Components/StateTreeAIComponentSchema.cpp:35-47`
- Other schemas — `MassAI/.../MassStateTreeSchema.h`, `GameplayInteractions/.../GameplayInteractionStateTreeSchema.h`, `GameplayCameras/.../CameraDirectorStateTreeSchema.h`
- State types — `ST/StateTreeModule/Public/StateTreeTypes.h:153-169`
- Selection behaviours — `ST/StateTreeModule/Public/StateTreeTypes.h:172-198`
- Transition types / triggers / priority — `StateTreeTypes.h:76-106`, `218-241`, `247-265`
- State defaults (selection, TasksCompletion, tick rate, required event, Weight) — `ST/StateTreeEditorModule/Public/StateTreeState.h:420-476`
- Transition fields, default trigger `OnStateCompleted` — `StateTreeState.h:141-191`
- Event desc, `bConsumeEventOnSelect = true` — `StateTreeState.h:21-42`
- Transition processing order — `ST/StateTreeModule/Private/StateTreeExecutionContext.cpp:5735-5742`
- Jump back to root / stop with failure — `StateTreeExecutionContext.cpp:6302-6326`
- No enabled tasks → state succeeded — `StateTreeExecutionContext.cpp:4893-4916`
- Global tasks complete owning frame (CVar) — `StateTreeExecutionContext.cpp:55-61`, `4885-4892`
- Tick order CVar — `StateTreeExecutionContext.cpp:45-53`
- Evaluator API — `ST/StateTreeModule/Public/StateTreeEvaluatorBase.h:18-39`
- Global tasks / evaluators in editor data — `ST/StateTreeEditorModule/Public/StateTreeEditorData.h:419-426`
- Task Enter/Exit/StateCompleted/Tick/TriggerTransitions contracts — `ST/StateTreeModule/Public/StateTreeTaskBase.h:40-90`
- Failed task stops following tasks; ExitState on entered tasks — `StateTreeExecutionContext.cpp:3832`, `3872-3879`, `4015-4017`
- Consideration score clamp — `ST/StateTreeModule/Private/StateTreeConsiderationBase.cpp:14-17`
- Category → usage — `ST/StateTreeModule/Private/StateTreePropertyBindings.cpp:35-68`
- Input must be bound unless `Optional` — `ST/StateTreeEditorModule/Private/StateTreeCompiler.cpp:3124-3138`; `StateTreePropertyHelpers.cpp:302-305`
- Context auto-binding — `StateTreeCompiler.cpp:3140-3180`; `StateTreeEditorData.cpp:495-522`
- Binding sources — `ST/StateTreeModule/Public/StateTreePropertyBindings.h:26-52`
- Copy at Enter / Tick / Exit — `StateTreeExecutionContext.cpp:3281-3283`, `3834-3837`, `4970-4979`; CVar `:38-43`
- Linked overrides match by tag — `ST/StateTreeModule/Public/StateTreeReference.h:172-177`; schema check `GST/Private/Components/StateTreeComponent.cpp:528`
- Event struct / queue limit — `ST/StateTreeModule/Public/StateTreeEvents.h:49-89`, `181`; drop log `Private/StateTreeEvents.cpp:45-47`
- Event matching — `ST/StateTreeModule/Private/StateTreeTypes.cpp:249-262`
- Events cleared after transition phase — `StateTreeExecutionContext.cpp:5766-5777`
- Context is temporary — `ST/StateTreeModule/Public/StateTreeExecutionContext.h:276-280`
- Weak context API — `ST/StateTreeModule/Public/StateTreeAsyncExecutionContext.h:249-348`
- Scheduled tick reasons — `StateTreeExecutionContext.cpp:535-550`
