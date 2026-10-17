# Reviewing changes

Review of changed lines — a diff, a commit, a commit range, a PR — separate from writing them.
A whole module is analysis (`SKILL.md`). The conventions to check against come from the
project: its `CLAUDE.md`, `.claude/rules/`, architecture page, `.clang-format`.

## Order

1. Take the whole diff (`git diff <base>...HEAD`, `git show <sha>`), the file list —
   `git diff --stat`. A big diff — split by module and hand out to agents in one
   message, each with its own piece and the checklist below.
2. For every changed place read enough surroundings to judge the
   behaviour, not the form: callers (`rg`), the declaration (`engine-api.cmd` for engine
   API), the owner's lifecycle.
3. Say whether the change was built and whether tests ran — the check status is part of the review.
   Not built — write exactly that, not "looks correct".

## Scope of the check

One or two files pointed at — the general items plus those the code itself touches:

| The code has | Items |
| --- | --- |
| `.h` edits, pointer fields to `UObject`, lambdas in delegates, timers | Memory and GC, Lambdas and timers, Lifecycle |
| `Tick`, `Cast<>` in hot code, heavy parameters, logs in a loop | Performance |
| `FText`, strings in UI, `FText::FromString` | Names and texts |
| attributes, abilities, effects, ASC | GAS checklist (`ue-gas`, if installed) |
| `Replicated`, `DOREPLIFETIME`, `OnRep_`, `Server`/`Client`/`NetMulticast`, `HasAuthority`, ownership, dormancy | `review-replication.md` |

Reviewing a module, folder or branch before release — all items, whatever is visible
in the code: the goal is to find the unexpected too. Review does not change logic; each finding —
`file:line — what — why → how`.

## Unreal C++ checklist

- **Memory and GC.** A raw `UObject*` in a field without `UPROPERTY`/`TObjectPtr` — collected by GC
  under your feet; the same for `TArray`/`TMap`/`TSet` holding `UObject*` — the container goes under
  `UPROPERTY()` too (empty if the editor does not need it). A non-`UObject` class holding a `UObject` —
  `TStrongObjectPtr` or `FGCObject` with `AddReferencedObjects`. A non-`UObject` pointer under
  `UPROPERTY` is an error; ownership — `TUniquePtr`/`TSharedPtr`. A non-owning reference —
  `TWeakObjectPtr`, dereferenced only after `IsValid`/`Get()`: an extra `UPROPERTY` makes the
  reference strong and extends the life of an object that should die. `GENERATED_BODY()` as the first
  line of every `UCLASS`/`USTRUCT`. `NewObject` with the wrong `Outer`.
- **Lambdas and timers.** A raw `[this]` in `AddLambda`/`BindLambda`, in a timer lambda or
  an async load outlives the owner's GC — an intermittent crash in the callback, not where the
  error is. Instead — `AddUObject`/`BindUObject`/`BindWeakLambda` (they unbind themselves) or a
  `TWeakObjectPtr` capture re-checked inside. A class calling `SetTimer` clears its timers in
  `EndPlay` (`GetWorldTimerManager().ClearAllTimersForObject(this)`), a subsystem — in
  `Deinitialize`.
- **Lifecycle.** Subscribing in `BeginPlay` without unsubscribing in `EndPlay`; logic in the constructor
  that needs the world (`GetWorld()` on the CDO is `nullptr`, the world exists no earlier than `PostInitializeComponents`);
  `PostLoad` versus `PostInitProperties`; the CDO modified as an instance. A `UObject` is touched only
  on the game thread; returning from a task — `AsyncTask(ENamedThreads::GameThread, ...)` with a weak capture.
- **Performance.** `bCanEverTick = true` with an empty `Tick` or a `Tick` of a single
  `Super::Tick` — turn it off and delete it; a `Tick` with real work is fine (optimise
  inside, do not remove). Periodic work — a timer, not `Tick`. `Cast<>` every frame or in a loop —
  cache in `BeginPlay` or an interface. `FString`/`TArray`/`TMap`/heavy structs passed by
  value — `const&`; `for (auto X : Arr)` over heavy elements copies — `const auto&`.
  A literal in `UE_LOG` without `TEXT()`; a log in a hot path.
