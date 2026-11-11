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
4. Before reporting, try to refute every finding against the code: a guard higher up the
   stack, a guarantee in the base class or the engine (`engine-api.cmd`), a known idiom
   (`hazards.cmd`) — an empty `UPROPERTY()` kept for GC, a raw `UObject*` in a local. Drop a
   finding only when a concrete refutation is found, with its `file:line`; "seems debatable"
   is not one — LLM verdicts flip under counter-argument, more often towards the wrong answer.
   Neither proven nor refuted — keep it, marked "unconfirmed". Many findings (a branch before
   release) — hand the check to the `code-analysis:refuter` agent (Opus whatever the main
   model is), which gets only the findings and the code; several batches — several refuters in one message.

Plain formatting and what the compiler catches are not findings: clang-format and the build
own them.

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

## Second opinion: Fable plus the external voices

When: an expensive or irreversible decision (rewriting something that works, choosing an execution
branch, deleting a system), a branch or module before release, or the owner's word ("с внешними",
"with codex", "second opinion"). Ordinary changes do not call it.

1. **Who** — `review-voices list` first (Bash; from PowerShell `<skill>\scripts\review-voices.cmd list`),
   then the table in `external-voices.md`, "Which voices". The `fable` voice (the `code-analysis:reviewer`
   agent) is always one of them; the subject (internal / external / system), the owner's word and what the
   machine has decide whether `agy` and `codex` join it. Our own code is an internal subject: the external
   voices only on the owner's word.
2. **Brief** — `brief.md` in a folder of its own outside the repository (the voices may read that folder and
   the subject, nothing else). It carries: the subject (the range for `git diff`, or the files), the project
   root, the engine root (`ue-engine.mjs`), the absolute path of this file with the checklist sections the
   change calls for (plus `review-replication.md` for networking), the claim to judge if there is one, and
   the output demand — findings as `severity 0-3 — file:line — what — why → how`, and on the claim one verdict
   `accept` · `return` · `cannot establish` with a cheaper alternative if one exists. A big diff goes into
   `diff.patch` next to the brief, named by its path.
3. **Run, in one message:**
   - the external voices, when step 1 calls for them, in Bash in the background with an outer bound of the cap plus a margin:
     `timeout 1100 review-voices run --brief <brief folder>/brief.md --subject <project root>` (default cap
     15 min; `--timeout-min N` → `timeout (N+3)*60`). Reports go to a new temp folder it prints, outside the
     brief folder; each voice runs read-only (agy under deny rules for every write and command, codex in its
     read-only sandbox);
   - always the `fable` voice — the `code-analysis:reviewer` agent with the path of the same brief. Without
     external voices (step 1 says so, or `review-voices` ends with exit 3) it is the whole review, and the
     report says there was no cross-vendor voice. Fable unavailable on the account (the agent fails on the
     model) — there is no second opinion: stop the `review-voices` run, use none of its reports, no substitute
     model, and tell the owner "second opinion not done: no Fable on this account".
4. **Read the outcome** — the last line `RESULT: voices <voice>=<status> ... untouched=<state>`:
   - `OK` — a report; `PARTIAL` — a report, but a read was denied and it may rest on part of the subject;
     `EMPTY`, `FAILED`, `TIMEOUT` — "did not answer" in the report, the synthesis does not wait for it;
   - `untouched=CHANGED` (exit 4) — the subject's content moved during the run: a voice or a person working in
     parallel. Revert nothing yourself — show the person `git status` and ask; `UNCHECKED` — say "not verified".
5. **Synthesis.** Every report is evidence, not a decision. A finding a conclusion rests on is checked
   against the code — by Claude itself or by `code-analysis:refuter`. A finding only one voice made is not
   weaker for that; one that rests on agreement within one vendor (Fable and the main session) is marked so.
