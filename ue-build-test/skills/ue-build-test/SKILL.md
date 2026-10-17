---
name: ue-build-test
description: >
  Build and test an Unreal Engine 5 C++ project without the editor window: "build", "compile",
  "clean rebuild", "run the tests", "does Shipping compile", "why doesn't it build", "stop the editor
  before building"; also writing tests — "write a test", "add an automation test", "CQTest /
  Spec". Decides what a C++ change needs — Live Coding, an incremental build, a full rebuild
  with -DisableUnity or an editor restart; runs automation tests with coverage check and
  quarantine; catches editor-only API in runtime modules with a Game-target build. Packaging a release is ue-release. Use before
  saying "it builds" or "done" about any C++ change. Russian: «собери»,
  «скомпилируй», «пересобери начисто», «прогони тесты», «компилируется ли Shipping», «почему не
  собирается», «напиши тест».
---

# ue-build-test — build, check, prove

Paths below are relative to this skill's folder (`<skill>`). The project is the nearest `.uproject`
upward from the current folder (else `CLAUDE_PROJECT_DIR`, else `--project <path>`). The engine
comes from the project's `EngineAssociation` (`UNREAL_HOME` overrides, `UE_VERSION` is the
fallback). What was found — `<skill>/scripts/ue-info.cmd`.

## Scripts

All `.cmd` live in `<skill>/scripts/`, all take `--help` and `--dry-run` (prints the exact command
line and what would block it, launching nothing). Long ones — `run_in_background: true`.

| Script | What it does |
| --- | --- |
| `ue-compile.cmd [file ...]` | incremental build of the Editor target (`<Name>Editor Win64 Development`); with files — compile only them, no link |
| `ue-rebuild.cmd` | UBT clean + build with `-DisableUnity` |
| `ue-check-blueprints.cmd [--changed\|--type A,B]` | `CompileAllBlueprints` commandlet, headless; `--changed` — only the assets that mention a reflected type from a header changed since `HEAD`; after `--` the commandlet's own switches, e.g. `-IgnoreFolder=/Game/ThirdParty`; lists the assets with warnings |
| `ue-game-build.cmd` | Game target `Shipping`, no cook; log in `Saved/ue-build-test/` |
| `ue-test.cmd [filter]` | headless automation test run; without a filter — every suite found in the sources |
| `ue-validate-data.cmd [--asset-type <Class>]` | Validate Project Data headless (`-run=DataValidation`): every `IsDataValid` and `UEditorValidatorBase`; exit 2 of the commandlet = data errors, exit 1 = another system logged an error (reported, not a data failure) |
| `ue-test-suites.cmd [--filter]` | which suites are declared in `Source/` and `Plugins/` |
| `ue-stop-editor.cmd` | close THIS project's editor and wait until its DLLs are released |
| `ue-run-editor-headless.cmd` / `ue-wait-editor.cmd` | start the editor without a window / wait until it is ready |
| `ue-tail-log.cmd [regex] [N] [--tests\|--headless]` | tail of the project log |
| `ue-clean.cmd` | delete Binaries/Intermediate/DDC (Saved — only with `--saved`) |
| `ue-selftest.cmd` | offline check of the scripts themselves |

**The verdict is the last line** `RESULT: <compile|rebuild|game-build|tests|blueprints|validation> <OK|FAILED|DEFERRED|DRY-RUN> (exit N)`.
Read it, not the exit code: `ue-compile.cmd | tail` returns `tail`'s code. `DEFERRED` means
nothing was built or checked (editor open, resource busy): say "not built" in the report, the
task is not closed. Before `FAILED` the script prints an error summary and hints.

## What to do after a C++ change

