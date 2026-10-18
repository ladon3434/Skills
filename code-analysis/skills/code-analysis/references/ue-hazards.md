# UE engine hazards — generic

Engine facts that cost a repeat in earlier projects. `hazards.cmd` searches this file together with the
project's own `.claude/docs/known-hazards.md`. A project-specific lesson goes into the project's file, an
engine-wide one here. A project section with the same title replaces the one here; a section here that
carries `<!-- aka: <title> -->` also yields to a project section under that older title, so a trap can get a
neutral title here without showing up twice in a project that kept the old wording.

Sections run in domain order: build, C++ and tests → editor process and command line → assets, packages
and references → Blueprints and components → rendering and materials → UI (UMG, Slate, CommonUI) →
animation, skeletal meshes and DCC import → world, navigation, PCG → networking and replication → Epic's `unreal-mcp` server →
Windows / Claude Code tooling (not engine; starts at «`.cmd` pwsh fallback idiom»).

## C++ edited on disk but not recompiled → the editor runs stale DLLs

**Symptom.** After a `.cpp`/`.h` edit, an MCP call, test or editor behaviour reflects the old code.

**Fact.** The editor has no compile path of its own (Live Coding aside); a source edit reaches it only
through a build and an editor restart. Before debugging «the fix did not work», confirm the running
editor was started after the build.

## An editor-only API in a runtime module breaks only the Game target

**Symptom.** Editor build and tests are green; the packaged build fails, e.g. `'GetDisplayNameText': is not a member of 'UClass'`.

**Facts.** An editor-target build does not compile the runtime module the way the Game target does.
Editor-only surface in a runtime module stays inside `#if WITH_EDITOR` (display names, tooltips,
`GetMetaData`/`HasMetaData`). Sweep: `rg -n "GetDisplayNameText|GetToolTipText|GetMetaData|HasMetaData|GetAuthoredNameForField" Source/<RuntimeModule>`;
prove with a `<Project> Win64 Shipping` (or Development Game) build — a compile-only Game build, no cook,
is cheap enough to run whenever a day touched `Source/**`.

## UHT meta ToolTip + clang-format — split-literal build break

**Symptom.** UBT fails with `Found string constant when expecting ',' or ')'` at a UPROPERTY/UFUNCTION with a long `ToolTip`.

**Cause.** clang-format splits an over-long `meta=(ToolTip = "...")` into adjacent literals, which UHT cannot parse.

**What to do.** Keep each meta string short enough to stay on one line after formatting (~200 chars).

## A zero-filled `UnrealEditor.modules` makes every run report «module <Game> could not be found» while the build reports OK

**Symptom.** The editor exits at startup with «The game module '<Game>' could not be found», a test run reports failure with nothing run, and an incremental build succeeds on zero actions. The DLL is on disk.

**Cause.** `Binaries/Win64/UnrealEditor.modules` (the module → DLL manifest) was left at its length filled
with NUL bytes by a killed or overlapping build; UBT tracks the DLLs, not the manifest, so an incremental
build leaves it.

**What to do.** Read the manifest before doubting code: it must be JSON naming the project's modules.
All-zero bytes → delete the file and rebuild.

## A GUI editor holding Live Coding stops every build, and the build scripts will not touch it

**Symptom.** A build fails in under two seconds with `Result: Failed (OtherCompilationError)` and «Unable to build while Live Coding is active».

**What to do.** A build that failed that fast compiled nothing. Confirm with `Get-Process UnrealEditor*`
(the GUI editor is `UnrealEditor`, a headless one is `UnrealEditor-Cmd`). Close the GUI editor or press
Ctrl+Alt+F11 in it — never kill someone's GUI editor — and report the compile as skipped, not passed.

## A UBT build hangs with compilers idle

**Facts.** In 5.8 UBA is always the executor; `-NoUBA` only disables syscall interception. A build whose log
does not move for ten minutes while `cl.exe` gains no CPU is hung: kill the UBT process tree and restart;
`-MaxParallelActions=8` ran clean. Release any build lock you held after the kill.

## A clangd from the agent's `LSP` tool eats commit charge and starves builds

**Symptom.** A build hangs with UBA repeating `Killed process … Low on memory`; tests flake on async asset compilation.

**Cause.** clangd with `--background-index` on a UE-sized `compile_commands.json` holds tens of GB of commit
charge (two instances measured at 32.5 GB); it is commit, not RAM, that runs out. The IDE runs one clangd;
the agent's `LSP` tool starts another.

**What to do.** Measure `Get-Process clangd | Select Id,@{n='GB';e={$_.PrivateMemorySize64/1GB}}` (commit,
not working set). Killing clangd is safe. Keep `compile_commands.json` absent by default; generate it only
for a task that needs `LSP` (UBT `-mode=GenerateClangDatabase`), and delete it plus `.cache/clangd` afterwards.
For the C++ graph prefer `rg` and the `engine-api` selector.

## Renaming a C++ module breaks assets, spec hashes and self-tests

**Facts.** A module's name is written into every asset's import table (`/Script/<Module>`); a plain text
search over `Content/` misses it (the name table is binary — list package names with a `.uasset` reader).
Fix with `+PackageRedirects=(OldName="/Script/Old",NewName="/Script/New")` in `[CoreRedirects]`, one per
module including the `…Editor` sibling. Anything that hashes or stores the module name (generated-asset
specs, test names) must be regenerated. Run the full automation pass afterwards.

## `Tests FAILED` is printed when the test never ran

**Symptom.** An automation run exits 1 with a failure, but the log has no assertion failure and no `Test Completed` line for the test.

**Cause.** The headless editor waits on `FWaitForInteractiveFrameRate` and gives up after 600 s; under load
(a parallel build, another editor) it times out having run nothing. The converse also happens: a cold
editor can under-run a filter and report PASSED — check every filter executed at least one test.

**What to do.** A red run is evidence only with the test's own `Test Completed` line and the failing
assertion; grep for the test name. `FWaitForInteractiveFrameRate: Waited N seconds` in the tail means re-run
it alone with no build in flight.

## An engine `ensure` during test teardown reds a random test — one defect, not N

**Symptom.** A suite fails a different test each full pass, sometimes goes green, and a re-run of the filter passes. The log carries an `ensure` from `AssetCompilingManager.cpp:709` («a finish compilation has been requested … but it is still being compiled»).

**Cause.** Asset builds are asynchronous; a teardown that deletes or unloads a package still being built
fires the ensure, and the framework turns it into a failed test. An `ensure` fires once per process per
site, so at most one test goes red per run, whichever lost the race. A texture edited again over a live
build can end up compiling and unregistered, invisible to every drain.

**What to do.**

- Author textures as `PreEditChange(nullptr)` → mutate → `PostEditChange()` → `BlockOnAnyAsyncBuild()` before anything else sees them. Never call `FinishCachePlatformData()` by hand.
- Drain first in any teardown, bake, merge or capture after an asset write: `FAssetCompilingManager::Get().FinishAllCompilation()`.
- A red that moves between runs is one mechanism; «the failing test is outside my change» is a hypothesis until that suite passes alone. Prove a fix by several runs in a row.
- A second site with the same shape: `TypedElementRegistry.h:593` «Element type ID '0' has not been registered» on world teardown.

## `TestEqual` on strings compares case-insensitively

**Fact.** In UE 5.8 every string overload of `FAutomationTestBase::TestEqual` ignores case; use
`TestEqualSensitive` / `TestNotEqualSensitive` (`Misc/AutomationTest.h`) when case is the subject, and prove
it by mutation. `FString::StartsWith`/`Contains`/`==` also ignore case by default.

## A comma-separated command-line value arrives cut to its first item

**Symptom.** `-MyList=A,B` reaches the game as `A`; the second item silently does nothing (a queue of one
instead of two, no error anywhere).

**Cause.** `FParse::Value(Stream, Match, Out, bShouldStopOnSeparator = true)` stops an unquoted value at `,` or
`)` as well as at whitespace (`Misc/Parse.h`, UE 5.8).

**What to do.** Parse lists with `FParse::Value(..., /*bShouldStopOnSeparator*/ false)` and split yourself, or
require quotes; test the parser with two items, not one.

## A forced exit loses the tail of the log

**Symptom.** A process that ends itself on failure (a test runner, a watchdog) leaves a log that stops before the
reason it failed; a hang and a crash look the same.

**Cause.** `FPlatformMisc::RequestExitWithStatus(/*Force*/ true, Code)` ends the process with `TerminateProcess`
on Windows: no unwinding, no file close, the log's buffered lines are lost.

**What to do.** `GLog->Flush()` right before a forced exit; keep the exit code meaningful (0 pass, non-zero
fail) and print the verdict line before flushing.

## Loading a Blueprint class by `_C` path in the editor can return a stale class

