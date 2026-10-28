# Debugging: prove the root before the fix

When something misbehaves and the cause is not proven: a failing or flaky test, a
crash, a failed check, a tool error, a bug from PIE, behaviour that contradicts the code. Especially
under deadline pressure, after a fix that did not help, and when the fix looks obvious.

The agent does not drive an IDE debugger itself: logs and markers at layer boundaries are its debugger.
Breakpoints are set by a person — exactly where, below ("Breakpoints").

The crash site is a symptom: the pointer was dereferenced here but corrupted earlier. Look for the cause.
The cause is already identified (the stack points into one of your own functions, the symptom is in the tables below, the edit is local) —
confirm it by reading and fix, no breakpoints or instrumentation. Unclear, intermittent, smells of
GC or threads, the stack is entirely in the engine — the full path: evidence → cause from the list → breakpoints or
instrumentation → edit. The final check is mandatory in both cases.

## Where the evidence is

- **Known hazards first** — `<skill>/scripts/hazards.cmd <symptom words>`. The most
  frequent: the live editor runs stale module DLLs — make sure the running editor was
  started after the build with the edit.
- **Logs** — `Saved/Logs/<Project>.log` (backups next to it). Never read it whole: filter by `Fatal`,
  `Error`, `Assertion failed`, `ensure`, or `log-scan.cmd` (below). Taking a big log apart —
  the `log-triage` agent; cite the path and lines, do not paste the body.
- **Build, cook, UAT logs** — `<skill>/scripts/log-scan.cmd [--since <min> | --latest N]`
  (in Bash — `log-scan`): suspicious `file:line` lines by kind (`fatal`, `accessed-none`,
  `blueprint`, `asset`, `package-version`, `error`), repeats collapsed into `xN`. Looks at
  the project's `Saved/Logs` and the UAT folders (`%APPDATA%\Unreal Engine\AutomationTool\Logs`, shared per
  engine — only logs that name this project are taken; `--all-uat` — all). A "SUCCESS" build with
  Blueprint warnings, broken references and `Accessed None` is what ships to the player. Exit
  code 1 — there are findings.
