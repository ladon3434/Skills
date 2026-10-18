# Writing an editor tool plugin (MCP tools, editor utilities, commandlets)

Rules for code that changes content when an agent or a person calls it. Generic: the names below are
placeholders, adapt them to the project's tool framework.

## Declare the contract of every mutating tool

Write it where the caller sees it (the tool's description / schema, a `meta` on the `UFUNCTION`, a doc
comment the schema generator emits). Four facts:

- **Effect** — `read` (writes nothing) · `create` (writes only paths that did not exist) · `update` (overwrites
  with content the tools can author again) · `destroy` (removes, or overwrites irreproducibly).
- **Re-run** — what a second identical call does: `idempotent` (same end state, no error) · `refuses`
  (changes nothing, answers an error) · `accumulates` (changes the content again — say so loudly).
- **Undo** — `transaction` (an editor transaction around the call; only for a tool that does not save — a
  cancelled transaction does not remove a package already written to disk) · `rerun` with the previous values
  (only for idempotent tools) · `inverse:<OtherTool>` (must exist) · `none: <reason>`.
- **Verified by** — the read tool that checks the result, or `none: <what answers for the result instead>`.
  A verify is warranted only where a call can report success and still be wrong.

Avoid the bare word "idempotent" in free-text descriptions; state the re-run behaviour as above.

## Destructive tools take a dry run

Every `destroy` tool takes `bool bDryRun = false`. With `bDryRun = true` it runs every check, returns a plan
(`PLAN: would delete X, Y; would rewrite Z`) and writes nothing.

## Clean up on failure

A tool that creates several assets and can fail between them uses a scope object that deletes what the call
created unless committed:

```cpp
FCreatedAssetsScope Cleanup;            // deletes registered assets in its destructor
UObject* A = CreateA(...); if (!A) return Error(...);
Cleanup.Add(A);                         // only what THIS call created: check existence before the create
UObject* B = CreateB(...); if (!B) return Error(...);   // A is deleted on return
Cleanup.Add(B);
Cleanup.Commit();                       // success: keep everything
```

Record only assets the call itself created — an asset that already existed is never deleted by the cleanup.

## Verify checks the world, never its own arguments

A verify tool reads the result back from the editor state and compares it with what the request needed: a
road's height against the terrain under it, a layer's weight against the material, a mesh slot against the
asset on disk. Re-reading the arguments it was given proves nothing.

## Arguments: never discard a reader's verdict

Tools usually receive arguments as strings/JSON and convert them with readers that return success and write
through an out-parameter. A bare `ParseVector(Json, Location);` leaves `Location` at its initialiser on bad
input, the tool reports success, and a shape-only verify passes. Branch on the verdict and return an error
that names the argument.

`<skill>/scripts/discarded-verdict-lint.cmd` finds the discards:
- readers are derived from declarations in the judged tree (returns `bool`/`FString`, has a non-const `T&`
  or `T**` parameter) plus `ImportText_Direct`;
- aim it at the tool trees: `--all --root Plugins/MyTools/Source [--with Plugins/MyToolCore/Source]` — on
  gameplay code the same signature shape (`ModifyCamera(float, FMinimalViewInfo&)`) is not a verdict and the
  output is noisy;