**Symptom.** In the editor a Blueprint class found by path (`/Game/X/BP_Y.BP_Y_C`) is silently skipped or
behaves like the old version, while the cooked build works.

**Cause.** After a recompile-on-load the old generated class stays loaded with `CLASS_NewerVersionExists`; a
lookup by path may hand it out.

**What to do.** In the editor take the class from the asset: load the `UBlueprint` and use its
`GeneratedClass`; fall back to the `_C` path (`Cast<UClass>`) only in a cooked build, where `UBlueprint` does not
exist. Skip any class flagged `CLASS_NewerVersionExists`.

## `TObjectIterator<UClass>` returns the editor's shadow classes of every Blueprint

**Symptom.** Collecting all subclasses of a base (tests, scenarios, plugins of a kind) yields duplicates or
classes that fail to instantiate.

**Cause.** Next to each Blueprint the editor keeps `SKEL_`, `REINST_`, `TRASHCLASS_` and `PLACEHOLDER-CLASS`
classes that also derive from the base. The iteration order is not stable between runs.

**What to do.** Filter those name prefixes (and `CLASS_Abstract`, `CLASS_NewerVersionExists`), deduplicate before
any further filter, and sort by an explicit key — never rely on discovery order.

## Blueprint lookup at `UGameInstance` / subsystem `Initialize` finds nothing

**Symptom.** Code that finds Blueprint classes in folders works for C++ classes but finds no Blueprint, with no
error; in the editor and in the cooked build alike.

**Cause.** At `Initialize` time the asset registry may not have scanned the folders yet and the Blueprint
classes are not loaded.

**What to do.** Resolve after the first world is initialised (`FWorldDelegates::OnPostWorldInitialization`,
then unbind so later map loads do not re-run it), and `ScanPathsSynchronous` only the folders you search. A
folder picked in a settings UI may come with a trailing `/`, which the registry rejects — trim it. Assets
nothing references reach a cooked build only through `DirectoriesToAlwaysCook`.

## A GPU crash in a Shipping build names nothing — what to set and how to read the dump

**Symptom.** The packaged game dies with `CrashType = GPUCrash` / `DXGI_ERROR_DEVICE_HUNG`, naming no pass or shader; the `.nv-gpudmp` beside it looks like noise.

**Facts.**

- Shipping compiles out RHI breadcrumbs; no cvar brings them back.
- Aftermath detail (`r.GPUCrashDebugging.Aftermath.Markers`, `…ResourceTracking`, `…Callstack`, `…ShaderErrorReporting`), DRED (`r.D3D12.DRED`) and `r.Shaders.Symbols` are read-only cvars read at RHI init; they live in `Config/DefaultEngine.ini` (`[SystemSettings]`, symbols in `[ShaderCompiler]`). `-gpucrashdebugging` does not reach the detail flags; `-nvaftermathall` does.
- `-dpcvars` does nothing in a Shipping build (parsed only under `#if !UE_BUILD_SHIPPING`), though the token shows in the crash context. A cvar reaches Shipping through config only.
- The dump decodes without Nsight: the engine ships the Aftermath lib and decoder headers (`Engine/Source/ThirdParty/NVIDIA/NVaftermath/`); a small `cl.exe` program calling `GFSDK_Aftermath_GpuCrashDump_CreateDecoder` → `GenerateJSON` → `GetJSON` yields device state, page-fault info and shader infos. `Error_DMA_PageFault` means an out-of-bounds read, not a heavy shader.
- The faulting shader can be matched by byte size against `Saved/ShaderSymbols/<platform>/*.dxil` after a symbol cook.

## A cold editor boot on a file DDC takes 3–4 minutes

**Fact.** A cold boot walks the file-based DerivedDataCache before opening any listening port. Tell «alive
and slow» from «dead» by whether `Saved/Logs/<Project>.log` is still advancing (its mtime / size); check it
before killing anything. A second launch into the same port fails (next entry).

## A second editor on the MCP ports boots deaf — `EDITOR STARTING` forever, or `ECONNREFUSED` with an editor alive

**Symptom.** Every MCP call times out or answers `ECONNREFUSED` while an editor process is alive.

**Cause.** An MCP / HTTP plugin port is fixed and the editor that started first holds it. A second one logs
`HttpListener unable to bind to 127.0.0.1:<port>` with `bFailOnBindFailure? false` and runs on without the
server. Binding happens only at startup, so when the first editor dies the second never picks the port up.

**What to do.** `Get-NetTCPConnection -State Listen -LocalPort <port>` names the owning pid, and
`grep "unable to bind" Saved/Logs/*.log` finds a deaf editor. If a person's GUI editor holds the port, say so
and stop — never kill it. A deaf editor is cured only by restarting it.

## A Windows SSH session runs in Session 0 — no GPU, and its processes die on disconnect

**Facts.** An OpenSSH session has no window station and no access to a WDDM GPU; anything touching the UE
editor hangs at `InitializeEngineGraphics`, and sshd kills the process tree on disconnect. Hand GPU/desktop
work to the interactive session (a Task Scheduler task set to «Run only when user is logged on», started
with `schtasks /run`). Autologon is required for remote UE work.

## A local server never binds, as if its port were taken — a Windows-reserved port (EACCES)
<!-- aka: «tracker lease held by another session» with no other session alive — a Windows-reserved port (EACCES) -->

**Symptom.** A local service (an MCP server inside the editor, a lock broker, any harness daemon) never comes up as if its port were taken, though nothing listens there; a node server exits 1 silently.

**Cause.** The listen fails with `EACCES` (reserved), not `EADDRINUSE` (taken). WinNAT/Hyper-V reserve blocks
of the dynamic TCP range at every boot, and that range can start as low as 1024
(`netsh int ipv4 show dynamicport tcp`, `netsh int ipv4 show excludedportrange protocol=tcp`), so the blocks
move from boot to boot.

**What to do.** Put every fixed harness/MCP port above the dynamic range (and mirror it in the editor's
config). Diagnose a bind refusal by errno: `net.createServer().listen(port, '127.0.0.1')` in node.

## PowerShell splits an unquoted `-Name=value.with.dot` argument to a native program

**Symptom.** `UnrealEditor-Cmd.exe … -MountDir=UE.ANIM` from PowerShell arrives as `-MountDir=UE .ANIM`; from `cmd` or a `.cmd` shim it arrives whole.

**What to do.** From PowerShell, single-quote such arguments: `'-MountDir=UE.ANIM'`. Long runs go through a `.cmd` shim.

## Git Bash rewrites a `/Script/...` argument into a Windows path, so a scan for it reads zero

**Fact.** MSYS converts any argument that looks like a POSIX path: `rg -F "/Script/MyGame" Content` searches
for `C:/Program Files/Git/Script/MyGame` and finds nothing, which reads as «no package uses it». Run such a
scan with `MSYS_NO_PATHCONV=1` (or from PowerShell), and check it against a name that must hit before
trusting a zero.

## `-script=` silently does nothing when the path contains a space

**Symptom.** `UnrealEditor-Cmd … -run=pythonscript -script=<path>` exits in seconds with a non-zero code and no `LogPython` line or traceback.

**Cause.** The value is not parsed as a quoted path; a path under a user folder with a space is truncated.

**What to do.** Run headless python from a space-free path; `-abslog=` has the same flaw. Use `-run=pythonscript -script=`, never `-ExecutePythonScript`.

## Exporting a skeletal mesh to FBX does not work in a commandlet — it needs the full editor

**Symptom.** `UnrealEditor-Cmd -run=pythonscript` with `unreal.Exporter.run_asset_export_task` on a `USkeletalMesh` dies with `Assertion failed: MeshObject` (`SkinnedMeshComponent.cpp:4987`), with or without `-nullrhi`/`-RenderOffScreen`.

**Cause.** The exporter reads vertices through `GetCPUSkinnedVertices`, which needs the render state of a registered component; a commandlet has no world.

**What to do.** Run the python in the full headless editor:

```text
UnrealEditor-Cmd.exe <project> -unattended -nopause -nosplash -RenderOffScreen -stdout \
  -ExecCmds="py <file.py>, quit" -abslog=<log>
```

`quit` does not always land; stop the editor afterwards. «No exporter tool» in an MCP toolset is true of the toolset, not of the engine.

## Relocating an asset a `.umap` references deadlocks the headless editor

**Symptom.** A move/rename never returns: the call times out, the editor sits at idle CPU, the log stops mid-move, the frame counter freezes and the MCP port stops accepting.

**Cause.** `IAssetTools::FixupReferencers` re-saves referencing world packages, a headless world fails to
save, and the failure opens the modal `SFixupRedirectorsReport`, which waits for a click forever. No flag
combination makes it safe headless.

