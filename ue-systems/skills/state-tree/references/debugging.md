# Debugging StateTree (UE 5.8)

`ST` = `<engine>/Engine/Plugins/Runtime/StateTree/Source`,
`GST` = `<engine>/Engine/Plugins/Runtime/GameplayStateTree/Source/GameplayStateTreeModule`.

## 1. Tools

**Rewind Debugger + StateTree trace.** In 5.8 recording and visualising StateTree data moved to the Rewind
Debugger: start recording there and it switches on the `StateTreeDebugChannel` trace channel; each instance shows as
a `StateTreeInstance` track (active states, task/condition/transition events, logs). The old in-editor window is
still available through Editor Preferences → StateTree Editor → *Enable Legacy Debugger Window*.
- Console: `statetree.startdebuggertraces` / `statetree.stopdebuggertraces`.
- Trace recording exists in non-Shipping builds (and editor); the debugger UI only in Editor/Program targets.
- Breakpoints in the asset editor: on state/task enter, exit, transition.

**Logs.** Category `LogStateTree` — **default verbosity `Warning`**, so the start/stop/state lines
(`Log`) and the per-task Enter/Tick/Exit trace (`Verbose` / `VeryVerbose`) are hidden. Raise it:
`log LogStateTree Verbose` (console) or `[Core.Log] LogStateTree=Verbose` in `DefaultEngine.ini`.
Every runtime line goes through `UE_VLOG_UELOG` — it is also in the **Visual Logger** under the owner actor.
Editor/compiler messages — `LogStateTreeEditor`; `StateTree.Compiler.LogResultOnCompilationCompleted 1` dumps the
compiled tree.

**Gameplay Debugger.** `UStateTreeComponent` is a `UBrainComponent`; its `GetDebugInfoString()` (active states,
etc.) is what the AI "BehaviorTree" category prints for the brain component.

**Runtime validation CVars** (non-Shipping): `StateTree.RuntimeValidation.EnterExitState 1` — every EnterState gets
an ExitState and vice versa; `StateTree.RuntimeValidation.InstanceData 1`; `...Context` (default on) — context
parameters stay the same between creations.

**Behaviour CVars to rule out** (migration switches): `StateTree.GlobalTasksCompleteOwningFrame`,
`StateTree.TickGlobalNodesFollowingTreeHierarchy`, `StateTree.CopyBoundPropertiesOnNonTickedTask`,
`StateTree.CaptureStateEventPayloadForSustainedState`,
`StateTree.TargetStateRequiresTheSameEventForStateSelectionAsTheRequestedTransition`.

## 2. Symptom → cause

| Symptom | Check |
|---|---|
| Tree never starts, warning "Context Requirements ... failed. Component tick is disabled." | Schema context not satisfied: Actor is not of `ContextActorClass`; AI schema on a component without an AIController; required external data missing. |
| Error "Failed to select initial state" → tree `Failed` at start | No root child can be entered: all enter conditions false, required event absent, `SelectionBehavior = None`, everything disabled. |
| `OnEvent` transition does not fire | Tree not running yet (warning "Trying to send event to a State Tree that is not started yet."); tag mismatch (the sent tag must equal the required tag or be its child — a parent tag does not match); `PayloadStruct` set but no payload or a payload of another struct sent; the event was consumed by an earlier selection (`bConsumeEventOnSelect`); queue over 64 (error "Too many events"); a higher-priority transition won that tick. |
| Completion transition does not fire | Trigger is `OnStateSucceeded` but the state failed (or vice versa) — use `OnStateCompleted`; a task never finishes (below); `TasksCompletion = All` and one task runs forever; the transition sits on a child while the completed state is the parent (completion is checked bottom-up from the completed state). |
| State restarts in a loop | No completion transition matched → "Could not trigger completion transition, jump back to root state." (Verbose). Also: a state with no enabled tasks completes immediately. |
| Task never finishes | `bShouldCallTick = false` and nothing calls `FinishTask`; async callback captured a stale context instead of `MakeWeakExecutionContext()`; `Tick` returns `Running` on every path. |
| Task sees a stale input | `bShouldCallTick = false` (no tick → no copy) or `bShouldCopyBoundPropertiesOnTick = false`; value cached in EnterState. |
| Task Enter/Exit runs on every child change | `bShouldStateChangeOnReselect = true` (default) on a parent-state task; set `false` for hold-type tasks. |
| Whole tree stops when a "background" global task ends | Global tasks complete the owning frame (5.6+). Keep it `Running` or make it an evaluator. |
| Cleanup skipped | Put it in `ExitState`; `StateCompleted` is not called on tick/event transitions. |
| Error "Reentrant call to ... is not allowed." | `StartLogic`/`StopLogic`/`RestartLogic` called from inside the tree's own tick (a task, a delegate it fires). |
| Node missing from the editor's node picker | Derives from `FStateTreeTaskBase` (not `...CommonBase`) under the Component schema; AI node under the non-AI schema. |
| Compile error "Input property 'X' ... is expected to have a binding." | Bind it, or mark it `meta=(Optional)`. |
| Compile error "Could not find matching Context object for Context property" | No schema context of that type — bind manually or change the property type/category. |
| New asset set at runtime is ignored | `SetStateTree`/`SetStateTreeReference` while running — warning "Trying to change the state tree on a running instance." Stop first. |

