---
name: unreal-editor
description: >
  A live Unreal Editor 5.x in any project: Epic's unreal-mcp toolsets and Python with
  `import unreal` (Epic's Remote Execution), starting and stopping the editor and PIE, editing
  assets, levels and Blueprints, screenshots, checks by the log, the "fix C++ — check in game"
  loop with Live Coding, the editor's Agent Skills. Use when content in the editor must be seen
  or changed: "launch the editor", "start PIE", "check it in game", "level screenshot", "the
  editor MCP does not answer", "the bridge dropped", "the editor hangs", "whose editor is this",
  "asset grey in the build", "which toolsets to enable", "inspect PIE", "run python in the
  editor", and before the first mcp__unreal-mcp__* call. Unreal context without the word: BP_,
  WBP_, M_, MI_, NS_, SM_, SK_ assets, a .uproject, Outliner; not Unity or Godot. Russian:
  «запусти редактор», «запусти PIE», «проверь в игре», «скриншот уровня», «MCP редактора не
  отвечает», «мост отвалился», «редактор завис», «чей это редактор», «питон в редакторе».
---

# Unreal Editor: how to work with it

Paths below are relative to this skill's folder, `<skill>/...`. Scripts need Node 18+ and Python 3; `.sh` runs in Git Bash.

## Ownership rule: touch only what you started

**An agent stops, restarts and rebuilds only what its own session started**; everything else is not ours — wait
or ask. Who started an editor is its marker, `<project>/Saved/AgentEditors/<pid>.json`, written by
`ue-launch-editor`, the lazy bridge and the guard hook. The full rule — mine / another agent's / orphan / a
person's, the machine limits, `--alongside` — is the `ue-workstation` skill, "Whose editor". Ask before acting:

```
node <skill>/scripts/mjs/ue-owner.mjs status              :: every editor and build on the machine and whose they are
node <skill>/scripts/mjs/ue-owner.mjs can-launch          :: may this project's editor be started
node <skill>/scripts/mjs/ue-owner.mjs can-stop <pid>      :: may this process be stopped
node <skill>/scripts/mjs/ue-owner.mjs can-build [--game]  :: may we build
```

The `editor-guard` hook (plugin `ue-workstation`, installed with this one) holds typed commands to the same rule,
including an MCP call whose port is answered by another project's editor. Do not work around it with a script.

## First: what the project has

```
<skill>/scripts/ue-project.cmd            :: offline: project, server, port, python, log
<skill>/scripts/ue-project.cmd preflight  :: signs of modals before launch
python <skill>/scripts/ue.py --tools      :: live: who answers on the port
node <skill>/scripts/mjs/ue-pyremote.mjs --list   :: live: which editors answer python
```

Two channels into one editor, both Epic's own:

| | Toolsets (`unreal-mcp`) | Python (Remote Execution) |
| --- | --- | --- |
| Needs | `ModelContextProtocol` + `AllToolsets` in `.uproject` | `PythonScriptPlugin` (comes with `ModelContextProtocol`) + Remote Execution on |
| Reached by | native `mcp__<server>__call_tool`, or `ue.py --call` | `python <skill>/scripts/ue.py < code` |
| Good for | typed reads and edits, screenshots, PIE, tests, logs — schemas in `<skill>/references/toolsets/` | anything `import unreal` can do in one pass: live PIE inspection, bulk edits, what no toolset covers |
| Saves by itself | nothing | nothing |

Remote Execution is off by default. An editor started by `ue-launch-editor` or the lazy bridge has it on (a
command-line switch, no project file changes). A person's editor: Project Settings → Plugins → Python →
"Enable Remote Execution?" (takes effect at once; writes `Config/DefaultEngine.ini`), or
`bRemoteExecution=True` under `[/Script/PythonScriptPlugin.PythonScriptPluginSettings]` in
`Saved/Config/WindowsEditor/Engine.ini` (per machine, next start). It listens on loopback only (multicast TTL 0).

Port and log come from the project (`ue-project.cmd` prints both and warns about a mismatch); the log is
`Saved/Logs/<.uproject name>.log`. **Projects may share the default port 8000** as long as one editor runs at a
time; then the editor on the port may belong to another project, so check whose it is before the first call
(`ue-project.cmd`, `ue-owner.mjs status`; `ue.py` and the guard hook refuse a foreign one). Editors of several
projects open side by side need a port each, outside the Windows dynamic range. Port lookup order, the `.ini`
lines and enabling the plugins — `references/epic-mcp-toolsets.md` §Ports and projects.

## Launch

```
<skill>/scripts/ue-launch-editor.cmd                 :: the project's GUI editor, waits for the MCP server
<skill>/scripts/ue-launch-editor.cmd --headless      :: UnrealEditor-Cmd with -RenderOffScreen
<skill>/scripts/ue-launch-editor.cmd --no-throttle   :: full fps in the background (timing checks)
<skill>/scripts/ue-launch-editor.cmd --dry-run       :: verdicts and the exact command, launches nothing
```

The script checks the ownership rule (my own already runs — `REUSED`) and the restore panel, writes the marker and
waits for the server with the same log diagnosis as `editor-ready.sh`. The last line is the verdict
`RESULT: launch OK|REUSED|REFUSED|FAILED|TIMEOUT`.

To launch by hand — the same command `--dry-run` prints:

```
"<UE>\Engine\Binaries\Win64\UnrealEditor.exe" "<project>\<Name>.uproject" -ModelContextProtocolStartServer
    [-ModelContextProtocolPort=N]
    -ini:Engine:[/Script/PythonScriptPlugin.PythonScriptPluginSettings]:bRemoteExecution=True
    ["-ini:EditorSettings:[/Script/UnrealEd.EditorPerformanceSettings]:bThrottleCPUWhenNotForeground=False"]
```

`-ModelContextProtocolStartServer` is not needed if the project has `bAutoStartServer=True`. A background editor
without `bThrottleCPUWhenNotForeground=False` runs at about 3 frames per second: input windows (combos) and short
phases slip by. The guard hook marks a hand-launched editor as mine if it appeared during
a tool call; otherwise it counts as a person's.

## The "fix C++ — check in game" loop

**Only function bodies in `.cpp` changed, and the editor is mine and a GUI one** — no restart: Live Coding from the
editor, `call_tool` `LiveCodingToolset.LiveCodingToolset` / `CompileLiveCoding` (no arguments). It blocks until
the compile ends — the game thread too, so every other call waits — and answers one string: `Result: Success` /
`NoChanges` / `Failure` / `CompileStillActive` / `NotStarted` / `Cancelled`, then `Compile Output:` (the
`LogLiveCoding` lines) and `Compiler Diagnostics:` (MSVC lines from this compile's UBT log). A refusal is also a
string, not an error: `Error: Live Coding is not enabled for this session` — always so in a headless
(`-unattended`) editor; it needs a GUI editor with Live Coding on in Editor Preferences. The toolset is outside
`AllToolsets`: `LiveCodingToolset` in `.uproject`. Headers, `UPROPERTY`/`UFUNCTION`, constructors and defaults —
Live Coding cannot do them: the full loop below (what needs which, `ue-build-test`). A person's editor — ask them.

Everything else, the order, no deviations:

1. Edits in `Source/`.
2. Stop PIE and make sure no dirty packages are left (see "Modals").
3. **Close the editor if it is mine** (`ue-stop-editor` from `ue-build-test`, or `CloseMainWindow` by pid,
   not `-Force`). Not mine — do not close: wait or ask the person.
4. Build with `ue-compile` from `ue-build-test` (it refuses while an editor of the project runs). Never a
   script that ends in `pause` — it hangs waiting for a key.
5. Start the editor again (`ue-launch-editor`), wait for the server.
6. Open the map, start PIE, check.

Steps 3 and 4 are **separate tool calls**: the guard hook judges the command before it runs, and in one line
"close and build" it sees the editor still alive and refuses.

Closing takes up to three minutes: the engine writes caches. `WaitForExit(240000)` is a normal
wait, not a sign of a hang.

## Modals: the main way to freeze dead

Any dialog window **stops the game thread**: the server stops answering
(MCP calls and Remote Execution run on the game thread), the log stops growing, the process is alive and
`Responding` is `True`. From outside it is indistinguishable from long work — which is why it is so easy
to hang for half an hour. Two modals are dangerous, both are caught in advance.

### Asset restore at launch

After an unclean exit — not only `Stop-Process -Force`, but any engine crash —
a "restore unsaved assets?" panel appears at startup. Only a person
can close it. The sign is on disk **before** launch:
`Saved/Autosaves/PackageRestoreData.json` (UTF-16LE **without BOM**). The panel appears only if
`Packages` holds at least one package (`FPackageAutoSaver::HasPackagesToRestore`); a lone
`RestoreEnabled = true` with an empty list is left by any unclean exit and shows nothing.
With `-unattended` (headless) the panel never appears.
`<skill>/scripts/ue-project.cmd preflight` reads it (exit 1 — the panel will appear), and looks at
fresh `Saved/Crashes/*` (the last exit was a crash); `ue-launch-editor` does not launch with such a panel
pending. If the panel is expected — warn the person **before** launch, not after everything has stalled.

### Save on close

`CloseMainWindow()` on a dirty editor shows "save changes?" and waits
**forever**. The cure is that no dirty state is left before closing — and check it
**every time**, even after a session that only read: reading a Blueprint graph through a toolset leaves
it dirty.

Ask the whole list through Python — it saves nothing:
`unreal.EditorLoadingAndSavingUtils.get_dirty_map_packages()` and `get_dirty_content_packages()` (every dirty
package, also one without an open editor). Without Python: `EditorAppToolset.StopPIE`, then
`AssetTools.is_dirty(path)` over the open assets (`EditorAppToolset.GetOpenAssets`), the current map
(`SceneTools.get_current_level`) and your own paths — a package dirty without an open editor is not visible this
way. `ue-stop-editor` asks Python first and falls back to the toolsets. A never-saved start map
(`/Temp/Untitled_1` in a project without a default map) is always dirty. `AssetTools.save_assets([])` saves
**all** dirty packages, other people's too — pass paths explicitly.

Empty — closing is fine. Not empty — decide explicitly: save your own (`save_assets([your paths])`),
leave the rest and tell the person. Never call the dialog variants (`save_dirty_packages_with_dialog`,
`save_packages_with_dialog`): that is exactly the modal we are avoiding.

The first `CloseMainWindow()` right after stopping PIE may get lost: the editor is still rebuilding
windows. Wait a few seconds; if it did not exit within `WaitForExit` while the server answers and the log grows —
it is not a modal, call `CloseMainWindow()` again.

### A timeout and how to read it

The **log** tells a modal from work: while the engine works, the log grows; on a modal it freezes.

- Launch: `ue-launch-editor` waits by itself; for one already running — `<skill>/scripts/editor-ready.sh [seconds] [log path]`.
  When time runs out both say: the log grows (wait), froze (a modal — or the MCP server is off),
  was not written since the wait began (the editor is not running). A normal start is 15–30 s, a cold one on a file
  DDC 3–4 minutes; the default limit is 180–240.
- Close: `WaitForExit(240000)`. Did not exit — check the log size twice a minute apart.
  Grows — wait. Frozen — a modal.

Hit a modal — **do not restart the editor in a loop**: the second instance will not get
the port (`unable to bind`, runs without MCP) and only takes resources. Tell the person at the machine
which window is hanging and why.

## Connecting to the editor

Native `mcp__<server>__*` tools are the first choice. With `"type": "http"` in `.mcp.json`
the client does not survive every editor restart: it remembers the refusal and stays
disconnected until the session ends. Two ways out:

- **The fallback that always works** — the same server over HTTP, scripts in `<skill>/scripts/`:
  - `editor-ready.sh` — waits for the server after launch and diagnoses if it did not come up;
  - `mcpinit.sh` — opens a session and says which mode answers;
  - `ue.py --call <toolset> <tool> '<json>'` — one toolset call; `ue.py --tools` — the tool list and the mode;
  - `raw.py` — the same, but the raw answer; needed when `ue.py` says `success: False` and it is unclear why.

  Before the first request `ue.py` checks that the port is held by **this** project's editor, otherwise it sends
  nothing. The session id is state, not part of the skill: it lives in `UE_MCP_STATE_DIR`
  (default `%TEMP%\unreal-editor-mcp\sid-<port>.txt`). After every editor restart
  the session goes stale and `ue.py` opens a new one itself — calling `mcpinit.sh` is optional.
- **Python** needs no MCP connection at all (next section).
- **The lazy bridge** (optional: for yourself — `claude mcp add --scope local`, for the team — the project's
  `.mcp.json`) — a stdio server that
  does not drop, starts a headless editor on the first call (under the same ownership rule,
  with a marker), caches the tool list and returns screenshots as images: `<skill>/references/mcp-bridge.md`.

### What instead of a missing toolset

- Almost everything — through toolsets: `references/epic-mcp-toolsets.md` (calls, conventions,
  screenshots, asset moves, state description, toolset map), schemas — `jq` over
  `references/toolsets/*.json`.
- Several toolset calls at once — `ProgrammaticToolset` (stdlib, no `unreal`; an error of
  any tool aborts the whole script — guard with `exists()`), or one Python pass.
- `import unreal` — Python (next section); with this project's editor closed, a headless commandlet:
  `UnrealEditor-Cmd <uproject> -run=pythonscript -script=<file with no spaces in the path>`.
- A capability the agent will need again — a toolset of the project's own, in Python (no C++ build, reloaded live)
  or C++: `references/epic-mcp-toolsets.md` §Extending.
- Blueprint graphs — `editor_toolset.toolsets.blueprint.BlueprintTools`. Details —
  `references/content-pitfalls.md` §Blueprint graphs.

## Python in the editor

```
python <skill>/scripts/ue.py < code.py            :: prints success, the output lines, the editor pid
python <skill>/scripts/ue.py --allow-foreign < x  :: into an editor this session did not start - person's OK only
python <skill>/scripts/raw.py < code.py           :: the whole command_result
```

It goes through Epic's Python Remote Execution (`scripts/mjs/ue-pyremote.mjs`): finds the editor whose project is
this one, asks it for its pid, checks the ownership rule, then runs the code there as a temporary UTF-8 `.py` file.
Exit 0 — ran, 1 — raised (the traceback is in the output), 2 — refused or no editor. **Nothing is saved by it**:
an edit stays in memory until you save it. Python into an editor this session did not start runs inside a person's
open session, on their unsaved work, with no undo — `ue.py` refuses without `--allow-foreign`, set only with their
consent; to look or read, toolsets need no consent. Non-ASCII text in the code, in `print` and in asset strings
arrives intact. Globals do not live between calls — keep state as attributes of the `unreal` module.

The traps that cost most: `save_asset(path, False)` and read its return value (the default saves nothing after a
CDO edit); open maps with `LevelEditorSubsystem.load_level`, never `load_asset` on a `.umap`; keyword arguments
for `unreal.Rotator`; `MSYS_NO_PATHCONV=1` for `/Game/...` arguments from Git Bash. The rest, and Python wrappers
that differ from C++ ("not found") — `references/python-in-editor.md`.

## PIE and checks

Toolsets: `SceneTools.load_level`, `EditorAppToolset.StartPIE` / `IsPIERunning` / `StopPIE`,
game state — `GASToolsets.AbilitySystemInspectorToolset`, log — `EditorToolset.LogsToolset.GetLogEntries`.
Python:

```python
les = unreal.get_editor_subsystem(unreal.LevelEditorSubsystem)
les.load_level('/Game/Maps/...')         # map
les.editor_request_begin_play()          # start
les.is_in_play_in_editor()               # running?
les.editor_request_end_play()            # stop
```

The game world comes from `UnrealEditorSubsystem.get_game_world()` — **not** from
`get_editor_world()`. After PIE starts, wait about eight seconds: the game may go through
a menu to another map, and `get_game_world()` returns the start map at first.

Live inspection and acting for the player from Python (reading properties, subsystems, `summon`, abilities,
injected input, per-frame callbacks) — `references/python-in-editor.md` §Inspecting and driving a live PIE.
A window snapshot including the game UI — the console command `shot showui`; `HighResShot` does not capture the UI.

## Agent Skills inside the editor

The engine and the project register their own instruction bundles in the editor, separate from these Claude Code
skills. UE 5.8 with `AllToolsets` ships about twenty (Blueprint and Material basics, outdoor lighting, Niagara
authoring and optimisation, PCG graphs and biomes, Dataflow); a project may add its own (naming, folder layout, the
order of a multi-step setup). Before unfamiliar work in a domain — `call_tool`
`ToolsetRegistry.AgentSkillToolset` / `ListSkills` (no arguments: path → description), then `GetSkills`
`{"skillPaths": [...]}` on the matching ones (an instruction text, ~2 KB each). A project's own skill outranks a
generic default here: it exists because the project does it differently. Writing one —
`references/epic-mcp-toolsets.md` §Agent Skills.

## Verify by the log, not by feel

`Saved/Logs/<Project>.log` is written live and read with plain `grep` (the path is printed by
`ue-project.cmd --field log`). Useful:

- `log <Category> Verbose` — enable a category;
- the project's debug cvars are found with `EditorAppToolset.SearchCVars("<part of the name>")`;
- a material "white in game" — the line `Default Material will be used in game` in the PIE log.

Seconds of real time pass between script calls: a short phase may
end while the next call is running. Short-lived things are measured by timestamps in the
log, not by polling state; in C++ automation tests — by subscription (`RegisterGameplayTagEvent`).

## A placed instance does not follow its asset

An asset edit **from a script** does not reach an already placed actor. Verified by measurement:
a field was changed in the CDO — the instance on the map keeps reporting the old value, and
reloading the level does not change that. It looks like "the code does not work", while the game actually
runs an old copy of the settings.

Sign: one thing in the asset, another in the game. Check by reading the property **on the instance**, not
on the CDO — the CDO shows the right value and misleads. The cure is recreating the
actor: delete it from the map and place it again.

Caveat: verified with actors placed by a script. Editing the asset by hand in the Blueprint editor
triggers reinstancing and may carry values into placed
actors — not verified.

## A check must leave nothing behind

Test values go into the CDO, are rolled back by the same script and **re-read**
after the rollback in a separate call. Before editing someone else's setting, its previous value
is saved (`export_text` to a file) and restored from there after the check. Leave no dirty package of yours
behind (Python's dirty list above), and at the end — `git status` over `Content/`: everything that changed
unintentionally (including Blueprints that were only read and then saved) is reverted with `git checkout`
while the editor is closed.

Do not touch actors placed on the level: they are not garbage, they are someone's work. Cleanup after
one's own test has already once wiped someone else's placed zones.

## References

- `references/epic-mcp-toolsets.md` — Epic's server and toolsets: enabling, modes, calls, concurrency,
  screenshots, moves, toolset map, extending with your own toolset (C++ or Python), Agent Skills, security,
  what to recheck after an engine update.
- `references/toolsets/` — schema snapshots of Epic's toolsets (UE 5.8.3); refresh after an
  engine update — `scripts/dump-toolset-schemas.cmd` (warm editor).
- `references/content-pitfalls.md` — content traps "symptom → cause → cure":
  saving, packages and references, Blueprint graphs, Python in the editor and in PIE, materials, meshes,
  animation, Niagara, levels, UMG. Search by the symptom's words, do not read it whole.
- `references/python-in-editor.md` — Python mines, wrappers that differ from C++, inspecting and driving a live PIE.
- `references/mcp-bridge.md` — the lazy bridge.
- Images as files for a person: `scripts/capture-level.cmd`, `scripts/capture-widget.cmd`.
- Self-test of the scripts without an editor: `scripts/selftest.cmd`.