**What to do.** Headless code never calls `FixupReferencers`; rewire referencers yourself and save them
through `UEditorLoadingAndSavingUtils::SavePackages`. Nothing in a headless editor may open a modal dialog:
a hang with a frozen frame counter and a refusing port means a modal — look for it before suspecting slowness.

## MCP tool that bakes materials / merges meshes → re-entrant ticker crash

**Symptom.** An editor-side MCP / HTTP tool that triggers material baking or mesh merge hard-crashes the headless editor with `Assertion failed: IsValid()` in `SharedPointer.h`. A trivial cube never reproduces it.

**Cause.** The call runs inside the HTTP server's ticker tick; engine code that waits by pumping
`FTSTicker::GetCoreTicker().Tick()` (e.g. `FMaterialBakingProcessor::CreateMaterialProxies` waiting for
texture mips) re-enters it and asserts.

**What to do**, before the engine call that pumps the ticker:

- `FAssetCompilingManager::Get().FinishAllCompilation();`
- Force every texture the bake touches resident: `Tex2D->SetForceMipLevelsToBeResident(30.f, 0xFFFFFFFF)` for each `UMaterialInterface::GetUsedTextures` result.
- `IStreamingManager::Get().StreamAllResources(0.f);` then `IStreamingManager::Get().BlockTillAllRequestsFinished();` — these do not tick the core ticker.

## A programmatic material rebuild is undone by an open Material Editor tab
<!-- aka: MakeMaterial rebuild vs an open Material Editor tab → VerifyMaterial mismatch -->

**Symptom.** A programmatic material rebuild logs success, but the saved asset is the old graph.

**Cause.** The material is open in a GUI Material Editor; its working copy (a separate preview material) is
re-saved over the rebuilt asset. The same holds for any asset editor tab over a programmatic rebuild.

**What to do.** Rebuild with no editor tab open on the asset (or close it first); a rebuild triggered from
inside the GUI closes and reopens the asset editor around it.

## Rebuilding a material a C++ constructor loads crashes with `Assertion failed: !IsRooted()`
<!-- aka: `MakeMaterial` crashes the editor with `Assertion failed: !IsRooted()` rebuilding a material a C++ default loads -->

**Symptom.** Rebuilding an existing material programmatically kills the editor in `UMaterialEditingLibrary::DeleteMaterialExpression`, every time, on a fresh editor too; a new material builds fine.

**Cause.** A C++ constructor loads an asset that uses the material (`ConstructorHelpers::FObjectFinder` on a
mesh): it loads at editor start into the root set, which GC never frees, and the material's expressions come
along pinned, so they cannot be deleted.

**What to do.** A C++ default that names a game asset is a `TSoftObjectPtr` loaded where it is used (`LoadSynchronous`), never a constructor-loaded hard pointer.

## `DeleteAsset` on a World/`.umap` — or any asset the editor still holds — reports success but leaves the file
<!-- aka: an editor tool's `DeleteAsset` on a World/`.umap` — or any asset the editor still holds — reports success but leaves the file -->

**Symptom.** A delete (`UEditorAssetLibrary::DeleteAsset` or a tool over it) reports success and the file stays on disk. Happens for worlds and for any live-held package (e.g. a skeletal mesh just created; the log shows `Waiting for skinned assets to be ready`). The editor's current level cannot be deleted at all.

**What to do.** Always prove a delete by the file and the registry, never by the return value. To remove a
`.umap`: (1) if it is current, load another map; (2) delete the asset; (3) delete the file on disk; (4) rescan
the folder in the asset registry; (5) check it is gone. Or stop the editor first.

## A deleted Blueprint stays on disk: «delete reported success» but the `.uasset` is still there

**Symptom.** `UEditorAssetLibrary::DeleteAsset` logs `Force Deleting 1 Package(s)` and returns true, the package leaves memory, yet the file stays; the registry later warns «marked as deleted in editor, but has been modified on disk». Seen on a Blueprint unloaded and then deleted (a test teardown).

**Cause.** `DeleteAsset` loads the package from disk, and loading a Blueprint leaves compile leftovers that
reference its class until the next GC. `ObjectTools::CleanupAfterSuccessfulDelete` counts them as
referencers (`GatherObjectReferencersForDeletion`) and silently drops the file from its list; its own GC then
frees everything, so nothing in memory explains it afterwards.

**What to do.** Load the package and `CollectGarbage(GARBAGE_COLLECTION_KEEPFLAGS)` before the delete, then
prove the file is gone.

## `RelocateAssets` silently breaks a reference when the referencer rides the same batch

**Symptom.** A kit moved in one batch looks right in session; after a restart materials have no textures, Sequence Players report an unknown Anim Sequence, mesh slots are empty. The log shows `(rename, no redirector)`.

**Cause.** In a batch `IAssetTools::RenameAssets`, a referencer that is itself in the batch is saved with the
pre-move path, and no redirector is left when the registry sees no referencers (a fresh pack before indexing).

**What to do.** Move a foreign kit one asset class per call (meshes, skeletons/physics, animations,
materials, textures). Verify on a fresh editor (a mesh lists its textures, a skeleton counts every
animation as referencer). A skeletal mesh rename can leave both copies while a demo Character Blueprint that
uses it is loaded — delete that Blueprint first. A pack's preview material can be the only material its mesh has.

## Loading an asset with an unreachable reference and saving it loses the reference forever

**Symptom.** After a routine move, fixup or analysis pass, a dangling reference is gone from the package entirely; nothing can tell what it pointed at.

**Cause.** An unresolvable import becomes null on load, and the next save writes the null. One `LoadObject` + one `SavePackage`, no warning.

**What to do.** Freeze a set of assets with dangling references: no move, fixup, rebuild or analysis that
opens them in the editor. Restore every reference target at the path the references name first, then
operate. Reading the dangling paths out of the `.uasset` bytes (plain strings in the name/import table) is
safe. After a save, only version control brings it back.

## A `TSoftObjectPtr` set from text needs the OBJECT path, and readback reports it fine on a dead one
<!-- aka: A `TSoftObjectPtr` set through `PropertiesJson` needs the OBJECT path, and both Verify and the tool report PASS on a dead one -->

**Symptom.** A feature driven by a soft reference set from text/JSON (a property dialect, `set_properties`, an ini) is simply absent at runtime; property readback shows the value.

**Cause.** A soft reference resolves only from a full object path (`/Game/Dir/SM_Wheel.SM_Wheel`); a package
path makes `LoadSynchronous()` return null. Readback compares the stored string without resolving it.

**What to do.** Write every soft-object value as `Package.Object`. Verify by resolving it
(`LoadSynchronous` non-null), and give the consumer a warning log line when it does not resolve.

## Moving content leaves every SOFT object path pointing at the old home

**Symptom.** After a folder move everything loads (a `CoreRedirects` prefix papers over it) until the redirect is pruned; then packs stop resolving internals or a Packed Level Actor opens the wrong world.

**Cause.** Reference fix-up walks dependency edges; a soft object path is a string in a property and is not rewritten. A resave writes the same string back.

**What to do.** In one editor with the redirect still in place:
`AssetToolsHelpers.get_asset_tools().rename_referencing_soft_object_paths(packages, replacements)` over
old→new object paths, then `EditorAssetLibrary.save_directory(root, only_if_is_dirty=False, recursive=True)`,
and drop the redirect last. Prove by behaviour on a cold boot without the redirect; vendor `FDirectoryPath`
defaults and documentation graphs keep the old strings harmlessly.

## A copied texture keeps a `CompositeTexture` pointer into the pack it came from

**Symptom.** A copied texture looks and verifies fine, yet a dependency walk says it still depends on the source pack (e.g. a mask texture naming the pack's normal map).

**Cause.** `UTexture::CompositeTexture` (`CTM_NormalRoughnessToGreen`) is a compression-time input; it touches
no slot or pixel, and asset duplication does not rewire it. It breaks when the source pack is deleted.

**What to do.** Before deleting a source pack, walk the dependencies of everything copied out of it and
report anything still naming the pack's path. Fix by pointing `CompositeTexture` at the copied normal (set
the property and save) or clearing it.

## A pack mesh's SECOND material layer hides in vertex colours, and dropping the vendor master drops it silently

**Symptom.** After moving a vendor mesh onto your own master material it shows one of its two layers everywhere.

**Cause.** The vendor master blended two albedos by `VertexColor`; a master that reads no vertex colours
loses one layer. The FBX's `LayerElementColor` says nothing reliable, and no slot listing or render exposes the buffer.

**What to do.** Read the mesh's vertex-colour buffer (no buffer / solid white / real paint) before replacing
a vendor master. A copy keeps the buffer, so the layer can be restored later by giving your master the same lerp.

