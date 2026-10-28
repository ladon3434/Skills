# Assertions, threads, UHT errors, engine upgrades

Engine facts (checked against UE 5.8 `Misc/Build.h`, `Misc/AssertionMacros.h`). Whether the project prefers
`check()`/`ensure()` over a defensive `if` is the project's call; the semantics below are not.

## check / ensure / verify by configuration

| Macro | Development / DebugGame | Shipping (defaults) |
| --- | --- | --- |
| `check(Expr)` | evaluates; crashes on failure | **not evaluated at all** (`DO_CHECK = USE_CHECKS_IN_SHIPPING`, 0 by default) |
| `ensure(Expr)` | evaluates; on failure logs a callstack once per call site, continues; returns the result | evaluates and returns the result, **reports nothing** (`DO_ENSURE = USE_ENSURES_IN_SHIPPING`, 0) |
| `verify(Expr)` | evaluates; crashes on failure | evaluates, result ignored |

- **No side effect inside `check()`** — in Shipping the whole expression is gone:
  ```cpp
  check(Inventory.RemoveItem(ItemId));           // WRONG: RemoveItem never runs in Shipping
  const bool bRemoved = Inventory.RemoveItem(ItemId);
  check(bRemoved);                               // right
  ```
  An operation that must run everywhere but should still crash in dev on failure — `verify()`.
- `ensure()` where the game can go on (log and take the safe branch: `if (!ensure(Ptr)) { return; }`); `check()`
  only for an invariant after which continuing is meaningless. Designer data is not an invariant — see
  SKILL.md «Validation».
- `ensure()` fires once per call site per run; `ensureAlways()` every time.
- Tests never assert with these: they crash the runner instead of failing the test (`TestTrue`/`TestEqual`).

## Threads

- A `UObject` is touched only on the game thread: no property access, no calls, no `GetWorld()` from a task,
  `FRunnable` or the thread pool. `Assertion failed: IsInGameThread()` in a log means exactly that.
- Back to the game thread with a weak pointer, re-validated on arrival:
  ```cpp
  TWeakObjectPtr<UMyThing> WeakThis(this);
  AsyncTask(ENamedThreads::GameThread, [WeakThis]()
  {
      if (UMyThing* Self = WeakThis.Get())
      {
          Self->OnWorkFinished();
      }
  });
  ```
  The same rule holds for any lambda that outlives the call (delegates, timers, async loads): capture
  `TWeakObjectPtr`, not `this`; for UObject-bound delegates prefer `AddUObject`/`BindUObject`/`BindWeakLambda`,
  which unbind themselves. An object that sets timers clears them in `EndPlay` / `Deinitialize`
  (`GetWorldTimerManager().ClearAllTimersForObject(this)`).
- A non-UObject holding a strong ref to a UObject: `TStrongObjectPtr`, or derive from `FGCObject` and report it in
  `AddReferencedObjects`.

## Soft references and delegates

- `TSoftObjectPtr::Get()` only looks — it returns null for an unloaded asset. `LoadSynchronous()` loads; take the
  result into a local and validate before use, never `Soft.LoadSynchronous()->Member`.
- Single-cast delegate: `ExecuteIfBound(...)`, not `IsBound()` + `Execute()`.
- A dynamic multicast delegate for Blueprints — `UPROPERTY(BlueprintAssignable)`.

## Blueprint surface that nothing uses yet

- A `BlueprintCallable` / `BlueprintAssignable` that no asset and no C++ calls today is **not** dead code: assets
  arrive after code. Rider/ReSharper (`CppUEBlueprintCallableFunctionUnused`, `CppDeclaratorNeverUsed`) cannot see
  `.uasset` usage — their «never used» on such API is a false positive, not a reason to delete it.
- The defect is API that **cannot** be used for its purpose (e.g. a «started» delegate a Blueprint cannot bind
  before it fires). Remove that, and remove it early: while no asset references it, it is a one-line change;
  after the first reference it is a broken asset plus a redirect.
- New surface is still added only where a designer or a `WBP_*` uses it (SKILL.md «Comments and style»).

## UHT and link errors

| Error | Cause | Fix |
| --- | --- | --- |
| `Cannot find generated.h` / generated header mismatch | file name ≠ class name without its prefix (`AMyDoor` → `MyDoor.h`) | rename the file |
| `GENERATED_BODY() not in class` / missing | macro absent or outside the class body | first line inside every `UCLASS`/`USTRUCT` |
| `BlueprintReadWrite`/`BlueprintReadOnly` on a private member rejected | UHT refuses Blueprint access to private fields | `meta = (AllowPrivateAccess = "true")` or move to `protected` |
| `unresolved external symbol` at **link** time | type used across modules without `<MODULE>_API`, or the module missing in `Build.cs` | add the export macro / the dependency |

The `_API` miss surfaces only when another module links against the symbol, so the owning module builds clean.
`.generated.h` is the last include of a header; `#include UE_INLINE_GENERATED_CPP_BY_NAME(<Class>)` right after a
`.cpp`'s own header compiles the generated code into that translation unit (worth it with unity builds off; add to
new files, do not retrofit unasked).

## Engine upgrade: target settings

- `DefaultBuildSettings = BuildSettingsVersion.Vn` and `IncludeOrderVersion = EngineIncludeOrderVersion.Unreal5_x`
  in both `*.Target.cs` follow the engine in `.uproject` `EngineAssociation` — read it, do not guess.
- A stale pair against an **installed** engine does not fail with include errors — it refuses to build:
  `<Target> modifies the values of properties: [ ... ]. This is not allowed, as <Target> has build products in
  common with UnrealEditor.` The installed engine was compiled with its own defaults and the editor target shares
  that build environment.
- UBT prints the required version in the `[Upgrade]` block just before the failure — take it from there.
  Not the escape hatches it also offers: `BuildEnvironment = TargetBuildEnvironment.Unique` needs a source-built
  engine, and `bOverrideBuildEnvironment = true` silences the check while compiling the project against
  settings different from the precompiled engine.
