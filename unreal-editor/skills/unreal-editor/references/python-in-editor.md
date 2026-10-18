# Python in the editor and in PIE

Details behind the `unreal-editor` skill's sections "Python in the editor" and "PIE and checks". Search by the
symptom's words; do not read it whole.

## How the code gets there (Remote Execution)

`ue.py < code` hands the code to `scripts/mjs/ue-pyremote.mjs`, which speaks Epic's protocol
(`PythonScriptPlugin/.../PythonScriptRemoteExecution.cpp`): UDP multicast `239.0.0.1:6766` on `127.0.0.1` finds the
editors (each says its `project_root`), a TCP connection back from the chosen editor carries one command and its
result. Verified on UE 5.8.3 (CL 58210709):

- **Nothing is saved by the call.** A dirty package stays dirty across calls until the code saves it. Per-run state
  still belongs in the PIE world, not in assets; after a check — `git status` over `Content/`.
- **The code runs as a file**, a temporary UTF-8 `.py`, not as literal text: the editor's `ExecuteFile` mode takes a
  literal containing `.py` for a file name, and it reads one TCP message per read — a file avoids both. So comments
  like `# usage: myscript.py` and long scripts are fine.
- **Non-ASCII arrives intact**: Cyrillic literals in the code, in `print` output and in asset strings
  (a metadata tag written, saved and re-read) came back unchanged. Output is printed ASCII-escaped (`ж`).
- **`unattended: true`** is sent with every command: a modal window the code itself would open is cancelled
  (`A modal window tried to take control while running in unattended script mode`) instead of freezing the editor.
  A modal that was already open before the call stops it like every MCP call: Remote Execution ticks with the
  engine loop, which a modal pauses.
- **An uncaught exception** is `success: False` with the traceback in the output, exit 1.
- **Which editor**: only one whose `project_root` is this project; a pid probe (`os.getpid()`) runs first, and the
  ownership rule decides by that pid. Two editors of one project are told apart by pid the same way.
- Remote Execution off in the editor → `no editor answers Python Remote Execution`; the switch and settings —
  the skill's "First: what the project has".

## Python mines (the engine's, any channel)

**`save_asset` is silent.** `EditorAssetLibrary.save_asset`'s second argument
`only_if_is_dirty` defaults to `True`, and a CDO edit from Python does not mark the package
dirty: the call returns `False` and writes nothing. Call `save_asset(path, False)` and
**look at the return value**. Otherwise the edit lives only in memory and disappears
on restart — and looks like "the code does not work". Toolsets and import share the same trap class —
`references/content-pitfalls.md` §Saving.

**Instanced objects from Python are not saved.** `InputMappingContext` triggers and modifiers
created in Python are `None` after a restart. Change only fields of existing ones. Re-check any asset edit
after an editor restart, not in the same session.

**Do not load a `.umap` through `load_asset`.** A Python reference to a `UWorld` crashes the editor
on a map change. Maps are opened with `LevelEditorSubsystem.load_level(path)`. Do not save a map whose
load logged a `LoadErrors` line about a missing dependency: the reference is lost forever.

**Loading assets while PIE is live** sometimes fails the whole call. Content edits — with
PIE stopped.

**`unreal.Rotator(0, 90, 0)` is pitch 90**: positional order is roll, pitch, yaw. Keyword arguments only.

**`/Game/...` paths from Git Bash** in arguments turn into `C:/Program Files/Git/Game/...`:
`MSYS_NO_PATHCONV=1` before the command, or paths inside the Python on stdin.

**Python globals do not live between calls** (verified: a module-level name is gone on the next call, an attribute
set on the `unreal` module is still there). What the next call needs — store as an attribute of the `unreal` module.

**Importing a DataTable from JSON** with incomplete rows opens a `Message` modal — build rows from
a full exported row.

**An exception you catch yourself** and print through `traceback` still reports `success: True`. Faster not to
catch — the uncaught one comes back with its traceback and exit 1.