## A case-only rename takes on the FILE and silently fails on the FOLDER

**Symptom.** Renaming `KEYS/` → `Keys/` through an intermediate name reports success; file names change case, the directory stays `KEYS`.

**Cause.** Windows resolves `Keys/` to the surviving empty `KEYS` directory; the asset registry compares paths case-insensitively; `core.ignorecase = true` hides it from git.

**What to do.** Rename the folder on disk and rescan the registry, then verify the directory's case; fix git
by hand: `git rm -r --cached <OLD>` and `git add <NEW>`.

## A Blueprint's parent read from the IMPORT table is a guess

**Fact.** The import table lists casts and parents alike; the asset-registry `NativeParentClass` /
`ParentClass` tag in the package's asset-registry data is authoritative and needs no editor.

## A freshly saved package has no dependencies as far as the registry is concerned

**Symptom.** A test saves a referencing package, asks «who references this folder», gets nothing — and a reference guard passes while guarding nothing.

**Cause.** `FAssetRegistryModule::AssetCreated` announces existence but does not read the saved file's dependency table.

**What to do.** After saving a package a test will ask reference questions about:
`IAssetRegistry::ScanFilesSynchronous({Filename}, /*bForceRescan*/ true)`. Same for any package written
outside the editor's save path.

## The GUI editor «does not keep» an asset edit: the save failed on a file a headless editor holds
<!-- aka: The owner's editor «does not keep» an asset edit: the save failed on a file the headless editor holds -->

**Symptom.** An asset edited and saved in the GUI editor loses the change after a reopen. The file's time on disk is older than the edit; the GUI editor log has `MoveFile was unable to move '<asset>.uasset' ... (Error Code 32)` then `Error moving file`.

**Cause.** Error 32 is «file in use»: another editor process (e.g. a headless one behind an MCP bridge) has
the same package loaded, and Windows will not let the GUI replace the file under it. Any read of the asset in
that process — a property query, a verify — loads it.

**What to do.** Stop the other editor before hand-editing assets, then save again. When an edit «does not
keep», grep the editor log for `Error Code 32` before anything else.

## Asking the active viewport for a hit proxy takes the whole editor down the moment PIE starts

**Symptom.** The editor dies ~90 ms after `PIE: Play in editor total start time`; `Saved/Crashes/<newest>/CrashContext.runtime-xml` shows `Assertion failed: ColorRT [RHIResources.h:5395]` under `FViewport::GetRawHitProxyData`.

**Cause.** During PIE `GEditor->GetActiveViewport()` returns the game viewport, which has no hit-proxy render target.

**What to do.** A per-tick `GetHitProxy` on `GetActiveViewport()` bails when the viewport equals
`GEditor->GetPIEViewport()`; do not gate on `PlayWorld` (Simulate keeps the level viewport).

## Property edits on actors of the CURRENT level do not reach the viewport — the shot shows a scene that does not exist

**Symptom.** Actors added or edited programmatically read back right and the `.umap` saves correctly, but a viewport capture shows nothing of them.

**Cause.** When the target level is already the editor's current world, a `Component.Property` edit changes
the object and package but does not recreate the component's render state in the live world.

**What to do.** After programmatic placement or property edits on the loaded level and before capturing,
reload it: load another map and back (reloading the same path is a no-op). Do not rebuild the level.

## A copied or relocated Niagara system re-anchors its Parameter Collection to the old path on restart

**Symptom.** A copied/moved Niagara system checks clean in session; after an editor restart it depends on the original Niagara Parameter Collection again.

**Cause.** The collection path is baked as a string into compiled VM data
(`FNiagaraVMExecutableData::ParameterCollectionPaths`) and re-resolved on every load; no object-graph rewrite
or plain resave changes it.

**What to do.** Move the collection itself keeping its redirector (it must stay resolvable), then recompile
and save every consumer system. Delete the redirector only after a cold editor confirms no consumer names the
old path (with the editor stopped — the Niagara editor module holds the package). Always verify on a fresh
editor. A half-moved collection crashes the next cold boot.

## Reparenting a Blueprint to `AActor` takes away every inherited scene component

**Facts.** A vendor assembly's scene components are often inherited from the pack's parent Blueprint;
reparenting to `AActor` removes them and the engine re-nests the orphans with their old relative transforms,
so pieces stand displaced and rotated. Compile and attach counts do not show it: rebuild the inherited tree
and compare actor-space transforms against the original.

## Reparenting a bought Blueprint onto your C++ class renames the pack's colliding variables
<!-- aka: Reparenting a bought Blueprint onto our C++ class renames the pack's colliding variables -->

**Symptom.** After reparenting, the log carries `ValidateVariableNames name X ... is already taken` and `changed to X_0`; the pack's variable is the one renamed.

**What to do.** Before reparenting, strip your C++ parent to the minimum reflected surface (drop `UPROPERTY`
where no reflection is needed) and give what stays names a vendor would not choose. Read the log for
`ValidateVariableNames` afterwards.

## A reparent that is not saved is lost when the editor stops

**Fact.** Reparenting, adding events or nodes through scripting changes the in-memory Blueprint only; a build
stops the editor. Save the asset in the same session.

## A Blueprint override of a component transform survives the C++ re-parenting silently

