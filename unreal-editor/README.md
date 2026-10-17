# unreal-editor

A skill for working with a live Unreal Editor: a reference on Epic's server and toolsets, snapshots of their schemas,
content traps, editor launch, screenshot scripts and a lazy MCP bridge. Works in any UE 5.x project: port, log and
server kind come from the project, not hard-coded.

Two server branches:

- **VibeUE** (a third-party plugin on top of Epic's server) — has `execute_python_code`, Python with `import unreal`;
- **Epic's stock `unreal-mcp`** (`ModelContextProtocol` + `AllToolsets`, Experimental) — only toolsets through
  `list_toolsets` / `describe_toolset` / `call_tool`; `ProgrammaticToolset` does not allow Python with `unreal`.

There is no resource broker. The ownership rule applies: an agent stops and restarts only an editor its session
started (marker `<project>/Saved/AgentEditors/<pid>.json`), and while someone else's editor or build runs on the
machine it waits. Details — the `ue-workstation` skill, "Whose editor".

## Contents

Paths are relative to the skill folder `skills/unreal-editor/`; `.claude-plugin/`, `hooks/hooks.json`, `bin/`, `agents/` sit in the plugin root.

| Path | What |
| --- | --- |
| `SKILL.md` | ownership rule (short; the canon is in `ue-workstation`), server and port, launch, C++→check loop, modals, dirty packages, Python and PIE in brief, log; VibeUE/Epic branches |
| `references/epic-mcp-toolsets.md` | enabling Epic's server, ports and projects, modes, call conventions, screenshots, moves, toolset map, your own toolset |
| `references/toolsets/*.json` | `describe_toolset` snapshots, UE 5.8.3 CL 58210709, Epic's toolsets only (53) |
| `references/content-pitfalls.md` | content traps "symptom → cause → cure": saving, references, Blueprint graphs, Python in PIE, materials, meshes, animation, Niagara, levels, UMG |
| `references/python-in-editor.md` | Python mines, wrappers that differ from C++, inspecting and driving a live PIE |
| `references/mcp-bridge.md` | lazy bridge: why, install, flags, launch guard |
| `scripts/ue-project.*` | offline: project, server kind, port/URL, log, `preflight` (restore panel, crashes) |
| `scripts/ue-launch-editor.*` | launch the project's GUI or headless editor under the ownership rule: MCP and background-fps flags, marker, server wait, `--dry-run` |
| `scripts/mjs/ue-owner.mjs` | whose editor, build, port; may we launch, stop, build; markers. Copy of the master in `ue-workstation` |
| `scripts/editor-ready.sh` | waits for the server, diagnosis "working / modal / not running" from the log |
| `scripts/mcpinit.sh`, `scripts/ue.py`, `scripts/raw.py` | HTTP client: session, Python (VibeUE), toolset `--call`, `--tools`; checks that the port is held by this project's editor |
| `scripts/dump-toolset-schemas.*` | refresh the snapshots from a warm editor; `--from` / `--check` offline |
| `scripts/capture-level.*`, `scripts/capture-widget.*` | PNG of a level from given cameras / a WBP in the designer — as a file |
| `scripts/mcp-bridge/bridge.mjs` | lazy stdio↔HTTP bridge: list cache, `tools/list_changed`, images, launch under the ownership rule |
| `scripts/mcp-bridge/test/bridge-test.mjs`, `scripts/test/ue-py-test.mjs` | offline tests on fake servers and a fake process table |
| `scripts/selftest.cmd` | all offline tests at once |
| `scripts/mjs/ue-engine.mjs` | finds the engine and the project (same file as in `code-analysis`, + `CLAUDE_PROJECT_DIR`) |
| `templates/mcp.json.example` | wiring the bridge into the project's `.mcp.json` |

Not included: an idle stop of the editor from the bridge — the stock server has no graceful exit, and killing the
process leaves the restore panel on the next start.

## Install

A plugin of the `ue-skills` marketplace (how to add the marketplace — the root `README.md`). From the project folder:

```
claude plugin install unreal-editor@ue-skills --scope local   :: this project only; the project's repository is not changed
claude plugin install unreal-editor@ue-skills                 :: every project on the machine
```

Disable — `/plugin` → Installed (space), or `claude plugin disable unreal-editor@ue-skills`. After installing —
`/reload-plugins` or a new session. `<skill>` paths below are the plugin's `skills/unreal-editor/` folder.

Installs `ue-workstation` as a dependency — for the `editor-guard` hook; without it the scripts themselves keep the
ownership rule, with it so do commands the agent types by hand.

Installs `ue-build-test` as a dependency too — the "fix C++, check in game" loop stops the editor with its
`ue-stop-editor` and builds with its `ue-compile`.

The lazy MCP bridge is optional: for yourself — `claude mcp add --scope local unreal-mcp -- node "<clone>/unreal-editor/skills/unreal-editor/scripts/mcp-bridge/bridge.mjs"`
(writes nothing into the project's repository), for the team — the project's `.mcp.json`. `<clone>` and details —
`skills/unreal-editor/references/mcp-bridge.md`.

## Project

Server autostart and the port, in `Config/DefaultEditorPerProjectUserSettings.ini`, with the same port in `.mcp.json`:

```ini
[/Script/ModelContextProtocolEngine.ModelContextProtocolSettings]
ServerPortNumber=8000
bAutoStartServer=True
```

Projects may share 8000 while one editor runs at a time; the agent checks whose editor holds the port before
using it. Only editors of several projects open side by side need a port each (e.g. 19100), outside the Windows
dynamic range — `skills/unreal-editor/references/epic-mcp-toolsets.md` §Ports and projects.

## Environment

| Variable | Why | Default |
| --- | --- | --- |
| `UE_MCP_PORT` | the editor MCP server port | from the project settings, else 8000 |
| `UE_MCP_URL` | full URL (beats the port) | `http://127.0.0.1:<port><ServerUrlPath>` |
| `UE_MCP_STATE_DIR` | where session ids live | `%TEMP%\unreal-editor-mcp` |
| `UE_MCP_LAUNCH` | what the bridge launches the editor with | the project's headless `UnrealEditor-Cmd` |
| `CLAUDE_PROJECT_DIR` | the project, if the current folder has no `.uproject` | — |
| `UNREAL_HOME`, `UE_VERSION` | the engine (for launch and the snapshot stamp) | Epic registry by `EngineAssociation` |
| `UE_OWNER_FIXTURE` | tests only: a fake process table for `ue-owner.mjs` | — |

Needs `node` 18+, `python` 3, `curl` (for `editor-ready.sh`), Git Bash for `.sh`.

## Checks

`scripts\selftest.cmd` — without an editor and without a live server: the project detector on synthetic projects, the
ownership rule on a fake process table, the snapshot filter (the set contains no project toolset), `ue.py` against
fake VibeUE/Epic and a foreign editor on the port, the bridge (22 cases).