## What is wrong when an object is "not found"

Python wrappers do not match C++ one to one:

- `GameplayAttribute` has no `get_name()`; read the name from `str(attribute)`;
- `get_gameplay_attribute_value` returns a tuple, not a number;
- `component_overlap_actors` does not see the component's own actor;
- `GameplayTag` does not compare with `==` — compare `export_text()`;
- `GameInstance` has no `get_subsystem` — get the subsystem with `unreal.ObjectIterator(cls)`, the first object
  without `Default__` in its name;
- before guessing, call `dir(obj)` and `obj.export_text()` — the text export of a
  struct shows everything, including properties without a Python wrapper, and `import_text`
  with the same text writes it back. Toolsets are the same — `ObjectTools.list_properties`
  before `set_properties`, and always re-read the result.

## Inspecting and driving a live PIE

Live PIE inspection through python — no log line, no rebuild. Conditions and what is visible:

- the game runs **inside the editor process** (viewport or New Editor Window); Standalone Game is a separate
  process and `get_game_world()` is `None` there. A packaged build has no python at all: the
  `PythonScriptPlugin` module is `UncookedOnly`, while `PythonScriptPluginPreload` is `Runtime` — hence
  `TargetAllowList: ["Editor"]` on the plugin in the `.uproject`, or it is pulled into the game target;
- start with the entry point: world and controller (`GameplayStatics.get_player_controller(w, 0)`). After that,
  `None` or `AttributeError: 'NoneType'` almost always means "PIE is not running or the pawn is not spawned
  yet", not a broken query;
- a property without Blueprint flags (just `EditAnywhere`) is not an attribute — `get_editor_property('Name')`
  reads everything; a bool attribute drops its `b` (`bIsOpen` → `is_open`), `get_editor_property` keeps it.
  The pawn is `pc.get_controlled_pawn()`; there is no `pawn` attribute;
- `unreal.GameplayTag("A.B")` takes the name positionally only, `tag_name=` raises `TypeError`; compare tags
  through `export_text()` ("not found" above);
- subsystems are often not exposed in the `unreal` module (`hasattr` is `False`) although the class loads by
  path `/Script/<Module>.<Class>`; get the instance through `ObjectIterator`, otherwise add a
  `BlueprintCallable` getter in C++. `dir(unreal)` fills lazily and proves no absence;
- mutating `BlueprintCallable`s work — and change the very run you are inspecting.

Python does not spawn an actor into the running game: `EditorActorSubsystem` works on the editor
world, and the bindings have no deferred spawn. The working way is a console command:

```python
unreal.SystemLibrary.execute_console_command(world, 'summon /Game/Path/BP_Thing.BP_Thing_C')
```

It places the actor next to the player. Settings come from the CDO, so "behaviour for one
run" is set by editing the CDO while PIE is stopped.

Moving an already live actor works: `set_actor_location` on one found through
`GameplayStatics.get_all_actors_of_class`. A good way to fake entering and leaving a
trigger without steering the character.

Acting for the player from Python:

- an ability — `asc.try_activate_ability_by_class(cls, True)`, the class — `unreal.load_class(None, '<path>.<Name>_C')`
  (`load_blueprint_class` returns `None` while PIE is live); a gameplay event —
  `unreal.AbilitySystemLibrary.send_gameplay_event_to_actor`;
- input — `inject_input_vector_for_action(ia, unreal.Vector(x, y, 0), [], [])` on
  `EnhancedInputLocalPlayerSubsystem` (through `ObjectIterator`); `InputActionValue` cannot be filled from Python,
  so `inject_input_for_action` is useless. While paused the action needs `bTriggerWhenPaused`;
- every frame — `unreal.register_slate_post_tick_callback`, results as attributes of the `unreal` module;
- timing checks — an editor with `--no-throttle` (the skill's "Launch").

A window snapshot including the game UI — the console command `shot showui`; `HighResShot` does not capture the UI.