**Symptom.** After the C++ constructor re-attaches a component with a new relative transform, the Blueprint reads back a third value (the previous constructor's numbers) and in play the component sits somewhere impossible.

**Cause.** A Blueprint that ever touched the transform serializes an override that outranks the CDO; re-parenting in C++ does not clear it.

**What to do.** After any C++ change to a component's attachment or default transform, read the Blueprint CDO
(`/Game/…/BP_X.Default__BP_X_C.<Component>`) and compare. Reset-to-default in scripting resets to the type
default (zero), not the archetype — set the intended numbers explicitly and save.

## A component's own transform survives placement only if it is NOT the root

**Symptom.** A Blueprint sets its mesh component's scale and rotation, and the placed actor ignores both.

**Cause.** The root component's transform is the actor's; the placement call overwrites it. A placed actor also does not adopt later changes to its Blueprint's components.

**What to do.** Give the actor an empty `USceneComponent` root and hang the mesh off it. When a placed actor still looks wrong after the class is fixed, remove and re-place it.

## Components built in `OnConstruction` DOUBLE on Play — a `Transient` bookkeeping array does not survive PIE duplication

**Symptom.** An actor that builds components in `OnConstruction` shows two of everything on Play at the same transform.

**Cause.** The clear pass destroys a `UPROPERTY(Transient)` list of what it made; PIE duplication carries the components but not the list, so the rebuild lays a second set on top.

**What to do.** Tag each built component (`ComponentTags.Add(Tag)`) and clear by `GetComponents` +
`ComponentHasTag`. Test shape: attach a stale tagged component by hand, rebuild, assert the count.

## A headless capture shows defaults or low mips — `CaptureAssetImage` after a texture write, a cold showbox shot, a blurry close-up

**Symptom.** An instance with the right textures renders as the grey checker; a shot of a cold asset is near-black whatever its material; a close-up is muddy while the map is sharp. Two very different materials photographing identically is the tell.

**Cause.** Texture builds and streaming are asynchronous: a capture right after a write samples the parameter
default (`/Engine/EngineResources/DefaultTexture`), and a freshly booted editor draws before high mips are
resident. `-NoTextureStreaming` does not help.

**What to do.** Judge an instance by its data and treat a capture as confirmation; when they disagree,
capture again. The asset thumbnail renderer waits for textures, a viewport capture does not. For a
close-up, set `NeverStream=true` on the subject's textures in memory, without saving, and stop the editor afterwards.

## Headless shots: auto-exposure and motion blur make brightness and sharpness meaningless

**Symptom.** Two viewport captures of the same state range from near-black to normal; far surfaces clip white, near ones black. Frames are smeared radially, the same on every retake.

**Cause.** Eye adaptation does not settle in one frame, so a shot catches a random point of it. The capture teleports the camera, and motion blur renders that as infinite speed.

**What to do.** Trust a headless shot for structure and for differences between two shots taken in the same
conditions, not for absolute brightness. Before judging brightness, pin `Min EV100` = `Max EV100` and set
`MotionBlurAmount = 0` on the PostProcessVolume, in memory, without saving the map.

## A headless render never shows a skeletal mesh's LOD0

**Fact.** A headless editor runs `r.SkeletalMeshLODBias=1` from the engine's scalability defaults, so every
skeletal mesh it photographs is drawn one LOD coarser than asked: LOD0-only work looks absent or wrong while
a GUI editor shows it fine. A machine-local `Saved/Config/WindowsEditor/Engine.ini` with `[SystemSettings]`
`r.SkeletalMeshLODBias=0` and an editor restart makes renders show LOD0.

## A material usage flag is invisible everywhere except a packaged build

**Symptom.** Instanced static meshes render the grey checker in a packaged build while property readback shows the right material; the editor looks correct because it sets missing flags at load.

**Cause.** A material must declare usage for its geometry — `MATUSAGE_InstancedStaticMeshes` for ISM/HISM
and foliage (there is no `MATUSAGE_Foliage` in UE 5.8), `MATUSAGE_SkeletalMesh` for skinned meshes — or the
renderer substitutes the default material. The cook log says nothing.

**What to do.** Set the usage flags explicitly on every master a generated or programmatic material path
produces (`bUsedWithInstancedStaticMeshes`, `bUsedWithSkeletalMesh`, …) and save. Instancing is decided by
placement, so test on an actual instance in a packaged build.

## Flipping a texture's `SRGB` without its SAMPLER type breaks the material COMPILE — white mesh in game, nothing wrong in the editor

A `SAMPLERTYPE_Color` node fed a non-sRGB texture fails the whole material:

```text
LogMaterial: Warning: [AssetLog] .../M_X.uasset: Failed to compile Material for platform PCD3D_SM6,
             Default Material will be used in game.
	(Node TextureSampleParameter2D) Sampler type is Color, should be Linear Color for .../T_X_Roughness
```

The editor keeps drawing the previously compiled shader, so preview, thumbnail and viewport look right; the evidence is in `Saved/Logs/<Project>.log`.

- `SRGB` on the texture and `SamplerType` on the node are one setting across two assets — change both in one pass. Masks (roughness, metalness, AO, packed ORM) are `SAMPLERTYPE_LinearColor`; albedo `SAMPLERTYPE_Color`; normal maps `SAMPLERTYPE_Normal`.
- After writing sampler types, force a recompile and read its result (a recompile that raises on failure is the check).
- When a mesh goes white in game, read the PIE log before touching the asset.

## `PerInstanceSMData` is `SkipSerialization` — instances set as a property do not exist

**Symptom.** Instances assigned to a HISM as a property read back fine and are gone after reload.

**What to do.** Add instances with `AddInstance` / `AddInstances`, then `BuildTreeIfOutdated` on a HISM. For any `SkipSerialization` property the evidence is a reload.

## A material written from `.hlsl` loses `bIsSky`, and its motion stands still in the viewport

**Facts.** A programmatic material rebuild that does not know `bIsSky` clears it; set it after the build and
save. Epic `unreal-mcp` `set_properties` takes `values` as a JSON STRING and the object as `{refPath}` — pass a
real object and it silently answers `false`. Material time runs in the editor viewport only under Realtime,
and a drift in radians per second at 0.01 stands still to the eye.

## CommonUI action glyph (`UCommonActionWidget`) blank → empty `ControllerData`

**Symptom.** A prompt built on `UCommonActionWidget` shows its label but no key glyph, for every key and input type, at design time too (`Design Time Key = E` renders nothing).

**Cause.** The glyph is resolved through `UCommonInputPlatformSettings::Get()->TryGetInputBrush`, which walks
the per-platform `ControllerData` list. `+ControllerData=` lines in `DefaultGame.ini` can be present and still
not reach the per-platform settings object, so Project Settings → Common Input shows an empty Controller Data list.

**What to do.** Populate Controller Data with the `CIBCD_Keyboard/XBox/Playstation` classes through the
Project Settings UI and save. Fast bisect: if `Design Time Key` shows no glyph, it is this data layer, not code.

## CommonUI menu does not free the mouse the second time — the router still thinks «Menu»

**Symptom.** The first menu frees the cursor; every later one leaves the mouse with the game. `LogUIActionRouter` prints `UIInputConfig being changed ... New (Menu)` only for the first.

**Cause.** `UCommonUIActionRouterBase` applies a config (releasing mouse capture) only when it differs from
the one it holds. A screen that gives the game its input back by hand (`SetInputMode(FInputModeGameOnly())`)
leaves the router at «Menu», so the next «Menu» changes nothing.

**What to do.** Giving the game back, tell the router too (e.g. in the screen's `NativeOnDeactivated`):
`UCommonUIActionRouterBase::Get(*this)->SetActiveUIInputConfig(FUIInputConfig(ECommonInputMode::Game, EMouseCaptureMode::CapturePermanently_IncludingInitialMouseDown), this)`.

## CommonUI does not return input after a screen closes — wrong viewport client

**Symptom.** A `UCommonActivatableWidget` screen closes and the player keeps a cursor and no game input; a manual `SetInputMode(FInputModeGameOnly())` in `NativeOnDeactivated` changes nothing.

**Cause.** `UCommonUIActionRouter` exists only when the viewport client derives from `UCommonGameViewportClient`. The log says it at every world start:

```text
LogUIActionRouter: Error: Using CommonUI without a CommonGameViewportClient derived game viewport
client. CommonUI Input routing will not function correctly.
```

**What to do.** In `Config/DefaultEngine.ini`, `[/Script/Engine.Engine]` →
`GameViewportClientClassName=/Script/CommonUI.CommonGameViewportClient`. Check with
`UnrealEditor-Cmd.exe <project> -game -unattended -nullrhi -ExecCmds="quit" -log=<file>` and grep
`UIActionRouter`: `Applying input config` means the router is alive.

## CommonUI's Back (or any UI action) is dead on one gamepad key — a game context shadows the UI's mapping

**Symptom.** A CommonUI Back handler closes on Esc (or Start) but not on gamepad B; nothing is logged.

**Cause.** CommonUI finds a UI action's keys in `PlayerInput->EnhancedActionMappings`
(`QueryKeysMappedToAction`). `RebuildControlMappings` leaves out a lower-priority context's mapping of a key
that a higher-priority context gives to an action with `bConsumeInput` (`EnhancedInputSubsystemInterface.cpp`,
the `AppliedKeys` check). Esc can appear to work only because a game pause key closes the screen.

**What to do.** The UI Input Mapping Context goes above every game context in priority, and none of its actions consumes input.

## The first `RenderWidget` of a session draws text on empty ground — the pictures arrive on a later call

**Symptom.** A headless widget render returns every text block and no brushes; property readback shows the brushes assigned, and a render a minute later is complete.

**Cause.** A Slate brush requests its texture only when first drawn, streaming answers on the editor's own
tick, and a tool call cannot advance that tick (ticking from inside an MCP tool re-enters the server).

**What to do.** Treat the first render in a session as a warm-up and render again from a later call, not a second entry in the same batch.

## A Slate brush with a real texture paints FLAT COLOUR until `ImageType` is named

**Symptom.** A widget draws a flat rectangle where art was expected; `ResourceObject`, size and tint read back correct.

**Cause.** `FSlateBrush::ImageType` defaults to `NoImage` and is not derived from the resource.

**What to do.** Every brush written programmatically names `"ImageType": "FullColor"` (or `Image`/`Box`/`Border` as intended).

## Nine-slice margins must sum below 1 per axis and fit the widget's pixel size

**Fact.** Margins are fractions per axis; top + bottom ≥ 1 leaves a negative centre and Slate draws nothing
while the brush reads as assigned. They also resolve to pixels against the widget's own size (12 px corners
do not fit a 9 px bar). Read margins off the source art.

## Engine widget defaults quietly eat the art: blue fill, fill over track, zero collapse

- `UProgressBar::FillColorAndOpacity` defaults to blue `(0, 0.5, 1)` and multiplies the fill brush, so a warm texture goes near-black.
- `USlider` draws its fill over the track; an opaque track brush hides the fill.
- A widget with no content collapses to zero size; a decorative plate around it has no box.

**What to do.** Give every headlessly authored UMG element an explicit size, set every multiplying default, and judge by a render, not property readback.

## Authoring a Widget Blueprint from C++: the tree is enumerated by OUTER, not by the root

`WidgetTree->ConstructWidget` + `AddChild` builds a correct-looking tree, but two invariants are kept only by the editor UI path:

- **The compiler collects source widgets by outer.** `UBaseWidgetBlueprint::ForEachSourceWidget` uses `ForEachObjectWithOuter(WidgetTree, …)`, while `GetAllWidgets()` walks `RootWidget`. Clearing `RootWidget` does not empty the tree; to rebuild, `Rename` the old widgets into the transient package.
- **`WidgetVariableNameToGuidMap` must equal the named-widget set both ways** (`WidgetBlueprintCompiler.cpp:781` «was added but did not get a GUID», `:815` «was deleted but still has a GUID»). Maintain it with `UWidgetBlueprint::OnVariableAdded` / `OnVariableRemoved`.

The decoy: «A required widget binding X was not found» during compile comes from the internal compile in `FKismetEditorUtilities::CreateBlueprint` on an empty tree; it is a warning and not this bug.

## Skeletal-mesh programmatic edits — engine facts every tool must respect

- One `FScopedSkeletalMeshPostEditChange` bracket per operation: each `PostEditChange` rebuilds all LOD render data.
- Never let a write-back recompute normals/tangents (`LODInfo->BuildSettings.bRecomputeNormals` stays `false`) — it wipes authored normals on the next DDC rebuild.
- Never reorder, weld or renumber vertices: morph deltas and skin weights are vertex-index-keyed. Adding vertex instances is safe. Guard it with a skin-weight checksum test.
- Do not create new `UMorphTarget` objects over live ones during rebuilds (async-DDC crash); reuse them.
- Material bakes need a real RHI; they die under `-nullrhi`.

## `GetVertexBoneWeights` APPENDS into the array you hand it — reuse the buffer and one vertex's weights leak into the next

`MeshBoneWeightFunctions.cpp:293-299` does `BoneWeightsOut.SetNum(Num)` and then `Add`s the real weights,
returning `2*Num` entries. Hoisting the array out of a loop makes `SetNum` truncate the previous call's
contents instead of clearing them, so the previous vertex's weights survive whenever the influence count
grows — contaminated skin weights on every rig at once; suspect the reader. `Reset()` the array before every
call, or declare it inside the loop. A rigid-cube fixture cannot catch it (constant influence count).

## GeometryScript silent-corruption traps

Each compiles clean, returns success and produces wrong geometry.

- `ApplyMeshOffset` contracts the mesh at its defaults (`SolveSteps=5, SmoothAlpha=0.1` smooths); for a pure offset set both to 0. `+OffsetDistance` is outward.
- `RemoveSmallComponents` with `MinVolume=0` can delete the mesh: an open shell's "volume" is often negative. Use `TNumericLimits<float>::Lowest()`.
- Vertex IDs are sparse: iterate `GetNumVertexIDs` + `IsValidVertexID`, never `0..GetVertexCount-1`.
- `TransferBoneWeightsFromMesh(Source, Target)` has no outcome pin; reversed arguments compile clean.
- `PruneBoneWeights` prunes by bone identity, not by weight; there is no built-in max-influence clamp.
- `ApplyMeshMorphology` is a voxel re-mesh that destroys UVs.
- `TransferBoneWeightsFromMesh` crashes the editor on a non-compact target (`Assertion failed: Pair != nullptr [Containers/Map.h.inl:651]`): `CompactMesh` the target first, especially after `RemoveSmallComponents`. Probe `MaxVertexID()` vs `VertexCount()`; the crash can show up when an unrelated step (e.g. `ApplyMeshOffset`) is enabled.
- Cube fixtures prove only that the chain executes; run a real mesh before believing a green suite.

## The engine's automatic bind on the full Manny skeleton deforms worse than the generator's weights

**Facts.** GeometryScript `ComputeSmoothBoneWeights` takes the pose of the `USkeleton` asset, not of the mesh
(`MeshBoneWeightFunctions.cpp:640`), so it needs a temporary probe skeleton with the character's joints; it
weights every bone (root, IK, correctives) and has no bone filter. Bind on a probe without
`root`/IK/`interaction`/`center_of_mass`/correctives, rooted at `pelvis`, and judge by deformation on real
clips, not rest pose.

## Mesh import RENAMES the target skeleton's root bone after the armature node

**Symptom.** A skeletal mesh import onto an existing skeleton succeeds and the shared skeleton's root bone is renamed (`root_001`, or the armature object's name) — for every mesh on that skeleton.

