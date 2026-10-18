---
name: ue-content-gates
description: >
  Offline Unreal content checks without the editor: read a .uasset/.umap header (name
  table, asset class, Blueprint parent, hard/soft and game/editor-only dependencies), find
  the assets that use a C++ symbol — "who uses this class in content", "can I delete/rename
  this class", "find Blueprints on this class"; forbid references to sandbox folders and
  foreign content — "check references to Developers", "engine content in levels"; hard-coded
  /Game/ paths in C++ — "asset paths in code"; asset names and folders against a prefix
  convention — "naming conventions", "asset naming", "check asset prefixes"; compare the
  expected with the cooked — "check the cook", "what did not make it into the build", "asset
  missing in the build". Russian: «кто использует этот класс в контенте», «можно ли
  удалить/переименовать класс», «проверь ссылки на Developers», «пути к ассетам в коде»,
  «проверь имена ассетов», «нейминг ассетов», «проверь кук», «ассет пропал в сборке».
---

# ue-content-gates — content checks without the editor

Every check reads files from disk: no editor is needed, they work
with the editor open or closed. Paths are relative to the skill folder (`<skill>`). The project is
the nearest `.uproject` up from the current folder (or `CLAUDE_PROJECT_DIR`), so
run from the project root. Needs `python` (3.x, stdlib only) and `node` 18+.
From Git Bash a `/Game/X` path argument gets mangled into `C:/Program Files/Git/Game/X` —
the scripts undo this themselves, but for `rg`/other programs set `MSYS_NO_PATHCONV=1`.

| Question | Command |
| --- | --- |
| What is inside a package: class, parent, names, references | `<skill>/scripts/package-names.cmd --info\|--deps [--game]\|--parents <file or /Game/...>` |
| Which assets use a C++ symbol | `<skill>/scripts/find-asset-refs.cmd AMyActor\|FMyRow\|UMyComp::Speed\|/Script/MyModule [--rename-to New]` |
| Are there forbidden references (sandbox, quarantine, engine in levels) | `<skill>/scripts/ref-lint.cmd [packages]` or `--forbid <prefix> [--allow ..] [--maps-only]` |
| Are there asset paths in C++ that ships | `<skill>/scripts/asset-path-lint.cmd --all \| --staged \| <files>` |
| Do asset names follow the prefix convention (SM_, T_, BP_ ...) | `<skill>/scripts/asset-name-lint.cmd [--changed [ref]] [--json] [<files or folders>]` |
| Did everything needed make it into the last cook | `<skill>/scripts/cook-check.cmd [--map /Game/Maps/X] [--asset ..]` |

Every script understands `--selftest`; exit code 0 — clean, 1 — findings, 2 — the check could not
answer (this is NOT "clean").

## Rules

- **C++ symbol → assets** — only `find-asset-refs`, not `rg`. A package stores `AMyActor`
  as `MyActor` (no A/U/F prefix; the `E` of an enum stays), and `rg` without `-a` drops the file at
  the first NUL byte and silently finds nothing. A `name` hit is a candidate (open and check),
  `import`/`parent` — real usage. Zero hits for the type plus zero in a source
  search — then the code is dead. Renaming — with `--rename-to`: the script prints
  `[CoreRedirects]` lines for `Config/DefaultEngine.ini`; without them assets stop loading.
- **Blueprint parent** — the `NativeParentClass` tag (and `ParentClass` for a BP parent), not
  the import table: there a cast and inheritance look the same.
- **ref-lint** reads rules from `<project>/.claude/content-gates.json` (`forbiddenRefs`);
  without the file — one default: `/Game/Developers/`. Format and examples — `references/config.md`.
  An unreadable package is a failure, not a skip.
- **asset-path-lint** works out which modules ship (by `Type` in `.uproject` /
  `.uplugin`); editor modules and tests are outside the check. To keep a path deliberately — a comment
  `// asset-path-ok: <why>` on the line or above it. For pre-commit — `--staged`
  (judges only added lines).
- **asset-name-lint** takes each asset's class from the header (main asset of the registry block), climbs
  its ancestry (engine parent map, the project's own C++ headers, Blueprint parents read from their
  packages) and checks the name prefix by the first class the table names: a project `UPrimaryDataAsset`
  subclass is judged as `DataAsset` (DA_), a Blueprint on `UGameplayEffect` as `Blueprint:GameplayEffect` (GE_).
  Also flags spaces / non-ASCII (Cyrillic look-alikes) anywhere in the path. Defaults are Allar/Epic style
  with AS_ for anims, S_/SC_ for sounds, L_ for maps; the project overrides them in
  `<project>/.claude/asset-names.json` (`prefixes` with arrays or `null`, `ignore`, `exceptions`,
  `placement`) — format in the script head, `--print-config` shows the table in force. An unknown class is
  INFO, not a problem. For a gate on a diff — `--changed <ref>` (changed + untracked packages).
- **cook-check** is offline by default: the dependency closure is read from package headers,
  the cooked set — from `Saved/Cooked/<Platform>/<Project>/Metadata/ReferencedSet.txt`. No
  cook — it says so and exits with 2. The warning "N packages newer than the cook" means:
  MISSING is noise, a fresh cook is needed. `--cook` and `--editor-closure` start
  `UnrealEditor-Cmd` (a cook or Python in the editor) — only after agreement: the script
  refuses while an editor of this project is open, an editor of another project not raised by this
  session, or someone else's build is running (`ue-owner.mjs`). Details and
  reading the report — `references/cook-check.md`.
- The UE 5.8 package format and what is read from it — `references/package-format.md`.
