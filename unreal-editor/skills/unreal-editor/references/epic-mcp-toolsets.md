# Epic's MCP server and toolsets (`unreal-mcp`) — field guide

Read when a task goes through Epic's stock server (`ModelContextProtocol` + toolsets). Python with `import unreal`
goes past it, through Python Remote Execution (the skill's "Python in the editor"). Jump to the section you need. Per-tool argument schemas are snapshotted in
[`toolsets/`](toolsets/) — one file per `describe_toolset`, stamped with the engine version in
`toolsets/index.json` (UE 5.8.3, CL 58210709; Epic toolsets only). Read the snapshot first and pull one
signature with `jq`; go live with `describe_toolset` when the snapshot looks stale — its stamp differs from
`Engine/Build/Build.version`, a toolset plugin changed, or a schema error / suspicious miss.

```bash
jq -r '.schema | fromjson | .tools[] | select(.name|endswith(".save_assets")) | .inputSchema' \
   <skill>/references/toolsets/editor_toolset.toolsets.asset.AssetTools.json
```

Refresh after an engine update (warm editor, minutes): `<skill>/scripts/dump-toolset-schemas.cmd`. It drops every
toolset the project or a third-party plugin registers (module or python package found under the project's
`Source/` or `Plugins/`), so the set stays Epic-only; `--check` asserts that offline.

## Turning it on (UE 5.8)

- Plugins, both **Experimental** and off by default: `ModelContextProtocol` («Unreal MCP», pulls in
  `ToolsetRegistry`) and `AllToolsets` («Editor Tools»: aggregates `Engine/Plugins/Experimental/Toolsets/*`).
  Without a toolset plugin the server can start with zero tools.
- `AllToolsets` is NOT all of them (5.8: 21 dependencies). Outside it, under `Engine/Plugins/Experimental/Toolsets`:
  `ChaosClothAssetToolset`, `LiveCodingToolset`, `MVVMToolset`, `SequencerAnimMixerToolset`, `MetaHumanGenerator` —
  enable by name when needed. It DOES pull `MCPClientToolset` (the reverse direction: the editor as an MCP client).
- Side effects of enabling: `GameFeaturesToolset` pulls in the `GameFeatures` plugin, which wants a `GameFeatureData`
  primary-asset rule in `[/Script/Engine.AssetManagerSettings]` (`DefaultGame.ini`), otherwise an error on every
  start (and a red project-validation run). `MetaHumanGenerator` without MetaHuman optional content registers
  nothing (`init_unreal.py`: «MetaHuman optional content not available, toolset not registered») but drags in three
  MetaHuman plugins and their warnings — leave it off unless the content is installed.
- Toolsets are WRITE access: `EditorToolset`, `ConfigSettingsToolset`, `PluginToolset`, `AssetTools` change assets,
  config and plugins outside any review. Enable deliberately; `UToolsetRegistrySettings` can block toolsets or tools
  (see the last section).
- A server added or regenerated while Claude Code runs is not seen by that session: the client reads `.mcp.json`
  at start (and asks to approve a new server). Restart the client; until then «no tools» is expected.
- Settings: `[/Script/ModelContextProtocolEngine.ModelContextProtocolSettings]` in the
  `EditorPerProjectUserSettings` config (`ModelContextProtocolSettings.h:17-46`) — tracked baseline
  `Config/DefaultEditorPerProjectUserSettings.ini`, machine override
  `Saved/Config/WindowsEditor/EditorPerProjectUserSettings.ini` (Editor Preferences → General → Model Context
  Protocol writes there):
  - `ServerPortNumber` (default **8000**), `ServerUrlPath` (default `/mcp`);
  - `bAutoStartServer` (default **false**: the server is not running until something starts it);
  - `bEnableToolSearch` (default true — see «Two modes»).
- Command line beats the files: `-ModelContextProtocolPort=N` (`ModelContextProtocolSettings.cpp:20`),
  `-ModelContextProtocolStartServer` (`:34`). Console: `ModelContextProtocol.StartServer`.
- The log says what really happened: `LogModelContextProtocol: Starting MCP server on port N`
  (`ModelContextProtocolServer.cpp:445`) and `Tool search enabled: registered 3 meta-tools (N toolsets …)`.
  `<skill>/scripts/ue-project.cmd` reads all of the above offline and warns when they disagree.
- Pick a port above Windows' dynamic TCP range when several editors run side by side: WinNAT/Hyper-V reserve
  blocks of that range at boot and a bind fails with `EACCES`, not «in use»
  (`netsh int ipv4 show excludedportrange protocol=tcp`). Two editors on one port: the second logs
  `unable to bind` and runs on WITHOUT MCP; binding happens only at startup, so it stays deaf after the first dies.
- `ModelContextProtocol.GenerateClientConfig ClaudeCode` writes a `.mcp.json` (`type: http`) — next to the
  `.uproject` for a launcher engine, at the workspace root beside `Engine/` for a source build. Re-running merges
  into the existing file (safe after a port change). `All` writes every client (`ClaudeCode`, `Cursor`, `VSCode`,
  `Gemini`, `Codex`); the Codex writer refuses to overwrite an existing `.codex/config.toml`. Security — §Security.
- Other console commands: `ModelContextProtocol.StopServer`, `ModelContextProtocol.StartServer [port]`,
  `ModelContextProtocol.RefreshTools` — re-register every toolset after a toolset plugin was switched on (a
  toolset expected but missing: RefreshTools, then check the plugin is enabled in `.uproject`).

## Ports and projects

Port and path come from the project: `UE_MCP_PORT` / `UE_MCP_URL`, otherwise
`[/Script/ModelContextProtocolEngine.ModelContextProtocolSettings] ServerPortNumber` in
`Saved/Config/WindowsEditor/EditorPerProjectUserSettings.ini`, then
`Config/DefaultEditorPerProjectUserSettings.ini`, otherwise 8000. The command-line switch
`-ModelContextProtocolPort=N` beats the files; what actually started is in the log
(`Starting MCP server on port N`), and `ue-project.cmd` warns about a mismatch.
The editor log is `Saved/Logs/<.uproject name>.log`.

**The default port 8000 is fine when one editor runs at a time**, even if several projects use it. Autostart and
the port go into the project's `Config/DefaultEditorPerProjectUserSettings.ini`, the same port into `.mcp.json`:

```ini
[/Script/ModelContextProtocolEngine.ModelContextProtocolSettings]
ServerPortNumber=8000
bAutoStartServer=True
```

What sharing costs: the editor on 8000 may be another project's, and an agent that does not check would edit it.
`ue.py` and the guard hook refuse when the port is held by another project's editor; check with `ue-project.cmd`
or `ue-owner.mjs status` before the first call anyway. Two editors on one port do not work at all: the second
gets no port (`unable to bind`) and runs without MCP.

**Editors of several projects open side by side** need a port each — e.g. `ServerPortNumber=19100` in one of
them, with `.mcp.json` and the configs of other agent tools (`.codex`, `.cursor`, `.gemini`) changed together.
Keep such a port outside the Windows dynamic range (usually 49152–65535). Without `bAutoStartServer=True` the
server starts only with the `-ModelContextProtocolStartServer` switch.

No Epic server in the project — enable the plugins (§Turning it on above);
that is a `.uproject` edit and an editor restart, with the person at the machine.

## Two modes, and how to tell the server at runtime

`tools/list` is the test (`python <skill>/scripts/ue.py --tools`):

| `tools/list` shows | Mode |
| --- | --- |
| only `list_toolsets`, `describe_toolset`, `call_tool` | tool-search mode (`bEnableToolSearch=true`, default): toolset tools are dispatched server-side, the catalog never changes mid-session, the prompt cache stays warm |
| hundreds of `Toolset.Name.tool` entries | eager mode (`bEnableToolSearch=false`): every tool registered natively up front |

`call_tool` with `toolset_name` omitted calls a TOP-LEVEL tool (one registered on the server itself, not in a
toolset); it is rejected for `call_tool` itself.

## Call pattern

Call the meta-tools natively (`mcp__<server>__call_tool`); raw HTTP (`<skill>/scripts/ue.py --call`) is for a
client that lost its connection, and for scripts that must write files.

Common `toolset_name` strings:

- `editor_toolset.toolsets.object.ObjectTools` — `list_properties` / `get_properties` / `set_properties` / `reset_properties` / `get_class` / `search_subclasses` on any UObject or CDO.
- `editor_toolset.toolsets.asset.AssetTools` — `exists` / `move` / `duplicate` / `delete` / `save_assets` / `is_dirty` / `find_assets` / `get_referencers` / `get_dependencies` / `create_folder` / `load_asset` / `read_file` / `write_file`.
- `UMGToolSet.UMGToolSet` — widget-tree surgery (`CreateWidgetBlueprint`, `AddWidget`, `GetWidgets`, `RemoveWidget`, `RenameWidget`, `CompileWidgetBlueprint`, …).
- `editor_toolset.toolsets.programmatic.ProgrammaticToolset` — batch many tool calls in one script pass.
- `editor_toolset.toolsets.actor.ActorTools`, `…scene.SceneTools`, `…material.MaterialTools`, `…material_instance.MaterialInstanceTools`, `…texture.TextureTools`, `…data_table.DataTableTools`, `…data_asset.DataAssetTools`.
- `EditorToolset.EditorAppToolset` — NOT `EditorAppToolset.EditorAppToolset` (the one toolset that does not double its name). PIE lives here: `StartPIE` / `StopPIE` / `IsPIERunning`.

Conventions:

- `refPath` is the OBJECT path `/Game/Dir/Asset.Asset`, not the package path. A generated class is `…_C`; its CDO is `/Game/Dir/BP_X.Default__BP_X_C`. A soft reference resolves only from a full object path — a package path loads null and nothing complains.
- Names through MCP are lowerCamelCase of the C++ name and KEEP the bool prefix (`bIsOpen` → `bIsOpen`,
  `CloseDuration` → `closeDuration`); editor Python is snake_case and DROPS it (`is_open`, `close_duration`). Never
  carry a name from one channel to the other.
- `list_properties` on a class returns everything inherited — hundreds of entries with schemas for an `AActor`
  child, tens of KB into context. Call it only when the full list is the point; otherwise `get_properties` with
  named properties. An EMPTY `list_properties` does not mean «class not found»: a class without `UPROPERTY`s
  answers empty too — probe a known-populated class with the same call to tell the two apart.
- `ObjectTools`: `list_properties` before `set_properties` (names are not guessable; struct fields serialize lowercase, e.g. `DefaultPointer.image`). `values` is a JSON STRING and the object is `{refPath}` — pass a real object and it silently answers `false`. `true` does not mean a struct landed: read it back with `get_properties` (a `BoxExtent` write stored only its first field). A struct that must be exact goes through editor python with its setter (`set_box_extent`) and a reload.
- `ActorTools.set_actor_transform` writes the WHOLE transform: `scale` alone resets location and rotation to the default. Send the current location and rotation in the same call.
- UMG order: `CreateWidgetBlueprint → AddWidget → CompileWidgetBlueprint → AssetTools.save_assets`. A child's `widgetDisplayName` must equal the C++ `BindWidget` name; a `WBP_*` child uses its `_C` class as `widgetClass.refPath`. `AddWidget` with null `parentWidget` on an empty tree makes the root.
- `ProgrammaticToolset`: the script defines `run() -> dict` and calls tools via `execute_tool(name, json_string)`; only stdlib `json/re/math/datetime/copy/time` — **no `import unreal`**: for that, Python through Remote Execution (`ue.py < code`). Any tool error aborts the whole script and `try/except` does not catch it — guard with `exists()`. Call `get_execution_environment` once before first use.
- An answer is typed data: a refusal is a field of the answer (`returnValue: false`, `isError`), not an exception.
- `save_assets([])` saves ALL dirty packages — other people's too. Name the paths. There is no «list dirty packages» tool; `is_dirty` is per path.

## Screenshots

- `EditorToolset.EditorAppToolset.CaptureAssetImage(assetPath)` — lit thumbnail of a mesh/material/texture/anim (waits for textures; does NOT render Niagara).
- `…CaptureViewport(captureTransform, annotations)` — the loaded level from a camera pose, optional metre grid + actor labels, plus `labeledActors` JSON. Optional params must still be passed explicitly; a clean plate is `gridSpacing:0` + `maxLabelDistance:0`. `CaptureEditorImage` — the whole editor window.
- UMG / `WBP_*`: `OpenEditorForAsset(path)` → `SlateInspectorToolset.Windows(action:"list")` → `Windows(action:"select", index:N)` → `Screenshot(ref:"")`. Headless there is no active window — `select` is required or the image is empty; select by the window TITLE, the index depends on what else is open.
- Camera helpers: `SetCameraTransform` / `FocusOnActors` (not during PIE) / `GetVisibleActors`.
- Images come back as base64 inside the JSON text. Through the optional bridge (`references/mcp-bridge.md`) they arrive as native image blocks for the agent's own look; for a picture a person must see, write a file: `<skill>/scripts/capture-level.cmd --out <dir> --shot <name>:<x>,<y>,<z>:<pitch>,<yaw> [--grid]` and `<skill>/scripts/capture-widget.cmd --asset <ObjectPath> --out <dir>`.
- Shot traps (each looked like a broken asset):
  - property edits on actors of the CURRENT level do not recreate their render state: load another map and back (reloading the same path is a no-op) before shooting; a spawned or moved static `StaticMeshActor` likewise;
  - texture builds and streaming are async: a capture right after a texture write samples the default texture, a cold editor draws before high mips arrive; judge by data, re-shoot to confirm;
  - eye adaptation does not settle in one frame and a teleported camera renders as infinite motion blur: pin `Min EV100 = Max EV100` and `MotionBlurAmount = 0` on the post-process volume (in memory, not saved) before judging brightness or sharpness;
  - culling state carries over between captures in the headless viewport: missing walls from a corner camera — one process per shot, camera mid-wall;
  - the headless editor runs `r.SkeletalMeshLODBias=1`, so LOD0-only work (a seam fix, an outline) looks absent; set it to 0 in `Saved/Config/WindowsEditor/Engine.ini` `[SystemSettings]` and restart;
  - the first widget render of a session can show text without brushes (Slate requests textures when first drawn, streaming answers on the editor tick) — render again from a later call.

## Relocating with `AssetTools.move`

- `move` returns `false` (no error) for a package the editor holds (settings/CDO-loaded classes, the current World): repoint the config, restart, then move; switch off the current map first.
- `.umap` assets resist `move` — `duplicate` + `delete`.
- Batch a relocation in one `ProgrammaticToolset` pass, guarding each path with `exists()`.
- The in-session registry goes stale after moves/deletes; the real integrity check is a fresh editor start log (`: Error:`, `LoadErrors:`, «dependent package … was not available»).
- A ~1 KB package containing `ObjectRedirector` is a redirector; delete it once referencers are resaved.
- Bulk move/rename/delete through the toolsets leaks VRAM until restart — restart between big batches.
- Soft paths, StringTables, Niagara collections and config-pinned assets need more than a move — `content-pitfalls.md` §Packages.

## Describe current state (read-only)

- open level — `SceneTools.get_current_level` + `find_actors` (by name/type/tag/bounds) + `get_folders` / `get_actors_in_folder`;
- selection — `EditorAppToolset.GetSelectedActors` / `GetSelectedAssets` / `GetOpenAssets` / `GetVisibleActors`;
- one actor — `ActorTools.get_actor_transform` / `get_actor_bounds` / `get_components` / `get_tags` / `get_label`;
- any object — `ObjectTools.list_properties` → `get_properties`;
- vision — `CaptureViewport`.

`find_actors` with `arguments={"name":"","tag":"","collision_channels":[]}` returns ALL actors (thousands on a
real level) — filter by `actor_type` or `name`. `SceneTools` answers for the CURRENT world: after authoring a map
headless, `load_level` it first or reads return zero bounds and shots come out empty. The same holds for every
toolset read and capture after a script authored a map: they answer for the current world (often `Untitled`), not
for the map just written. Re-read after any mutation.

## Toolset capability map

- **Niagara** (`NiagaraToolsets.*`) — inspection and stack edits; a new system is a copy of an existing one edited here: `NiagaraToolset_Assets` (discovery), `NiagaraToolset_System` (schema, topology, emitters/modules/renderers, `SetStackInputData`, compile state), `NiagaraToolset_Component` (runtime `User.*` overrides), `NiagaraToolset_Blueprint`, `NiagaraToolset_Info`. Facts → `content-pitfalls.md` §Niagara.
- **Gameplay Tags** (`GameplayTagsToolset.GameplayTagsToolset`) — `ListTags`, `GetTagInfo`, `AddTag`, `RemoveTag`, `RenameTag`, `FindReferencersByTag`.
- **GAS** (`GASToolsets.*`) — `AbilitySystemInspectorToolset` (`GetAttributeValues`, `GetActiveEffects`, `GetGrantedAbilities`, `GetActiveTags`), `AttributeSetToolset`, `GameplayCueToolset`.
- **Automation tests** (`AutomationTestToolset.AutomationTestToolset`) — `DiscoverTests` → `ListTests` → `RunTests`/`RunTestsByFilter` → `GetTestResults`/`GetTestStatus` → `StopTests`.
- **Editor logs** (`EditorToolset.LogsToolset`) — `GetLogEntries(Category, Pattern, MaxEntries)`, `GetLogCategories`, `GetVerbosity`, `SetVerbosity`.
- **Config/Settings** (`ConfigSettingsToolset.ConfigSettingsToolset`) — `ListContainers` → `ListCategories` → `ListSections` → `GetSectionSchema`/`GetSectionPropertyValues` → `SetSectionProperties`.
- **Editor asset tools** (`editor_toolset.toolsets.*`) — `object`, `blueprint`, `data_table` / `data_asset` / `curve_table` / `string_table`, `static_mesh` / `skeletal_mesh` (`import_file`), `texture`, `material` (graph materials, `recompile` raises on a failed compile), `material_instance` (`set_scalar/vector/texture_parameter`), `asset`, `actor`, `primitive`, `scene` (`load_level`, `remove_from_scene` — live), `programmatic`.
- **Animation** (`animation_toolset.toolsets.*`) — `sequencer.SequencerTools`, `keyframing`, `controlrig` + `controlrig_sequencer`, `outliner` / `conditions` / `custom_bindings` / `import_export`.
- **Live Coding** (`LiveCodingToolset.LiveCodingToolset`, outside `AllToolsets`) — `CompileLiveCoding()`: blocks until the compile ends, answers one string (`Result: Success|NoChanges|Failure|…`, `Compile Output:`, `Compiler Diagnostics:`), refusals are strings too (`Error: Live Coding is not enabled for this session` — every headless editor). When to use it — the skill's C++ loop.
- **Agent Skills** (`ToolsetRegistry.AgentSkillToolset`) — `ListSkills`, `GetSkills(skillPaths)`, `CreateSkill`, `UpdateSkill`: §Agent Skills.
- **Other** — `DataflowAgent`, `PCGToolset` + `PCGSpatialToolset`, `PhysicsToolsets.PhysicsAssetToolset`, `PluginToolset`, `GameFeaturesToolset`, `DataRegistryToolset`, `SemanticSearchToolset` (`Search(query)`, `FindSimilar(assetPath)`), `aimodule_toolset…BehaviorTreeTools`, `state_tree_toolset…StateTreeTools` (inspection), `conversation_toolset`, `WorldConditionsToolset`, `SlateInspectorToolset`, `ChaosClothAssetToolset`. No EQS toolset.
- Not ours to call: `AIAssistantToolset` (plugin `AIAssistant`, Experimental, off, not in `AllToolsets`; a hidden class) serves Epic's in-editor assistant panel — `GetDockedContext` is empty unless that panel is docked in an asset editor.

## Edges of the Experimental server (UE 5.8)

- `save_assets` silently does nothing during PIE.
- Some tools return enormous payloads (a character's properties, viewport captures): scope the query.
- The server can start with zero tools: check the toolset plugins are enabled before suspecting the client.
- **Concurrency.** The server takes concurrent requests; a tool runs through `RunAsync` and its result is handed
  back on the game thread (`ModelContextProtocolServer.cpp` ~950). A synchronous tool runs on the game thread, so
  two of them run one after another. An async tool (a `UToolCallAsyncResult`: captures, waits, test runs) returns
  at once and finishes later, so it overlaps the calls after it — and answers can come back in another order than
  the requests went out. Send dependent calls and every change to one asset or one piece of editor state one by
  one, waiting for each answer; parallel only for independent reads. Two agents (or a person and an agent) on one
  editor are not stopped from writing the same asset. A modal dialog on the game thread stops every call
  (SKILL.md, "Modals").
- `PCGToolset.DrawSpline` blocks forever headless — it waits for a human to draw in the viewport.
- The headless editor (`UnrealEditor-Cmd … -RenderOffScreen`) keeps the GUI toolsets (`EditorAppToolset`, `SlateInspectorToolset`, `SceneTools`) working; `-nullrhi` breaks them.
- No tool annotations (readOnly/destructive) and no verify convention: read every write back.
- **A long call times out on the client while the editor keeps running it.** The MCP client bounds a call (120 s
  where this was measured; the optional bridge has its own `MCP_BRIDGE_CALL_TIMEOUT_SEC`), but the editor does not
  stop the script it was given: a `ProgrammaticToolset` pass or a long editor-python script goes on, and a retry
  runs it a second time over the first. Make every editor step idempotent (skip what is already done) and size each
  call to finish in about 95 s; a big batch is several calls, not one.
- `StaticMeshTools.get_material` raises on a slot with no material, and inside a `ProgrammaticToolset` script that
  is the uncatchable tool error above: the whole pass dies on one mesh. Read the mesh's `StaticMaterials` property
  (`ObjectTools.get_properties`) instead.

## Extending: a toolset of your own

First make sure it does not exist: `list_toolsets` → `describe_toolset` (or the snapshots, or `Toolsets/` folders
in the engine and the project). Ask whether the request is more general than it sounds (asset metadata belongs in
`AssetTools`, not `BlueprintTools`), and add to an existing toolset of the same domain before making a new one.
How to design and document the tools, error and test rules — `ue-cpp-authoring`,
`references/editor-tool-plugins.md` §Toolset Registry tools. The mechanics:

**Python** (preferred when the Python API covers it — no C++ build, reloaded live; verified on 5.8.3):

```python
import toolset_registry, unreal

@unreal.uclass()
class MyToolset(unreal.ToolsetDefinition):
    """What the toolset covers - an agent may see only this line."""

    @toolset_registry.tool_call
    @staticmethod
    def find_things(name_pattern: str) -> list[str]:
        """Returns the things whose name contains the pattern.

        Args:
            name_pattern: Substring to match.
        """
        if not name_pattern:
            raise ValueError("name_pattern must not be empty.")
        ...
```

- One class per file in a package under the plugin's (or project's) `Content/Python/`; type annotations on every
  parameter and return are mandatory (the schema comes from them), standard ones (`list[str]`), not `unreal.Array`.
  Private helpers: `_`-prefixed `@staticmethod`s at the end of the class.
- Registration is never automatic: `unreal.ToolsetRegistry.register_toolset_class(MyToolset)` from the package's
  registration function, called by `init_unreal.py` at editor start. It can also be called live — the toolset then
  appears in `list_toolsets` at once, named `<package>.<module>.<Class>`.
- `raise` → the call answers `isError: true` with the message as text (`call_tool` exit 1 in `ue.py`).
- After editing: `toolset_registry.reload_module(<package>)` in the editor (`ue.py < code`, or Epic's
  `ToolsetRegistry/Content/Python/toolset_registry/tests/reload_remote.py <package>`) — the changed code answers the
  next call, no restart.
- What the Python API has: search `<project>/Intermediate/PythonStub/unreal.py` (do not read it whole); it appears
  only with Editor Preferences → Plugins → Python → Developer Mode, after a restart. Missing APIs mean C++, or an
  engine change — never a fragile workaround.
- Tests: `ToolCallTestCase` (`toolset_registry/tests/toolset_testcase.py`), `assertToolRaisesRuntimeError()` for
  every raise path; run them through `AutomationTestToolset` (`DiscoverTests(force_rediscover=true)` after a reload).

**C++**: derive `UToolsetDefinition`, static `UFUNCTION(meta=(AICallable))` methods (the doc comment is the
description the agent sees), call `UToolsetRegistry::RegisterToolsetClass`
(`ToolsetRegistry/Public/ToolsetRegistry/UToolsetRegistry.h:28`) in `StartupModule` and unregister in
`ShutdownModule`. A new AICallable function needs a full editor restart (a Live Coding patch does not register
reflected surface). The registry is editor-only. Errors: `UKismetSystemLibrary::RaiseScriptError` and return a
default; long work returns a `UToolCallAsyncResult` subclass (`SetValue` / `SetError`); tests are
`BEGIN_DEFINE_SPEC(..., "AI.<Toolset>", EditorContext | ProductFilter)` with `AddExpectedError` per raise path.

`UToolsetRegistrySettings` (`ToolsetRegistrySubsystem.h:22`, Project Settings → Plugins → Toolset Registry) hides
toolsets/tools by `ToolsetBlockedNames` / `ToolsetAllowedNames` (substring, or `/regex/`; block wins) and blocks
`set_properties` on listed classes/properties.

## Agent Skills

A named instruction bundle the editor serves to agents (`UAgentSkill`: `Description` — read at discovery,
`Instructions` — the payload). Reading them — the skill's "Agent Skills inside the editor". Writing one:

1. `ListSkills` first; if one covers it, extend that one (`UpdateSkill`) instead.
2. Where it lives: project-specific, no code → a UAsset: `CreateSkill`
   `{"folderPath": "/Game/Skills/", "assetName": "MySkill", "description": "...", "details": {"instructions": "..."}}`
   answers the class path (`/Game/Skills/MySkill.MySkill_C`) and the skill is listed at once (verified on 5.8.3);
   `UpdateSkill` takes that `skillPath`. Part of a code plugin → a Python class next to the plugin's toolsets,
   versioned with it:

   ```python
   import unreal
   from toolset_registry.agent_skill import agent_skill

   @agent_skill
   class MySkill(unreal.AgentSkill):
       """One or two sentences: what it covers and when it applies."""
       instructions = 'Do X before Y, because Z.\n'
   ```

   Registered on import: one file per skill in the package's `skills/`, imported by its `__init__.py`, the package
   imported from `init_unreal.py`; after an edit — `toolset_registry.reload_module`.
3. The content: only what the agent cannot learn from the tools; written for a colleague who knows Unreal; no tool
   or property names that drift, no model or orchestration names (it must work under any agent); every sentence
   earns its tokens. The description alone must tell an agent whether to load it. Engine 5.8 ships its own guide
   for this: `GetSkills` on `/EditorToolset/Python/editor_toolset/skills/unreal_skill_best_practices_PY.UnrealSkillBestPracticesSkill`.
4. Check: `GetSkills` on the new path, read description and instructions as the agent will.

## Security

- The server binds to loopback with origin validation: that stops a browser tab, not another process of the same
  user — any local process can call it. No shared or untrusted machines; never expose the port beyond loopback.
  Python Remote Execution likewise: multicast TTL 0 on `127.0.0.1`, no authentication.
- Toolsets and Python are write access to the project: they mutate, move and delete tracked assets in one call.
  `ProgrammaticToolset.execute_tool_script` runs a script over every toolset. Before a long editor session — save
  and commit (or shelve), and review the diff after.
- With per-tool approval off (`--dangerously-skip-permissions`) an agent drives the editor with no further consent;
  keep such runs narrow and read-heavy, or in a throwaway project.

## After an engine update

- Re-dump the snapshots (`scripts/dump-toolset-schemas.cmd`), diff them against the project's own toolsets (a new
  Epic toolset may duplicate one), check whether the Experimental tag moved; refresh `LiveCodingToolset` and
  `AgentSkillToolset` notes from the new schemas.