**Cause.** The engine reads the top FBX node as the root bone, and Blender exports the armature object as a node; a bone with the same name arrives as a second bone.

**What to do.** Name the armature object exactly as the target root bone (`root`) and build no bone of that
name; the top bones are the root's children (`pelvis`, `ik_foot_root`, `ik_hand_root`, …). Free the name
first so Blender does not write `root.001`. Read the bone list back after import, on this mesh and on another
mesh of the same skeleton. The change lives in memory until something saves the skeleton.

## A skeleton fitted only by joint positions explodes on the first clip

**Fact.** A clip stores each bone's rotation in that bone's local axes; bones rebuilt from head/tail points
get frames ~90° off the target's on every bone, which rest pose cannot show. Take each bone's frame from the
target skeleton and rotate it, or bind the mesh directly to the target skeleton; check residual roll against
the target after axis alignment.

## A skeleton offset from its mesh looks correct at rest

**Fact.** Rest pose reproduces at any offset, so it cannot show a skeleton standing a metre below its mesh.
Check every matched joint lies inside the bounds of the geometry it drives, against data the fitting script
did not write (e.g. a 185 cm character's head joint at 52 cm).

## A character from Blender arrives with its root bone at scale 100

**Symptom.** The mesh stands correctly at rest and plays some clips, but vanishes entirely on others; component-space bone readback shows nothing wrong.

**Cause.** Blender works in metres and the unit conversion lands as scale 100 on the armature object, which
is the root bone in FBX; the engine importer does the same on its side. Bones whose translation the clip
carries as-is (IK bones in `Animation` translation-retargeting mode) end up a hundred times too far.

**What to do.** Read the mesh's reference pose locally: `unreal.SkeletonModifier` on the mesh,
`get_bone_transform("root", False)` — scale must be 1. Export in centimetres (data ×100, scene unit 0.01)
and re-read the written FBX to check the armature object's scale.

## Fitting a generated mesh onto a skeleton — facts

- An image-to-3D generator returns 390–440 thousand triangles for one small item; decimate before baking weights.
- Mirroring through a negative scale turns triangles inside out; flip the normals on the geometry.
- The input must be authored in the skeleton's reference pose; a pose difference cannot be fixed by a transform.

## Blender `pose.armature_apply()` does not move a single vertex
<!-- aka: Two silent no-ops between a generated character and our skeleton -->

**`pose.armature_apply()` does not move a single vertex.** In Blender it promotes the current pose to the rest
pose; the exported FBX is identical to its input. Identical downstream numbers across different poses are the
tell. Bake the armature modifier into the mesh first (keep a copy for the binding), then apply the pose.

## Blender exits with code 0 after an unhandled Python exception

**Symptom.** The wrapper reports success; there are no files and no report, while Blender's raw output holds a traceback followed by «Blender quit».

**Cause.** Blender prints the traceback and exits normally with code 0.

**What to do.** Judge a run by the script's own report line, not the exit code (or run the script under
`--python-exit-code 1`).

## Mosaic blocks on a baked map are overlapping UV islands

**Fact.** Smart UV Project can lay two surfaces that face the same way on top of each other, and the bake
writes both into the same texels. Separate overlaps after unwrapping and refuse to bake while any face
overlaps. A new unwrap means re-running everything downstream of the UVs (weight transfer, skeleton fit, import).

## An NPC turns to its target but does not move — the map has no SAVED navmesh

**Symptom.** In PIE an AI turns and shoots but stays put; no navigation error, at most `LogCrowdFollowing: Unable to find RecastNavMesh instance`.

**Cause.** `MoveToActor` and Mover `NavWalking` need a navmesh. `RecastNavMesh` defaults to `Static`
generation, so the game session copies the editor's navmesh; the editor spawns `RecastNavMesh-Default` on
load but lifts its `AsyncLoadLock` without a rebuild (`NavigationSystem.cpp:5997`), so a map with a
`NavMeshBoundsVolume` and no saved tiles is empty in PIE.

**What to do.** Build and save the navmesh with the map, and verify with a full path query between the AI and its target, not just the presence of tiles.

## A 90 cm doorway passes or blocks the navmesh depending on where the cells fall

**Symptom.** A path query goes through one doorway and reports `partial` at another of the same mesh, although traces show both open.

**Cause.** After the agent radius (35 cm default) is eroded from each side of a ~90 cm opening, about one
navmesh cell is left, and whether it survives depends on the grid alignment.

**What to do.** A passage the navmesh must cross needs an opening of at least 2 × agent radius plus two cells (in practice a double door), or a smaller agent radius / cell size.

## A flight of modular kit stairs collides as flat blocks a character cannot climb
<!-- aka: The SFH stair flight `SM_Bld_Stairs_01` collides as flat blocks a character cannot climb -->

**Symptom.** A flight chained from modular stair pieces looks walkable, but the pawn stops at the first piece and the navmesh does not connect the floors.

**Cause.** Kit stair pieces often carry flat-box simple collision; between one piece and the next is a ledge
(52–75 cm in the measured case) above the character's 45 cm step height.

**What to do.** Measure the ledge against `MaxStepHeight`. Set the pieces to no collision and put an invisible
ramp (a scaled cube, hidden in game) under the flight; the ramp carries both the pawn and the navmesh.

## `PCGToolset.DrawSpline` blocks forever headless — it waits for a human to draw in the viewport