- a deliberate discard is marked `// verdict-ok: <why>` (or the project's marker via `--marker DEVIATION:`).
For new readers prefer `[[nodiscard]]` on the declaration — then the compiler enforces it.

## Silent-success setters

Several editor APIs report success and change nothing on a mismatch (struct properties set through generic
property paths, some Niagara setters, `set_editor_property` on a non-editable field). A tool built on them
reads the value back after setting it and errors when it did not take.

## New reflected surface needs a restart

A new or changed `UFUNCTION` exposed to Python/MCP/Blueprint is registered at module load: after adding one,
restart the editor (a Live Coding patch does not re-register reflected surface). A Python toolset is the exception:
`toolset_registry.reload_module(<package>)` swaps its code in the running editor.

## Toolset Registry tools (Epic's `unreal-mcp`)

A toolset is a `UToolsetDefinition` class of static, AI-callable functions that Epic's MCP server lists and
dispatches (`list_toolsets` / `describe_toolset` / `call_tool`). Mechanics — registration, Python and C++
skeletons, async results, reload, tests — are in `unreal-editor`, `references/epic-mcp-toolsets.md` §Extending.
Adapted from Epic's `create-toolset` skill (MIT, `EpicGames/unreal-engine-skills-for-claude-code-plugin`).

**Before writing**, in order:
1. Does it exist? `describe_toolset` the candidates (or search `Toolsets/` folders: C++ headers, Python files).
   If it is there, point to it — nothing to write.
2. Is it more general than it sounds? "Read Blueprint asset metadata" is asset metadata — `AssetTools`, not
   `BlueprintTools`. Solve the general case.
3. A toolset of that domain exists → add to it. A new one goes into the closest related plugin; a distinct domain
   may warrant its own plugin — ask when it is not obvious.
4. Python or C++ is the person's call; bring them the facts. Python iterates faster (reload, no build): search the
   stubs (`Intermediate/PythonStub/unreal.py`, Developer Mode on) for every API the tools need. Thin coverage →
   C++. Neither language has the API → stop and say so; a workaround makes a tool that breaks silently.

**Design**:
- Clean: the simplest API that does useful work, not a mirror of Unreal's; a technical artist should understand it
  without reading the implementation.
- Complete: CRUD symmetry — what can be set can be read, what can be created can be deleted (a getter alone is fine
  when mutation makes no sense).
- Composable: one type per kind of thing across the toolset (`get_graph()` returns a `Graph`, `get_graph_nodes()`
  takes it).
- No duplication inside or across toolsets: generic UObject property get/set is `ObjectTools` already.
- Real types for parameters and returns (`int32`, `FVector`, `TArray<FString>`, a struct): the registry serialises
  them. A JSON string inside a tool is a smell — a string means text. A custom `FToolsetJsonConverter` only when a
  type's default schema is clearly bad (the stock ones unify colours, turn object references into typed soft paths,
  make transform parts optional) — read an existing converter first.
- **Returns carry data, never status.** Success = a normal return; failure = raise (`raise ValueError(...)` in
  Python; `UKismetSystemLibrary::RaiseScriptError(...)` and return a default in C++). The caller gets
  `isError: true` with the message. Never a bool, an error string or a result wrapper. (Several stock 5.8 tools
  break this rule — `returnValue: false` refusals, `CompileLiveCoding`'s `Error: ...` strings — which is why callers
  must read every answer; new tools should not add to it.) Async tools report through `SetError` on their result.
- All tools static, no instance state.

**Documentation** — the toolset's 1–3 sentences must stand alone (an agent often sees nothing else); every tool,
parameter and return documented. Test each line: could a competent reader infer it from the signature, names and
types? Then cut it — no restated types or defaults, no "pass this to that" narration, no obvious examples, no
rationale of the implementation. Keep units, ranges, odd encodings ("one space-separated string"), what an empty
result means. `ClampMin`/`ClampMax` metadata reaches the schema by itself. The contract of a mutating tool
(Effect / Re-run / Undo / Verified by, above) is exactly the non-inferable kind — keep it, one line.

**Tests** — one for the success path and one per raise path. C++: `BEGIN_DEFINE_SPEC(F<X>Spec, "AI.<Toolset>",
EditorContext | ProductFilter)`, `AddExpectedError` for each raise. Python: `ToolCallTestCase`,
`with self.assertToolRaisesRuntimeError():`. Live: compile (Live Coding for bodies, `ue-build-test` otherwise), then
`AutomationTestToolset` `DiscoverTests` (required first; `force_rediscover` after a Python reload) → `ListTests` →
`RunTests` → `GetTestResults`. Headless: `UnrealEditor-Cmd <uproject> -ExecCmds="Automation RunTests AI.<Toolset>;quit"
-Unattended -NullRHI` (`ue-build-test` runs this for you).

**Before handing off**, read the toolset whole: shared boilerplate worth a helper, a raise path without a test,
a tool that duplicates another, parameter names or types out of line with the rest, docs that restate the code.
