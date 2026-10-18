# ue-content-gates

Offline content checks for Unreal Engine 5.x: everything is read from files on disk, the editor is
not started. Works in any project.

## Contents

Paths are relative to the skill folder `skills/ue-content-gates/`; `.claude-plugin/`, `hooks/hooks.json`, `bin/`, `agents/` sit at the plugin root.

| Path | What |
| --- | --- |
| `SKILL.md` | what to call when, rules for reading results |
| `references/package-format.md` | the 5.8 package header format, what is read from it |
| `references/config.md` | `.claude/content-gates.json`: ref-lint rules and cook-check roots |
| `references/cook-check.md` | what is compared, how to read the report, exit codes |
| `scripts/py/uasset.py` | library: summary, name table, imports, soft references, game/editor flags, asset registry block |
| `scripts/package-names.cmd` → `py/package_names.py` | names / `--info` / `--parents` / `--deps` |
| `scripts/find-asset-refs.cmd` → `py/find_asset_refs.py` | C++ symbol → assets, `--rename-to` prints CoreRedirects |
| `scripts/ref-lint.cmd` → `py/ref_lint.py` | forbidden reference prefixes from the config |
| `scripts/asset-path-lint.cmd` → `mjs/asset-path-lint.mjs` | `/Game/` paths and `ConstructorHelpers` in shipping modules |
| `scripts/asset-name-lint.cmd` → `mjs/asset-name-lint.mjs` | asset name prefixes by class, characters, placement; `.claude/asset-names.json` overrides |
| `scripts/mjs/uasset.mjs` | the header reader for the node scripts (a port of the part of `py/uasset.py` they need) |
| `scripts/cook-check.cmd` → `mjs/cook-check.mjs` | expected closure against the last cook |
| `scripts/py/offline_closure.py` | dependency closure from headers, no editor |
| `scripts/py/cook-closure.py` | the same through the asset registry inside the editor (`--editor-closure`) |
| `scripts/mjs/ue-engine.mjs` | engine lookup (the same file as in code-analysis) |

Notes:
- `ref-lint` judges by the real dependency tables (imports + soft references, with the
  game/editor-only flag), not by grepping bytes; an unreadable package is a failure.
- `cook-check` is fully offline by default (closure from headers, the cook from disk); with no cook
  on disk it answers "cannot tell" (exit 2), warns about a cook older than the content; it also takes roots
  from `MapsToCook` / `DirectoriesToAlwaysCook`.
- `asset-name-lint` judges the class read from the header, climbing the engine parent map, the project's
  C++ headers and Blueprint parents, so a `UPrimaryDataAsset` subclass is checked as DA_. Default table:
  Allar/Epic style (AS_ anims, S_/SC_ sounds, L_ maps); a class it does not know is info, not a problem.
- The deliberate-path marker in `asset-path-lint` — `// asset-path-ok: <why>`.
- Every package-path argument repairs Git Bash mangling (`/Game/X` → `C:/Program Files/Git/Game/X`).

## Installation

A plugin of the `ue-skills` marketplace (how to add the marketplace — the root `README.md`). From the project folder:

```
claude plugin install ue-content-gates@ue-skills --scope local   :: this project only; the project repository is not changed
claude plugin install ue-content-gates@ue-skills                 :: all projects on the machine
```

Disable — `/plugin` → Installed (space), or `claude plugin disable ue-content-gates@ue-skills`. After installing —
`/reload-plugins` or a new session. `<skill>` paths — the plugin's `skills/ue-content-gates/` folder.

Installs `ue-workstation` as a dependency (the `editor-guard` hook: cook-check raises the editor). The
`find-asset-refs` and `asset-name-lint` commands are on the Bash tool's PATH. Needs `python` 3 (stdlib only; `PYTHON=<exe>` if not on PATH)
and `node` 18+. The engine for cook-check is found as in code-analysis: `UNREAL_HOME` → `UE_VERSION` /
`EngineAssociation` → the Epic registry.

Pre-commit (optional, in the project's `.git/hooks/pre-commit` — not committed):

```
<skill>\scripts\asset-path-lint.cmd --staged || exit 1
<skill>\scripts\ref-lint.cmd <staged .uasset/.umap> || exit 1
<skill>\scripts\asset-name-lint.cmd --changed HEAD || exit 1
```