- **Crashes** — editor: `Saved/Crashes/<CrashGUID>/` (`CrashContext.runtime-xml` — callstack +
  error, `.dmp`, `.log`, `Diagnostics.txt`); packaged build — `%LOCALAPPDATA%\<Project>\Saved\Crashes\`;
  symbols for the `.dmp` — the `.pdb` next to the binary. Read the **tail** of the crash log (`Fatal error`,
  `Assertion failed`, `Unhandled Exception`, callstack), tell the nature from the address (table
  below), take the **top frame of your own module**, not the engine's, and go from it to the cause.
  All of that in one call: `<skill>/scripts/crash-triage.cmd [<folder> | <.dmp>]` (Bash: `crash-triage`; no path —
  the newest crash). It reads `CrashContext.runtime-xml` (`CallStack` is symbolicated when the PDBs were there at
  crash time; a bare module name or `UnknownFunction` means they were not) and the folder's log, marks the first
  project frame, and for an unsymbolicated stack runs `cdb -lines -z <dmp> -y <binaries dirs> -i <same> -c ".ecxr;kn 50;q"`.
  A packaged build: `--symbols <its PDB folder>`; OS frames: `--ms-symbols` (downloads from Microsoft).
  No `cdb`: `winget install Microsoft.WinDbg` (or the Windows SDK feature "Debugging Tools for Windows").
  Engine frames without names in a launcher engine: Epic Launcher → the engine's Options → "Editor symbols for debugging".
  A GPU crash (`DXGI_ERROR_DEVICE_HUNG`, `OnGPUCrash` on top) — the CPU stack is only the reporter: read the GPU
  breadcrumbs; a stack overflow — the repeating frame is the cycle.
- **Reproduction** — an automation test by filter (`UnrealEditor-Cmd <uproject> -ExecCmds="Automation RunTests <filter>;Quit" -unattended -nullrhi -nosplash`
  or the project's script), a paired result check, a headless repro. `git bisect` + a test by
  filter is an option, but a commit is not guaranteed to build: a red step may be about something else.
- **Chains to instrument layer by layer:**
  - tool/MCP → bridge → server → editor game thread → asset on disk;
  - gameplay → input mapping → controller/pawn → ability/effect (GAS) → component →
    asset config.
- A change that moves the symptom is evidence, not a failure: do not revert it wholesale.
  Two sub-causes in one bug are normal.
- A foreign engine mechanism is unclear — `engine-reader`; a signature — `engine-api.cmd`.

## What the address and the log line say

| Address / entry | What it is |
| --- | --- |
| `0x00000000` or a small offset | nullptr dereference |
| `0xDDDDDDDD` | freed memory (use-after-free) |
| `0xFEEEFEEE` | freed Windows heap |
| `0xCDCDCDCD` / `0xCCCCCCCC` | uninitialised heap / stack |
| `0xFDFDFDFD` | buffer overrun (guard bytes) |
| `EXCEPTION_STACK_OVERFLOW` | infinite recursion |
| `Pure virtual call` | a virtual call during object destruction |
| `LogScript: Warning: Accessed None` | an empty reference in a Blueprint — look for the C++ that feeds the value into the graph |
| `LogGarbage: ... is not rooted` | a `UObject` not protected from GC |
| `LogUObjectGlobals: Warning: Failed to find` | wrong asset path or the asset was not cooked |
| `Assertion failed: IsInGameThread()` | game-thread API called from a task / `FRunnable` |
| `check()` / `ensure()` failed | an invariant broke — read the message; `ensure` is not fatal but gets investigated |

## The cause — from the list, most frequent first

1. The pointer was alive when written and empty when used — a `UObject*` field (or a container holding one)
   without `UPROPERTY()`: GC does not know about it.
2. A lambda captured a raw `this` and lives in a delegate, timer, async load — the crash is
   intermittent and inside the callback.
3. A timer outlived its owner — there is `SetTimer` but no `ClearAllTimersForObject` in `EndPlay`.
4. `GetWorld()` == nullptr — a call from a constructor or on the CDO.
5. `Cast<>` returned nullptr and the result was not checked. A cast that must succeed — `CastChecked<>`: a crash
   with a clear message, not at a random address.
6. Wrong thread — a `UObject` outside the game thread.
7. A soft reference is not loaded — `TSoftObjectPtr::Get()` only looks; `LoadSynchronous()` loads,
   the result goes into a local variable and is checked.
8. Recursion — a cycle in a Blueprint graph or an `OnRep_` that changes its own replicated field.
9. Slate/UMG — the widget was removed from the hierarchy or its children are not created yet.

## Breakpoints (for a person with an IDE)

- **Configuration.** In `Development Editor` breakpoints in project modules often do not bind: entry points
  get inlined, the IDE answers "No executable code is associated with this line". You need
  `DebugGame Editor` and a rebuild; breakpoints in the engine are not affected.
- **On the source, not on the crash** — the last place where the state is still known to be right:

| Crashes on | Set it on |
| --- | --- |
| a pointer dereference | the assignment of that pointer |
| access to a collected object | `BeginDestroy()` of its class |
| a timer callback | the `SetTimer` call |
| a wrong value | the function that produced it |
| `Accessed None` in a Blueprint | the C++ function feeding the value into the graph |

- An intermittent bug in a frequently called function — only a conditional breakpoint (`Ptr == nullptr`,
  `Health <= 0.f && !bIsDead`); a heisenbug — a logpoint without stopping.

## Instrumentation

The debugger is not applicable — temporary logs, and only temporary: values, not "entered the function";
both sides of a hand-off (caller and callee); `ensure` instead of `check` — a stack and keep going, not
a crash on the first hit; the project's log category, not `LogTemp`. Cause found — remove it all.

## What not to do

- A nullptr check where the pointer has no right to be empty is masking: the crash
  becomes a silently broken mechanic. First explain why it is empty.
- Do not move code from the constructor into `BeginPlay` "just in case" — first understand why
  it is there.
- Do not add `UPROPERTY()` without understanding ownership: it makes the reference strong.
- Do not read big logs and dumps whole — the tail and a filter.

## Done when

- The root is named in one sentence with evidence (log path + lines, test output).
- The check that reproduced the failure now passes — or it is stated explicitly why
  there is none and what was verified instead. The edit is built the project's way (or with `ue-build-test`),
  the original scenario is repeated, no crash: an edit without this check is a hope, not a fix.
- No unrelated changes came along with the fix.
- A behavioural fix is proven headless; what only a person can see is a question for
  the owner (a quick look) or a playtest step.
- A repeatable hazard is recorded as one section in known-hazards (`hazards.cmd` tells where).