**What to do.** Never call it headless. A spline for a PCG graph comes from code or an existing spline component.

## Landscape Grass Type output cannot be verified headlessly

**Fact.** Grass Type instances are generated at runtime per view from the weightmap; no package or registry query holds them, so no headless check can see them.

## A C++ OnRep never runs on the server — the listen-server host does not update

**Symptom.** Clients show the new state (health bar, door mesh, effect), the listen-server host's own view does not; in a dedicated-server test everything looks right.

**Cause.** A C++ `ReplicatedUsing` function is called only where the value is received. Only a Blueprint-declared
RepNotify is also called by the Blueprint Set node (`K2Node_VariableSet.cpp`, `PropertyHasLocalRepNotify`, UE 5.8).

**What to do.** After the server writes the value it calls the OnRep (or the shared «apply» function) itself. Test
in PIE «Play As Listen Server» with two players. Checklist: `references/review-replication.md`.

## An OnRep does not fire for the first value, or fires before `BeginPlay`

**Symptom.** A client that joins late shows the default look although the server has the right value; or an OnRep crashes on a member that `BeginPlay` sets.

**Cause.** The sender's shadow state starts from the archetype, so a value equal to the class default is never
sent, and `REPNOTIFY_OnChanged` fires only if the received value differs from the local one (`RepLayout.cpp`). For an
actor that just arrived on a client, the initial bunch's OnReps run before `PostNetInit` → `BeginPlay`
(`DataChannel.cpp`, UE 5.8).

**What to do.** Apply the current state in `BeginPlay` as well as in the OnRep; guard members the OnRep needs;
`REPNOTIFY_Always` (`DOREPLIFETIME_CONDITION_NOTIFY`) when the notify is an event.

## A Server RPC silently does nothing — «No owning connection for actor»

