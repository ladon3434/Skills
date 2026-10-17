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
restart the editor (a Live Coding patch does not re-register reflected surface).