- **`unreal_mcp_proxy`** (not in 5.8.3; look for `Engine/Plugins/Experimental/ModelContextProtocol/Extras/Proxy`).
  Epic's stdio proxy keeps the client session open while the editor is down and reconnects when it is back — the
  job of our lazy bridge (`references/mcp-bridge.md`); decide then whether the bridge is still needed. Its rules,
  from Epic's docs: `Bin/Win64/unreal_mcp_proxy.exe --mcp-json "<path>\.mcp.json" install` replaces the HTTP entry
  with a stdio `unreal-mcp-proxy` one (the old one kept under `_upstreamEntry`; `uninstall` restores it; restart
  the client once); configure one Unreal connection, never the proxy and a direct HTTP entry side by side, and stop
  editor integrations from rewriting `.mcp.json`; `unreal_mcp_status` reports the proxy's session, not whether the
  editor is reachable, and visible tools may come from its cached catalog — prove reachability with a read-only
  call; without a cache it lists only `unreal_mcp_status` until recovery sends `tools/list_changed`, and a client
  that ignores that keeps the stale list (reconnect or restart the client); killing the proxy closes the client's
  stdio (`Transport closed`) — ask before stopping one.
- Check the concurrency note above against the new server: Epic's own guidance (Sep 2026) is "serialize dependent
  calls and mutations of the same state; parallel only for independent work".
