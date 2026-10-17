# Python in the editor and in PIE

Details behind the `unreal-editor` skill's sections "Python in the editor" and "PIE and checks". Search by the
symptom's words; do not read it whole.

## Python mines (branch a: VibeUE)

**The bridge saves assets itself — before running the code.** At the start of every `execute_python_code`, VibeUE
writes **all** dirty editor packages, content and maps, to disk (`PythonTools.cpp`, "Auto-save all
dirty packages before executing Python code"). Exceptions: PIE is running, or the previous call failed.
Toolset calls (`call_tool`) save nothing. Consequences:
- a temporary asset edit "for one check" reaches the file on the **next** call, even if the
  script rolled it back; per-run state belongs in the PIE game world, not in assets; after
  the check — `git status` over `Content/`;
- Python in an editor this session did not start silently saves **a person's unsaved
  work**. That is why `ue.py` refuses Python into someone else's editor without `--allow-foreign`, and the hook
  asks the person before the first such native-tool call. Set the flag only with their
  consent; to look or read, use toolsets — they need no consent.

**`.py` in the code text.** If the code contains the substring `.py`, the bridge decides it was
given **a file path** and tries to load it. A comment like
`# usage: myscript.py` breaks a working script with `Could not load Python file '...'`.
No file names with an extension in the code.

**Non-ASCII text.** `print` with Cyrillic text breaks the pipe (cp1251) — write diagnostics in Latin script.
Literals are worse: a Cyrillic string written into an asset property through the bridge lands there mis-encoded
forever. Assets get only Latin text, or `\u` sequences, and re-read after saving.

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

**Python globals do not live between calls.** What the next call needs — store as an attribute of the `unreal` module.
The bridge does not accept the chain `get_default_object(...).set_editor_property(...)` in one line — put the CDO in a variable.

**Importing a DataTable from JSON** with incomplete rows opens a `Message` modal — build rows from
a full exported row.

**An exception in the script** arrives as `success: False` with no text if you catch it
yourself through `traceback`. Faster not to catch — `raw.py` shows the real traceback.

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