- **Failures.** A returned `bool`/`nullptr`/`FResult` ignored — a reader function whose
  verdict is thrown away as a whole statement (`ParseVector(Json, Out);`)
  leaves the value at its initialiser while the tool reports success. `check` where
  the data is user data (should be an error, not a crash). `ensure` in a hot loop.
- **Editor-only in runtime.** `GetDisplayNameText`, `GetMetaData`, `WITH_EDITORONLY_DATA`
  fields outside `#if WITH_EDITOR` in a runtime module: the editor target is green, Game/Shipping
  fails (`hazards.cmd editor-only`). Prove it with a Game-target build.
- **Multi-asset operations.** A tool that creates several assets leaves them on disk
  without rollback on error. Saving a package inside a transaction that is
  promised to roll back.
- **Checks that check nothing.** A `Verify*`/test compares the arguments with
  themselves, not with the world; a test on a cube where the bug shows only on a real mesh;
  `AlwaysTickPose` in a headless bone test — every assert reads the reference pose
  (`engine-api.cmd EVisibilityBasedAnimTickOption`).
- **Tool contract versus code.** Declared "idempotent", yet the second call
  fails or adds more; "rollback through a transaction", yet the package is saved; `dry-run`,
  yet the branch still writes.
- **Tags and strings.** A gameplay tag declared outside its module's tag file, or
  hard-coded as a string.
- **Names and texts.** Prefixes `A`/`U`/`F`/`E`/`T`/`S`/`I`, `b` on bools, PascalCase. Player-visible
  text — `FText` through `LOCTEXT`/`NSLOCTEXT`, not `FText::FromString("...")`; `LOCTEXT`
  needs `#define LOCTEXT_NAMESPACE` at the top of the `.cpp` and `#undef` at the end. `FName` — for
  identifiers and keys. A setting shared by all instances — `EditDefaultsOnly`, not
  `EditAnywhere`; a numeric field with sensible bounds — `ClampMin`/`ClampMax`; balance numbers
  hard-coded in C++ — a candidate for a data asset or settings.
- **UHT and formatting.** A long `meta=(ToolTip="...")` that clang-format
  will split into adjacent literals (`hazards.cmd ToolTip`).
- **Comments.** The contract — in the header; in the `.cpp` — only the non-obvious "why"
  next to the line. Change history does not live in comments.
- **Logging** — against the project's conventions (categories, macros, levels).

## Cross-vendor reviewer (codex)

Only for an expensive or irreversible decision (rewriting something that works, choosing an execution
branch) or on the owner's word; ordinary changes do not call it.

```bash
codex exec --sandbox read-only -m <model> -c model_reasoning_effort="high" \
  --cd "<project root>" "$(cat <brief file>)" < /dev/null > <report file> 2>&1
```

- `< /dev/null` is mandatory — without it `codex exec` hangs on stdin.
- In a read-only sandbox it cannot write a file: the brief says so and asks for the whole report
  on stdout; the caller redirects it.
- The brief carries the whole subject and demands one verdict on a named claim —
  `accept` · `return` · `cannot establish` — with references and a cheaper
  alternative if there is one.
- Exit 0 with an empty report is also a failure (`codex` can fail silently): check the file size.
- Its false alarms are sorted out by whoever called it; the owner is not asked to choose.

No `codex` on the machine — the same brief goes to `agy` with Gemini Pro (not Flash, not `gpt-oss`,
not `claude-*`); why, and how it is worse — `external-voices.md`:

```bash
cd <empty report folder> && agy --model gemini-3.1-pro-high --add-dir "<subject>" \
  --print-timeout 900s -p "$(cat <brief file>)" < /dev/null > <report file> 2>&1
```

- `agy` has no read-only mode (`--mode plan` writes too): the brief forbids edits, and after
  the call `git status --short` confirms the subject is untouched.
- Its verdict is evidence, not a decision: Claude checks a load-bearing finding against the code itself.
