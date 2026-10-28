---
name: state-tree
description: >
  StateTree in Unreal Engine 5.8 C++ projects: the model (schemas, states and selection, transitions, evaluators
  vs global tasks, tasks, conditions, utility considerations, property bindings, parameters, linked subtrees and
  assets, events with payloads, execution context and instance data), writing C++ tasks, conditions and
  evaluators, running a tree on an actor or AIController (UStateTreeComponent / UStateTreeAIComponent), sending
  events from C++, debugging with the StateTree debugger and Rewind Debugger, and a review checklist with traps
  verified against the engine source. Use for "StateTree", "state tree task", "write a StateTree task in C++",
  "AI behaviour with StateTree", "StateTree transition", "transition does not fire", "task never finishes",
  "send an event to the StateTree", "review StateTree code". Russian: «стейт три», «дерево состояний»,
  «задача StateTree», «переход не срабатывает», «таск не завершается», «проверь StateTree-код».
---

# state-tree — StateTree in UE 5.8

Paths are relative to the skill folder (`<skill>`). Engine paths: `<engine>` = the engine root of the project's
`EngineAssociation`. Checked against 5.8; StateTree changes noticeably between versions (FinishTask, delegates and
the weak context changed in 5.6, global-task completion in 5.6) — on another version re-check in the source:
`<engine>/Engine/Plugins/Runtime/StateTree/Source/StateTreeModule` (core) and
`<engine>/Engine/Plugins/Runtime/GameplayStateTree/Source/GameplayStateTreeModule` (components, AI tasks).

## First of all — is it enabled

- `.uproject` — plugins `StateTree` and, for the components, `GameplayStateTree`.
- `Build.cs` — `StateTreeModule`; `GameplayStateTreeModule` for `UStateTreeComponent`; `GameplayTags` for events;
  `AIModule` for AI tasks.

Something missing — tell the project owner, don't enable it silently.

## The model in ten lines (details — `references/concepts.md`)

- **Schema** decides what the asset may contain and what context it gets: `StateTree Component` (context `Actor`),
  `StateTree AI Component` (+ `AIController`), plus Mass, GameplayInteractions, Camera Director and others.
  The component schemas accept only `*CommonBase` nodes (+ AI bases for the AI schema).
- **State** — `State` / `Group` / `Linked` / `LinkedAsset` / `Subtree`; selection behaviour (children in order,
  random, highest utility, weighted utility, follow transitions); enter conditions, required event, tasks.
- **Transitions** — triggers `OnStateCompleted` / `Succeeded` / `Failed` / `OnTick` / `OnEvent` / `OnDelegate`;
  priority; optional delay. No completion transition found → the tree goes back to Root.
- **Evaluators** — data only (`TreeStart`/`Tick`/`TreeStop`). **Global tasks** — run while the tree runs, and
  their completion completes the tree (or the linked frame).
- **Tasks** — logic of an active state; state completes when any (default) or all tasks complete.
  **Conditions** — enter / transition guards. **Considerations** — utility score 0..1 for selection.
- **Bindings** — instance-data properties by `Category`: `Input` (must be bound), `Parameter` (bindable, optional),
  `Output`, `Context` (auto-bound by type). Copied at EnterState, before Tick (if ticked), before ExitState.
- **Events** — `FGameplayTag` + optional payload struct; live one tick; queue limit 64.
- **Node structs are const and shared** — all runtime state lives in the **instance data** struct.

## Three modes

### 1. Write a node or wire a tree
1. Pattern from `references/cpp.md`: task (sync / ticking / async), condition, evaluator, consideration,
   external data, events from C++, running a tree on an actor (start / stop / restart).
2. The project's C++ idioms (log categories, `TObjectPtr`, validation) — `ue-cpp-authoring` if installed, and the
   project's own rules.
3. Run mode 2 on the result.

### 2. Review StateTree code
Report: `file:line — problem → fix`.