**Symptom.** A client calls a Server RPC on a world actor (a door, a pickup, another player's pawn) and nothing happens on the server; the client log has `LogNet: Warning: UNetDriver::ProcessRemoteFunction: No owning connection for actor … Function … will not be processed.`

**Cause.** A client can send RPCs only through actors whose `Owner` chain leads to its own PlayerController.

**What to do.** Route the request through the player's PlayerController, pawn or a component on them, or
`SetOwner` the actor to that player on the server.

## A push-model property stops replicating in one build and not another

**Symptom.** A replicated value updates in one configuration (e.g. a packaged build) and is stuck in another (PIE), or the reverse after someone flips a cvar.

**Cause.** With push model on, a property registered with `bIsPushBased = true` is compared only after
`MARK_PROPERTY_DIRTY*`; a write that skips it is never sent. In UE 5.8 `Net.IsPushModelEnabled` defaults to 0, and
`WITH_PUSH_MODEL` is compiled only into Editor targets unless the target sets `bWithPushModel = true`.

**What to do.** Make the field private and write it through one setter that marks it dirty; `rg` the module for
direct writes to every push-based property.

## A replicated property set in C++ on a dormant actor never reaches clients

**Symptom.** An actor with `NetDormancy` `DORM_Initial` / `DORM_DormantAll` changes a replicated value on the server, and clients keep the old one; the same change made from a Blueprint arrives.

**Cause.** A dormant actor is not replicated until it is flushed; the Blueprint Set node flushes dormancy
automatically for replicated properties (`K2Node_VariableSet::ShouldFlushDormancyOnSet`), C++ does not.

**What to do.** `FlushNetDormancy()` before the change, or `SetNetDormancy(DORM_Awake)` while it changes often.

## Epic's `unreal-mcp` — Experimental-server edges (UE 5.8)
<!-- aka: Epic's `unreal-mcp` (:18000) — Experimental-server edges (UE 5.8) -->

- `save_assets` silently does nothing during PIE.
- Some tools return enormous payloads (a character's properties, viewport captures); scope the query.
- The server can start with zero tools (5.8 stable regression): check the toolset plugins are enabled before suspecting your bridge.
- Bulk move/rename/delete through its tools leaks VRAM until restart; do bulk relocation in your own editor code or in batches with restarts.
- Concurrent calls are accepted: synchronous tools run one after another on the game thread, but an async tool (a `UToolCallAsyncResult`: captures, waits, test runs) returns at once and finishes later, so it overlaps later calls and answers may arrive out of request order. Send dependent calls and changes to one asset one by one; two clients writing one asset are not stopped by the server (`unreal-editor`, `epic-mcp-toolsets.md` §Edges).

## StringTable: `set_entry` writes to memory but does not dirty the package — the string is lost silently

**Symptom.** `StringTableTools.set_entry` works, `get_entry` reads the new value, `save_assets` returns `true` — and the `.uasset` on disk is unchanged.

**Cause.** `set_entry` does not set the dirty flag, so `save_assets` has nothing to save; `is_dirty` right after returns `false`.

**What to do.** Dirty the package separately (e.g. `AssetTools.update_metadata_tags`), then `save_assets`; confirm with `git status` on the asset path.

## StringTable: `import_file` over an existing asset DELETES it from disk

**Symptom.** `StringTableTools.import_file` onto an existing name answers `already exists` / `Failed to import`, and the `.uasset` is gone.

**What to do.** Call `import_file` only for a name not in the folder; extend an existing table with
`set_entry` + forced dirtying. After any refused import check `git status` on the destination and `git checkout -- <path>`.

## Scaling an actor with `set_actor_transform` teleports it to the origin

**Fact.** `ActorTools.set_actor_transform` writes the whole transform: pass `scale` alone and the actor takes
the default location and rotation with it. Send the actor's current location and rotation in the same call.

## `.cmd` pwsh fallback idiom `where pwsh && (pwsh …) || (powershell …)` re-runs on failure

**Fact.** `||` also fires when the pwsh script fails, so Windows PowerShell 5.1 runs it a second time (and
mis-decodes non-BOM UTF-8). Use `where pwsh >nul 2>&1` + `if errorlevel 1 ( powershell … ) else ( pwsh … )` + `exit /b %errorlevel%`.

## Importing a script to check it RUNS it, and the build-family scripts stop the editor first

**Symptom.** A syntax check written as `node -e "import('./x.mjs')"` hangs or does real work (a build script stops the editor).

**Cause.** A CLI script with no entry guard does its work at module top level, so importing it executes it.

**What to do.** `node --check <file>` parses and never executes — that is the syntax check. When a module must
also be importable, give it an entry guard
(`if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/')))`).

## One shared git index — `git commit` and `git stash` take other windows' work

**Facts.**

- All sessions in one working copy share one git index; plain `git commit` commits everything staged, including another window's. Commit by pathspec — files, not directories.
- A pathspec bounds files, not whose edits are in them: a shared file can carry a neighbour's uncommitted lines. `git diff --stat -- <file>` before, `git show --stat` after.
- `git stash` takes every dirty tracked file, not yours. `git stash push -- <path>` with nothing to stash creates no entry, so the next `pop` applies whatever old stash is on top. Read `git show HEAD:<path>` instead of stashing to see a baseline. Recovery after a bad pop: `git restore --source=HEAD --staged --worktree -- <paths>`, leave the entry.

## A secret (API key) in a gitignored repo file still reaches the external analysts

**Fact.** Gitignore stops a commit, not a read: any external agent CLI given the repository as its working or
added directory reads the whole tree, `.claude/settings.local.json` included. A secret lives only in a user
environment variable (`[Environment]::SetEnvironmentVariable('<NAME>','<key>','User')`, then restart the harness).

## A User-level `PATHEXT` replaces the Machine value — it does not merge

**Symptom.** Every new terminal fails to launch anything by name («is not recognized»); running shells keep working.

**Cause.** A User `PATHEXT` overrides the Machine value outright (only `PATH`-style variables merge); `";.PS1"` from an empty User value left only `.PS1`.

**What to do.** Seed a User-scope value from the Machine value:
`[Environment]::SetEnvironmentVariable('PATHEXT', "$([Environment]::GetEnvironmentVariable('PATHEXT','Machine'));.PS1", 'User')`.

## The pwsh `$PROFILE` must print nothing, or scp/sftp break

**Fact.** Output at profile load corrupts the SFTP stream (prompt tools such as `starship init` or completion
loaders that print). Put printing code behind an interactivity guard or inside `function prompt`.

## A git hook exports GIT_DIR/GIT_INDEX_FILE — anything it launches writes into your index

**Symptom.** A hook's gates pass, then git dies with `invalid object … for 'f.txt'` / `Error building trees` for a file that is not in the repo.

**What to do.** Launch anything that shells out to git from a hook with
`env -u GIT_DIR -u GIT_INDEX_FILE -u GIT_WORK_TREE -u GIT_PREFIX -u GIT_OBJECT_DIRECTORY <cmd>`; `cd` does not
protect you. Recovery: `git rm --cached <phantom>`.

## Shell edits mangle text — Git Bash path arguments, heredoc escapes, python text-mode CRLF

**Symptoms and causes.**

- **Git Bash rewrites path-shaped arguments.** `sed -i 's|E:\Foo|D:\Bar|g'` reports success and changes nothing; the same hits `rg`/`grep` patterns, so a «clean» grep for a Windows path under Git Bash proves nothing.
- **The Bash tool strips one level of backslash escaping**, a quoted heredoc included: a doubled backslash arrives single, and `'\n'` inside a JS string or `/\r?\n/` in a regex arrives as a real newline. An ES module with one syntax error runs nothing.
- **Python text mode on Windows writes CRLF for the whole file** (`io.open(p,'w')`); regexes ending in `(.*)$` then miss. Git normalises on commit, so only the working copy is damaged.

**What to do.** Write source with the Edit/Write tools; for a replace involving a Windows path use PowerShell
(`(Get-Content -Raw).Replace(...)`) and verify with `Select-String -SimpleMatch`. Write repository files from
python in binary mode (`io.open(p,'wb').write(s.encode('utf-8'))`). Give every parseable artifact a parse gate
(`node --input-type=module --check < file`).

## A PreToolUse hook answering `permissionDecision: "allow"` on AskUserQuestion kills the question card

**Symptom.** Every rewritten `AskUserQuestion` returns «The user did not answer the questions» in under a second; the user sees no card.

**Cause.** The card is rendered by the permission component; `allow` resolves it without showing.

**What to do.** To rewrite the input and keep the card, emit `"ask"` + `updatedInput`. Test a hook's rewrite path against a live card, not only the pass-through path.

## A deferred MCP tool's params go DIRECTLY, not wrapped in `args`

**Symptom.** An MCP tool fails with a misleading error for a valid call (a required field «empty» or «not found: /»).

**Cause.** The params were wrapped in `{"args": {…}}`. Only tools whose schema declares an `args` parameter take that envelope; the wrapper delivers an empty argument object to the rest.

**What to do.** Pass each deferred tool's parameters by their exact schema names at the top level. `*Json` params usually accept a native JSON array/object.

## A Scheduled Task at an hour the machine is off never runs

**Facts.** `schtasks /Create` defaults to `StartWhenAvailable: False`, so a missed run is dropped
(`LastTaskResult` `0x800710E0`). The Task Scheduler operational log is disabled by default, so a task that
never ran leaves no events. Check power history (`Microsoft-Windows-Kernel-General` ids 12/13) before scheduling.

## `rg` skips dot-directories unless you pass `--hidden` — a repo-wide search silently reports «clean»

**Symptom.** A repo-wide `rg` returns a plausible short list with `.claude/` (rules, skills, scripts) missing — it is a dot-directory.

**What to do.** Any repo-wide shell `rg` sweep passes `--hidden` (the `Grep` tool is not affected). `git check-ignore -v`
can print a match for a path that is not ignored the way you assume; confirm with `git status --untracked-files=all`.

## `${0%/*}` breaks on a backslash path

**Fact.** `${0%/*}` returns the whole path when a hook is invoked as `.claude\scripts\hooks\x.sh`; locate
siblings from `$CLAUDE_PROJECT_DIR/...`. A helper that fails to load falls back to a slow correct path, never to `exit 0`.

## jq.exe emits CRLF — splitting a multi-line jq result leaves `\r` on every field but the last

**Symptom.** Prefix comparisons work, exact string equality never matches.

**Cause.** `$(jq -r '.one')` strips the trailing newline and its `\r`; a multi-value read split by hand keeps the `\r` between values.

**What to do.** `both=${both//$'\r'/}` right after any multi-value jq read on Windows.

## `compile.cmd | tail` reports the pipe's exit code, and a red build reads as green

**Symptom.** A background build reports «exit code 0» over output that says `Result: Failed`.

**Cause.** `a | b` returns `b`'s status; `tail` always exits 0.

**What to do.** Redirect to a file and read `$?`, or have the build script print one final `RESULT: … (exit N)` line and read that.

## A `commit.cmd` killed by a tool timeout leaves `.git/index.lock`

**Fact.** A commit whose pre-commit hooks run past the tool timeout (2 minutes by default) is killed and leaves
`.git/index.lock`; every later git write fails. Give long commits a long timeout. Remove the lock only after
confirming no git process is still writing the index.

## A `.gitattributes` carve-out written `-diff` marks the file binary

**Fact.** The working form for a text file excluded from LFS is `-filter -merge diff text eol=lf` (`diff` set). Verify with a real `git diff` on a changed covered file.

## A pipe inside an argument to a `.cmd` shim is eaten by `cmd.exe`, not passed to the program

**Symptom.** A regex alternation passed to a shim (`foo.cmd "wolf|dog"`) dies with «`dog` is not recognized as an internal or external command».

**Cause.** `cmd.exe` parses `|`, `&`, `<`, `>`, `^` and `%VAR%` before the program sees argv; quotes do not stop `%` expansion.

**What to do.**

- For an argument with shell metacharacters, call the underlying program directly (`node <script>.mjs …`).
- A newline in an argument fails silently: `cmd.exe` keeps the first line and the command succeeds on truncated text. Multi-line free text goes through a file (`git commit -F`).

## A `.cmd` shim dies at ~8191 characters of arguments, and the message names nothing

**Symptom.** A shim called with hundreds of paths answers `The command line is too long.`; nothing ran.

**Cause.** `cmd.exe` caps a command line at 8191 characters; every shim forwards `%*`.

**What to do.** For more than a few dozen paths call the program directly (32767-char limit) and feed long
pathspecs to git on stdin (`--pathspec-from-file=-`).

## A SessionStart hook blocks the session's first turn

**Fact.** A SessionStart hook delays the first turn until it returns, so per-file work in a hook is paid as
dead time (a subshell per path costs ~43 ms on Windows; thousands of dirty paths make minutes). Do file work
in one pass (one `stat`, one `awk`) and time the hook against the largest working copy.

## `powershell -WindowStyle Hidden` is a visible window here, and closing it kills its child

**Symptom.** A background server started under `powershell.exe -WindowStyle Hidden` dies hours later with `signal=SIGHUP`, exit code 0.

**Cause.** When Windows Terminal is the default terminal it takes the console before PowerShell can hide it;
closing the empty window sends CTRL_CLOSE (Node reports `SIGHUP`) to its processes.

**What to do.** Start a background process hidden through `wscript` (`Run ..., 0`) or detached
(`spawn(..., { detached: true })`). A console child a background node process spawns (git included) carries
`windowsHide: true`, or it flashes a window on every call.

## A private submodule over HTTPS does not clone without a credential, and a submodule clone ignores the project's `insteadOf`

**Symptom.** `git submodule update --init <path>` dies with `could not read Username for 'https://github.com': terminal prompts disabled`, or leaves an empty directory with every file staged as deleted (the LFS smudge failed).

**Cause.** A `url.<ssh>.insteadOf` in the superproject's `.git/config` does not reach the new submodule repository.

**What to do.** `git -c "url.git@github.com:<org>/<repo>.git.insteadOf=https://github.com/<org>/<repo>.git" submodule update --init <path>`,
then `git -C <path> remote set-url origin git@github.com:<org>/<repo>.git` and `git -C <path> lfs pull`.

## A project file tracked INSIDE a submodule's directory silently empties `git ls-files --recurse-submodules`

**Symptom.** Tools built on `git ls-files --recurse-submodules` suddenly miss every file of a submodule (dead links reported, gates go quiet).

**Cause.** The superproject index carries entries under the submodule's mount point (a `git mv` from the project into it does it), and git stops recursing into that submodule.

**What to do.** Nothing under a submodule's mount point belongs to the superproject index: `mv` the file,
`git rm --cached` it from the project, `git -C <submodule> add` it there. Pathspec `git rm --cached` at the
files — `git rm -r --cached <mount>/<dir>` also drops the gitlink (`git reset HEAD -- <mount>` restores it).

## A Cyrillic homoglyph in an editor LABEL matches nothing and looks perfectly correct

**Symptom.** A lookup by actor label, tag, socket or parameter name fails on a name that reads right.

**Cause.** One character was typed on a Russian layout: `с`→`c`, `о`→`o`, `е`→`e`, `а`→`a`, `р`→`p` (also `у`, `х`, `к`, `м`, `т`, `в`) are pixel-identical twins.

**What to do.** Identifiers that code matches on are ASCII. Dump codepoints when a visibly right name fails:
`[...s].map(c => c.codePointAt(0) > 127 ? 'U+' + c.codePointAt(0).toString(16) : c).join('')`.
