# Tests: how a run works and how to read failures

## What `ue-test.cmd` runs

```
UnrealEditor-Cmd <project>.uproject "-ExecCmds=Automation RunTests <filter>; Quit"
  -unattended -nopause -nosplash -RenderOffScreen -NoLogTimes -ABSLOG=<Saved/Logs/<Name>-Tests.log>
  -SCCProvider=None -nosound "-TestExit=Automation Test Queue Empty"
```

The exact line for the current project is printed by `ue-test.cmd --dry-run`.

- `-RenderOffScreen` — the editor lives fully, but without a window. `-nullrhi` does not fit: in UE 5
  it breaks editor/Slate initialisation.
- Its own `-ABSLOG`: with a GUI editor open, `Saved/Logs/<Name>.log` belongs to it, and the second
  process writes `<Name>_2.log` — the coverage check would read someone else's log. A path with a
  space in `-ABSLOG=` (as in `-script=`) is silently ignored by the editor, so the script rejects
  such a path; `UE_TEST_LOG_DIR` changes the folder.
- `-SCCProvider=None` — no background git/p4 against the working copy; `-nosound` — a test that
  plays a sound does not play it through the speakers.
- By default the editor's output does not go to the console (it is huge): progress is in the log,
  `ue-tail-log.cmd --tests`. `--verbose` turns on `-stdout`.
- `--timeout` (minutes, default 30): the script kills a hung run — it is its own child process —
  and gives `FAILED`.

## How the verdict is reached

The script reads the log, not just the exit code. The automation controller writes for each test
`Test Started ... Path={P}` and `Test Completed. Result={Success|Fail|...} ... Path={P}`, the test's
errors go between `BeginEvents: P` and `EndEvents: P`, and at the end — `**** TEST COMPLETE. EXIT CODE: N ****`.

| Situation | Verdict |
| --- | --- |
| No `TEST COMPLETE` (crash, hang, early exit) | FAILED, naming the test that was running |
| `Result={Fail}` outside quarantine | FAILED, test path + first `Error:` lines |
| A filter token ran no tests | one "warm" retry, then FAILED |
| Exit code ≠ 0, but no failed tests in the log | FAILED |
| Only quarantined tests failed | OK, they are printed as `QUARANTINED` |

A cold start after a build can run RunTests before the tests of editor modules and plugins
register: a subset runs, the queue empties, exit 0. Hence the "every token ≥1 test" check and the
retry.

Parse a finished log without running anything: `node <skill>/scripts/mjs/ue-test-log.mjs <log> <filter>
[--quarantine <json>]`.

## Quarantine

`<project>/.claude/ue-test-quarantine.json` (or `--quarantine <file>`, or
`UE_TEST_QUARANTINE`). Sample — `<skill>/templates/ue-test-quarantine.json`.

```json
{ "quarantined": [ { "token": "Game.Net.LatencySpike", "reason": "timing, ~1 in 10", "since": "2026-10-01" } ] }
```

- `token` — a test path prefix, case-insensitive, like the filter.
- A quarantined test still runs; its failure is printed but does not change the verdict.
- An entry without `reason` and `since` gets a warning: a permanent quarantine without a reason is
  a disabled test. Fixed it — remove the entry.
- Quarantine is for flaky tests, not crashes: a test that crashes the editor aborts the whole run.

## How to read failures

1. The summary at the end of `ue-test` output already has each failed test's path and its first
   errors with `file(line)`. Usually that is enough.
2. Need more — do not read `<Name>-Tests.log` whole into the main context. If the
   `code-analysis` plugin is enabled, give the agent `code-analysis:log-triage` the log path and a
   filter: it returns the errors and a verdict. No agent — targeted:
   `ue-tail-log.cmd --tests "Error|Fail|Ensure|Assert" 80` or
   `rg -n "BeginEvents: <Path>" -A 30 <log>` for one test.
3. `TEST COMPLETE` not found — look at the end of the log (`ue-tail-log.cmd --tests "" 60`) and
   `Saved/Crashes/` for a fresh folder: this is an editor crash, not a test failure.
4. New tests did not appear in the list — old DLLs (the editor was started before the build) or
   the test did not compile; `ue-test-suites.cmd` shows whether it sees the source.

## Writing a test