## Verified at
- Migration to Rewind Debugger, legacy window setting — `ST/StateTreeEditorModule/Private/Debugger/SStateTreeDebuggerView.cpp:653-656`; `Public/StateTreeEditorSettings.h:52`
- Rewind recording toggles the channel — `ST/StateTreeDeveloper/Private/StateTreeRewindDebuggerRecordingExtension.cpp:15-35`
- Track name — `ST/StateTreeEditorModule/Private/Debugger/StateTreeRewindDebuggerTrack.cpp:116`
- Trace channel — `ST/StateTreeModule/Private/Debugger/StateTreeTrace.cpp:24`
- Console commands — `ST/StateTreeModule/Private/StateTreeModule.cpp:95-107`
- Trace / debugger build support — `ST/StateTreeModule/StateTreeModule.Build.cs:13-28`
- Breakpoint types — `ST/StateTreeModule/Public/Debugger/StateTreeDebuggerTypes.h:18-24`
- `LogStateTree` default `Warning` — `ST/StateTreeModule/Public/StateTreeTypes.h:17`
- Logs go to Visual Logger — `ST/StateTreeModule/Private/StateTreeExecutionContext.cpp:25`; `GST/Private/Components/StateTreeComponent.cpp:14`
- Compiler dump CVar — `ST/StateTreeEditorModule/Private/StateTreeCompiler.cpp:104-109`
- Brain debug info → gameplay debugger — `GST/Private/Components/StateTreeComponent.cpp:606-613`; `<engine>/Engine/Source/Runtime/AIModule/Private/GameplayDebugger/GameplayDebuggerCategory_BehaviorTree.cpp:46`
- Runtime validation CVars — `ST/StateTreeModule/Private/Debugger/StateTreeRuntimeValidation.cpp:17-44`
- Behaviour CVars — `StateTreeExecutionContext.cpp:38-87`
- Context requirements warning — `StateTreeComponent.cpp:208-211`
- Initial state failure — `StateTreeExecutionContext.cpp:1625-1631`
- Event dropped before start / queue full — `StateTreeComponent.cpp:577-583`; `ST/StateTreeModule/Private/StateTreeEvents.cpp:45-47`
- Jump back to root — `StateTreeExecutionContext.cpp:6302-6306`
- Re-entrant call — `StateTreeComponent.cpp:131-135`
- Running-instance asset change refused — `StateTreeComponent.cpp:476-479`
- Event match: sent tag `MatchesTag` required tag, payload `IsChildOf` PayloadStruct — `ST/StateTreeModule/Private/StateTreeTypes.cpp:249-262`
- Compile errors (Input / Context) — `ST/StateTreeEditorModule/Private/StateTreeCompiler.cpp:3128-3136`, `3175-3178`