| What changed | Path |
| --- | --- |
| Only function bodies in `.cpp`, a person's editor is open | Live Coding in that editor: Ctrl+Alt+F11 (or the console `LiveCoding.Compile`). Ask the person, or go through the editor's MCP Python |
| Only function bodies, no editor | `ue-compile.cmd` |
| Mid-task, after a finished piece in a few files | `ue-compile.cmd <file.cpp\|file.h> ...` — object files only, no link; a header also recompiles every `.cpp` that includes it. Seconds instead of a full build, so errors come in small portions. Each file compiles without the module's shared PCH, so a missing `#include` that a full build forgives fails here — fix the include, do not skip the step. Not a substitute for the full `ue-compile` at the end: without the link `_API` and unresolved-symbol errors stay hidden |
| Header: `UPROPERTY`/`UFUNCTION`/`USTRUCT`/`UENUM`, fields, virtual functions, signatures | close the editor → `ue-compile.cmd` → open it. Live Coding cannot do this: it does not rebuild class layout or reflection (even with experimental reinstancing — treat it as unsupported, it breaks Blueprints) |
| Constructor, default values, `CreateDefaultSubobject` | the same: close → build → open. The CDO is already built, Live Coding does not recreate it |
| New class, new `.h`/`.cpp`, new module, `Build.cs`/`.Target.cs`/`.uproject`/`.uplugin` | close → `ue-compile.cmd` (UBT rereads the rules itself); regenerate IDE project files separately if needed |
| Broad `#include` changes, moving code between modules, deleted headers | `ue-rebuild.cmd`: `-DisableUnity` compiles each `.cpp` on its own, and a missing include that a unity blob hid becomes an error |
| A header with `UCLASS`/`USTRUCT`/`UENUM`/`UINTERFACE` changed: a reflected member renamed, removed or retyped | after the build — `ue-check-blueprints.cmd --changed`. C++ builds with code 0 while a Blueprint that used the member breaks; only compiling the Blueprints shows it. It finds the types in the changed headers, the `.uasset` files that mention them, and compiles only those (whole `Content/` without flags). It refuses stale binaries. Data assets are not compiled by the commandlet — a field removed from C++ is dropped from them silently on the next save, so look at the data assets in the printed list |
| A runtime module touched: `#if WITH_EDITOR`, editor API, module dependencies, `#if !UE_BUILD_SHIPPING` | additionally `ue-game-build.cmd`. The Editor target does not see this class of errors: `UClass::GetDisplayNameText` in runtime code builds green and breaks packaging with C2039 |
| New reflection that an in-editor tool (MCP, Python) must see | restart the editor after the build |
| Only assets or `.ini` | no build needed |

Why the editor must be closed: it holds the project's module DLLs, linking into them fails
(`LNK1104`), and with an active Live Coding session UBT refuses at once: "Unable to build while
Live Coding is active" — the build takes two seconds and nothing is built. So
`ue-compile`/`ue-rebuild` answer `DEFERRED` by themselves while this project's editor is open.
The editor does not block `ue-game-build`: the Game target builds separate binaries.

## The editor and a shared machine

