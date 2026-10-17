# ue-build-test

Build and test an Unreal Engine 5 C++ project without the editor window, in any project.

## Contents

Paths are relative to the skill folder `skills/ue-build-test/`; `.claude-plugin/`, `hooks/hooks.json`, `bin/`, `agents/` sit at the plugin root.

| Path | What |
| --- | --- |
| `SKILL.md` | what to do after a C++ change, the editor and who owns it, tests, "done" |
| `references/testing.md` | how a run works, the verdict, quarantine, how to read failures, writing tests |
| `references/headless.md` | headless editor, commandlets, the `-script=` trap, when a person is needed |
| `templates/ue-test-quarantine.json` | quarantine sample |
| `scripts/ue-compile.cmd` | incremental build of the Editor target; with files — compile only them, no link |
| `scripts/ue-validate-data.cmd` | Validate Project Data without the editor window (DataValidation commandlet) |
| `scripts/ue-check-blueprints.cmd` | compile the Blueprints a C++ change can break (`CompileAllBlueprints` over the assets that mention the changed types) |
| `scripts/ue-rebuild.cmd` | clean + `-DisableUnity` |
| `scripts/ue-game-build.cmd` | Game target Shipping, no cook |
| `scripts/ue-test.cmd` | headless automation test run with coverage and quarantine |
| `scripts/ue-test-suites.cmd` | suites from the sources (+ `DEFINE_SPEC`, CQTest `TEST_CLASS`, wrapper macros) |
| `scripts/ue-stop-editor.cmd` | gentle close of this project's editor, waiting for the DLLs |
| `scripts/ue-run-editor-headless.cmd`, `ue-wait-editor.cmd` | windowless editor and waiting until it is ready |
| `scripts/ue-tail-log.cmd`, `ue-clean.cmd`, `ue-info.cmd` | log tail, cleanup, what was found |
| `hooks/unbuilt-cpp.mjs` | Stop hook: C++ this session edited but did not build keeps the turn open; off with `UE_BT_STOP_CHECK=0` |
| `scripts/ue-selftest.cmd` | offline check of the scripts |
| `scripts/mjs/ue-engine.mjs` | engine lookup (one file in every plugin, master in `ue-workstation`; `.uproject` wins over `UE_VERSION`) |
| `scripts/mjs/ue-tools.mjs`, `ue-proc.mjs`, `ue-gate.mjs`, `ue-build-flow.mjs`, `ue-test-log.mjs` | project and targets; processes per project; verdict, `.bat` with spaces, waiting for our turn; shared build flow; test log parsing |
| `scripts/mjs/ue-owner.mjs` | whose editor, whose build, who is on a port; `Saved/AgentEditors` markers (the same file as in `ue-workstation`, keep identical) |

## Installation

A plugin of the `ue-skills` marketplace (how to add the marketplace — the root `README.md`). From the project folder:

```
claude plugin install ue-build-test@ue-skills --scope local   :: this project only; the project repository is not changed
claude plugin install ue-build-test@ue-skills                 :: every project on the machine
```

Turn off — `/plugin` → Installed (space), or `claude plugin disable ue-build-test@ue-skills`. After installing —
`/reload-plugins` or a new session. `<skill>` paths below are the plugin's `skills/ue-build-test/` folder.

Installs `ue-workstation` as a dependency — for the `editor-guard` hook.
Flaky-test quarantine template: `<skill>\templates\ue-test-quarantine.json` → `<project>\.claude\ue-test-quarantine.json`
(optional; it is a project file).

## Environment

| Variable | Why | Default |
| --- | --- | --- |
| `UNREAL_HOME` | engine root (required for a source-built engine) | from the Epic registry by version |
| `UE_VERSION` | engine version, if the `.uproject` has no `EngineAssociation` of the form `5.x` | 5.8 |
| `UE_MAX_PARALLEL_ACTIONS` | cap on UBT parallel actions (`0` — no cap) | 10 |
| `UE_TEST_LOG_DIR` | test log folder (no spaces) | `<project>\Saved\Logs` |
| `UE_TEST_QUARANTINE` | quarantine file | `<project>\.claude\ue-test-quarantine.json` |
| `UE_MCP_PORT` | port of the editor's MCP server for the dirty-package check in `ue-stop-editor` | from the project settings, else 8000 |

Needs `node` 18+. No broker needed: the scripts read the machine's processes and the owner markers
themselves. The `editor-guard` hook of the `ue-workstation` plugin (a dependency) is the second line of
defence for commands the agent types by hand. Installation check: `scripts\ue-selftest.cmd --project <Project>`.