- [ ] Every mutable field lives in the `FInstanceDataType` struct; the node struct holds only config. Nothing
      writes through `const_cast` / `mutable` on the node.
- [ ] Node derives from `FStateTreeTaskCommonBase` / `FStateTreeConditionCommonBase` /
      `FStateTreeEvaluatorCommonBase` / `FStateTreeConsiderationCommonBase` (or the AI bases with the AI schema) —
      a plain `*Base` is filtered out by the component schemas and never shows up in the editor.
- [ ] `using FInstanceDataType = ...;` and `GetInstanceDataType()` return the same struct.
- [ ] Every code path ends: a task returning `Running` from `EnterState` either ticks to `Succeeded`/`Failed`,
      calls `FinishTask`, or is meant to run until a transition (say so in a comment). `bShouldCallTick = false`
      plus no async finish = a state that never completes.
- [ ] A task that does not need `Tick` sets `bShouldCallTick = false` in its constructor (default is `true`).
- [ ] Async completion goes through `Context.MakeWeakExecutionContext()` captured by the callback →
      `MakeStrongExecutionContext()` → `GetInstanceDataPtr<>()` null-check → `FinishTask(...)`. No raw `this`,
      no stored `FStateTreeExecutionContext&`.
- [ ] `ExitState` cancels whatever `EnterState` started (timers, queries, delegates, scheduled-tick handles) and
      tolerates a partial start: ExitState is called even when this task's EnterState returned `Failed`.
- [ ] An input that changes while the state is active is read in `Tick` (with `bShouldCopyBoundPropertiesOnTick`
      left `true`), not cached at `EnterState` — a non-ticking task never sees the new value.
- [ ] `bShouldStateChangeOnReselect` is deliberate: `true` (default) re-runs Enter/Exit when a parent state is
      reselected; set `false` for "hold a resource while children run" tasks.
- [ ] Events: tags are native (`UE_DEFINE_GAMEPLAY_TAG`); the payload type equals the transition's
      `PayloadStruct`; the tree is running when the event is sent.
- [ ] The component is not started/stopped from inside a task (re-entrant call is refused) — tasks finish or
      request a transition instead.
- [ ] `Input` properties marked `meta=(Optional)` when the binding really is optional (otherwise compile error).
- [ ] Editor-only `GetDescription` / icon overrides are inside `#if WITH_EDITOR`.

### 3. A tree "doesn't work"
`references/debugging.md` — the debugger, Rewind Debugger trace, logs (`LogStateTree` is **Warning** by default —
`Log`/`Verbose` lines are invisible until raised), Visual Logger, and a symptom table: transition does not
fire, task never finishes, state re-enters every tick, tree stops at start, event lost.

## Traps (each verified — see the references)

- Completion transitions: `OnStateCompleted` fires on success **and** failure; `OnStateSucceeded` misses
  failures. If no completion transition matches, the tree silently jumps back to Root and runs again.
- A state with no enabled tasks completes immediately (succeeded) — a leaf with only child-less logic loops.
- `TasksCompletion = Any` (default): the first finished task completes the state. A background task that should
  not end the state — clear "Considered for completion" on it, or switch the state to `All`.
- A global task that finishes completes the whole tree (5.6+ behaviour, CVar
  `StateTree.GlobalTasksCompleteOwningFrame`).
- `StateCompleted()` is not called when a conditional transition (tick/event) leaves the state — clean up in
  `ExitState`.
- Events live until the end of the tick's transition phase; nobody listening = lost. Over 64 queued — dropped
  with an error.
- `SendStateTreeEvent` before `StartLogic` is dropped with a warning (`bStartLogicAutomatically` starts in
  `BeginPlay`).
- `SetStateTree` / `SetStateTreeReference` are ignored while the tree is running — stop, set, start.

## Sources
Engine source only (UE 5.8). Each reference ends with a "Verified at" list of `file:line`.