- One rule: **an agent touches only what its own session started** — states (mine / another agent's / orphan /
  a person's), markers in `<project>/Saved/AgentEditors/` and machine limits are the `ue-workstation` skill,
  "Whose editor". Markers of headless editors are written by `ue-run-editor-headless`. A headless orphan may be
  closed with `ue-stop-editor.cmd --pid N`; a GUI orphan may not.
- For a build: an Editor-target build waits while someone else's editor holds this project's DLLs; my own editor
  has to be closed in a separate call. The scripts ask `ue-owner.mjs` themselves and wait `--wait` seconds
  (default 600) only for what is not ours; `DEFERRED` is not an error but contention: read the reason. Everything
  at once: `node scripts/mjs/ue-owner.mjs status`.
- Second line of defence — the `editor-guard` hook of the `ue-workstation` plugin (installed as a
  dependency of this plugin): it refuses killing editors by image name, closing someone else's
  editor by pid, launching a second editor and building with someone else's editor open, and
  records an editor that appeared during my session's call as mine.
- **Close and build are two separate tool calls**: the hook checks the command line before it
  runs and in "stop && compile" would still see a live editor.
- `ue-stop-editor.cmd` by default closes this project's headless editors that this session may
  close; `--gui` adds the GUI editor, but only my own; `--pid N[,M]` — exactly those processes,
  under the same rules. Before closing my GUI editor it refuses if the editor window is in the
  foreground and not minimised (a person is looking at it), and if Epic's toolsets
  (`AssetTools.is_dirty` over open assets and the current map) find dirty packages — otherwise
  `CloseMainWindow` would hang on "save changes?" forever. This is not asked through Python:
  VibeUE saves every dirty package before any Python call. A package that is dirty without an open
  editor is invisible to the check, and the script says so.
  Order: `CloseMainWindow` → for a console editor Ctrl+Break (UE flushes the log and exits by
  itself, without saving) → if there is neither a window nor a console (the editor was started
  `detached`: by the bridge or `ue-launch-editor`) — `quit_editor` through its own MCP server, but only if the toolsets found no dirty packages: VibeUE saves everything dirty before any Python call, and a map opened with `LoadErrors` would lose its references for good → wait up to `--timeout` (240 s: shutdown writes caches) with
  a diagnosis by log growth → `--force` (hard kill) only as an explicit last resort and only for
  my own editor: unsaved work is lost, and the next GUI start shows the package-restore modal.
  After exit it waits until the DLLs are writable and erases the marker.
- Never start a headless editor (or `ue-test`) while a person has a GUI editor of the same project
  open: headless holds the same packages, and the person's save fails with
  `MoveFile ... (Error Code 32)`. The scripts refuse by themselves.

## Tests

- After a build — the suite of the affected area: `ue-test.cmd <Suite>[+<Suite2>]` (filter by test
  path prefix). A full pass — no argument: the suite list is read from the sources
  (`IMPLEMENT_*_AUTOMATION_TEST`, `DEFINE_SPEC`), not maintained by hand. There is no empty
  filter: it would run Epic's suites.
- `OK` means: the run reached `TEST COMPLETE`, every filter token ran ≥1 test, nothing failed
  outside quarantine. A shortfall on a cold start after a build (plugin tests register late, and
  the exit is still 0) — one "warm" retry, then `FAILED`.
- Added tests — make sure their names are in the output/log. An editor started before the build
  holds the old DLLs: the new tests "don't exist" and the run is green. The script warns when the
  sources are newer than the binaries.
- A check that could not run is a FAIL, not "nothing found". A test checks the layer it claims
  to. Outside the suites the build is the gate.
- Flaky-test quarantine — `<project>/.claude/ue-test-quarantine.json` (sample
  `<skill>/templates/ue-test-quarantine.json`): the test runs, `QUARANTINED` is printed, it does
  not affect the verdict; each entry needs a reason and a date. Details, and how to read
  failures — `<skill>/references/testing.md`.
- Writing a test: first `<skill>/references/testing.md`, "Writing a test" — framework choice
  (Simple / Spec / CQTest / LowLevelTests / Functional), flags, `WITH_AUTOMATION_TESTS`,
  `Test*()` instead of `check`, the traps where a test silently does nothing. An end-to-end run
  of a packaged build goes on Development: Shipping writes no log, and Test cannot be built with
  a launcher engine.

## Headless editor

Only when there is no way without a live editor (MCP inside the editor, a live log); a one-off
test run is `ue-test`, a one-off Python run is a commandlet. Rules, flags and the `-script=` trap
with a space in the path — `<skill>/references/headless.md`. Started one — stop it with
`ue-stop-editor.cmd` as soon as it is not needed, and in any case before the final report.

## Done means

The plugin's `unbuilt-cpp` hook holds this: a C++ source under `Source/<Module>/` (project or plugin) that this
session edited and that is newer than its module's `UnrealEditor-<Module>*.dll` stops the turn from ending, with
the list. Build, or say plainly why the build is impossible now. Off with `UE_BT_STOP_CHECK=0`.


- `ue-compile` without file arguments (or `ue-rebuild`) — `RESULT: ... OK`; for a runtime-module change also
  `ue-game-build` OK. `DEFERRED` is not done.
- After a reflected header change — `ue-check-blueprints --changed` OK.
- The affected area's suite is green, if there is one.
- Any failure or skip goes into the report with the exact error (`file:line` from the summary)
  and the riskiest unchecked spot.
