# Refactoring, renaming, removing

A refactor keeps behaviour: dedup, extraction, unification, moving code between modules. A behaviour change
mixed into a refactor is reported as such.

## Impact before the change

1. **C++ users** — `rg -n "\bSymbol\b" Source Plugins` (or the clangd `LSP` when the project allows it; on a
   UE-sized tree its background index costs tens of GB, so it is opt-in).
2. **Content users** — Blueprints, data assets, maps and widgets reference reflected C++ symbols by name, and
   nothing in the C++ build tells you.
   - With the ue-content-gates plugin enabled: `find-asset-refs <Symbol>` in Bash (the plugin's command) — lists every
     `.uasset`/`.umap` whose name table names it, with how (`parent`, `import`, `name`).
   - Without it: `rg -la --glob "*.uasset" --glob "*.umap" "<NameWithoutPrefix>" Content Plugins`. Two traps:
     a package stores `AMyActor` as `MyActor` (the A/U/F prefix is dropped; `E` stays on enums), and `rg`
     without `-a` treats a package as binary and silently reports nothing. From Git Bash a pattern starting
     with `/` (`/Script/MyModule`) is rewritten into a Windows path — set `MSYS_NO_PATHCONV=1`.
   - The editor's Reference Viewer / `WhoReferences`-style tools answer for assets, never for a C++ symbol.
3. **Config** — `rg -n "Symbol" Config` (class paths in `DefaultGame.ini` / `DefaultEngine.ini`, settings
   sections `[/Script/MyModule.MySettings]`).

## Renaming a reflected symbol

Existing assets keep the old name serialized; without a redirect they fail to load the class / lose the
property value. Add to `Config/DefaultEngine.ini`:

```ini
[CoreRedirects]
+ClassRedirects=(OldName="/Script/MyModule.OldActor",NewName="/Script/MyModule.NewActor")
+StructRedirects=(OldName="/Script/MyModule.OldRow",NewName="/Script/MyModule.NewRow")
+EnumRedirects=(OldName="/Script/MyModule.EOldMode",NewName="/Script/MyModule.ENewMode")
+PropertyRedirects=(OldName="MyActor.OldSpeed",NewName="MyActor.NewSpeed")
+FunctionRedirects=(OldName="MyActor.OldFire",NewName="MyActor.NewFire")
+PackageRedirects=(OldName="/Script/OldModule",NewName="/Script/NewModule")
```

Class/struct names in redirects are WITHOUT the C++ prefix. `find-asset-refs.cmd <Symbol> --rename-to <New>`
prints the matching line. A module rename needs one `PackageRedirects` line per renamed module (the editor
sibling `…Editor` too) and touches every asset whose classes come from it.

After the rename: open and resave the affected assets (or run the ResavePackages commandlet) so they store
the new name, and keep the redirect until every branch and user has resaved.

## Removing

Dead code is deleted only when BOTH sweeps find zero users: the C++ search and the content search. A
Blueprint that subclasses or calls a C++ class breaks on load, not at compile time.

## Moving between modules

- A type moved to another module changes its `/Script/<Module>` path: same redirect story as a rename.
- The new home's `Build.cs` gains the dependency; the old dependents gain the new module; a public header
  that exposes the type needs a `Public` dependency.
- Prefer a broad-change full build without unity (`-DisableUnity`) after include moves: unity builds hide
  missing includes.