Adding a case to an existing file — copy the structure of the neighbouring tests in that file: the framework,
the dependencies and the wrapper are already chosen. A new file, a new test module or the project's first test —
choose the framework first: the first choice becomes the pattern for every later test.

| What is tested | Framework |
| --- | --- |
| Plain C++ logic without `UObject` (math, parsing, formatting) | LowLevelTests (Catch2): a separate module whose rules derive from `TestModuleRules`, not `ModuleRules`; reflection is not initialised, no `UObject`; no editor needed |
| One check | `IMPLEMENT_SIMPLE_AUTOMATION_TEST` |
| A class or subsystem with shared setup/teardown | CQTest `TEST_CLASS` + `BEFORE_EACH`/`AFTER_EACH` |
| A group of behaviours, BDD style | `BEGIN_DEFINE_SPEC` / `Describe` / `It` |
| A multi-frame asynchronous sequence | CQTest `TestCommandBuilder` (`.Do`, `.Until`, `.Then`) |
| An actor's behaviour on a real map | Functional Tests: `AFunctionalTest` on a test map; CQTest `FMapTestSpawner` |

- CQTest is an engine module (`Engine/Source/Developer/CQTest`): `"CQTest"` in `PrivateDependencyModuleNames`.
  The plugin `Plugins/Tests/CQTest` holds the framework's own tests; your tests do not need it enabled.
- Flags: a context (`EAutomationTestFlags::EditorContext`, or the whole mask
  `EAutomationTestFlags_ApplicationContextMask` — a constant in 5.8, not an enum member) **and** a filter
  (`ProductFilter` for your own). No context — a `static_assert`; no filter — it compiles but does not show up
  in the expected list.
- Name: `<Project>.<Area>.<Test>`; the first segment is what `ue-test.cmd` takes as the filter.
- Tests in a runtime module go inside `#if WITH_AUTOMATION_TESTS ... #endif`: registration happens at the
  module's static initialisation, so without the wrapper the code ships in Shipping. Cleaner: a separate
  `Type: Editor`/`DeveloperTool` module for tests.
- Checks only through `TestEqual`/`TestTrue`/`TestNotNull`/`AddError` (CQTest: `ASSERT_THAT`).
  `check`/`ensure`/`verify`/`assert` in a test crash the editor instead of failing the test.

### Traps: the test silently does nothing

- `RunTest` must return `true`: an early `return false` is a failure even when every check passed.
- A bare test has no world: `GetWorld()` is `nullptr`. A world — `UWorld::CreateWorld(EWorldType::Game, false)`
  (destroy it at the end), or a map through a latent command / `FMapTestSpawner`.
- `ADD_LATENT_AUTOMATION_COMMAND` only queues the command for later ticks. Check the result of an asynchronous
  operation in the next latent command, not right after queueing. A running latent command cannot add a new
  one — queue the whole chain up front.
- CQTest: `ASSERT_THAT` expands to `if (!...) return;` — inside a `.Do(...)` lambda it leaves the lambda, not
  the test; the commands go on. If continuing is wrong, check `HasAnyErrors()`.
- CQTest: `FMapTestSpawner::AddWaitUntilLoadedCommand(TestRunner)` belongs in `BEFORE_EACH`; in the test's
  constructor it waits for nothing.
- An asset path in a test is `/Game/...` (tests may load by path); a relative path works in the editor and
  breaks in a cooked build.

## A test in a packaged build

- **Shipping writes no log at all.** `Misc/Build.h`: Shipping has `NO_LOGGING = !USE_LOGGING_IN_SHIPPING`,
  logging is compiled out. A run of a packaged Shipping build leaves only the exit code — failure, hang and
  crash look the same in it. Run end-to-end tests on a packaged Development build; Shipping serves only as the
  gate "starts and exits with 0".
- **The Test configuration cannot be built with a launcher engine.** `Engine/Config/BaseEngine.ini`,
  `InstalledPlatformConfigurations` for Win64 Game: only `DebugGame`, `Development`, `Shipping`; UBT refuses.
  It needs an engine built from source.

## Policy

- Run the affected area's suite; a full pass — before a major report or on request.
- A test checks the layer it claims to: calling the C++ directly proves nothing about the tool
  layer above it.
- "Could not run" = FAIL; keep "cannot tell" apart from "all clean".
- Outside the suites the build is the gate; the Game target is the gate for runtime modules.
