# ue-cpp-authoring

Knowledge for writing C++ for Unreal Engine 5.x: validation, asset slots, modules and
editor-only, UHT, widgets and CommonUI, logs, refactoring with CoreRedirects, the contract of
editor tools. Not tied to any particular project.

## Contents

Paths are relative to the skill folder `skills/ue-cpp-authoring/`; `.claude-plugin/`, `hooks/hooks.json`, `bin/`, `agents/` sit at the plugin root.

| Path | What |
| --- | --- |
| `SKILL.md` | rules before code, validation, assets, modules, UHT, style, "done" |
| `rules/ue-cpp.md` + `hooks/cpp-rule.mjs` | rule for `Source/**`, `Plugins/**/Source/**`: short always-needed facts; the hook feeds it into context on first touch |
| `references/ui-widgets.md` | C++/WBP split, `BindWidget` + `check()`, CommonUI input |
| `references/logging.md` | template: category per module / per class, diagnostics behind a CVar, `LogTemp` cleanup |
| `references/assertions-threading-uht.md` | `check`/`ensure`/`verify` per configuration, threads, weak captures, UHT and linking, unused BP API, engine change in `*.Target.cs` |
| `references/subsystems-data.md` | managers as subsystems, data assets, `IsDataValid` vs `UEditorValidatorBase` |
| `references/bp-to-cpp.md` | new class skeleton, porting Blueprint logic to C++ |
| `references/refactoring.md` | impact analysis in C++ and content, CoreRedirects, deletion, moving between modules |
| `references/editor-tool-plugins.md` | contract of a mutating tool: effect/repeat/rollback, dry-run, cleanup, verify against the world; Toolset Registry tools for Epic's `unreal-mcp` (design, docs, errors, tests; adapted from Epic's `create-toolset`, MIT) |
| `references/house-style.md` | taste rules — only if the project has none of its own |
| `scripts/discarded-verdict-lint.cmd` → `mjs/discarded-verdict-lint.mjs` | discarded reader result (`ParseX(Json, Out);`) |

Links to other plugins are soft, no imports: engine signatures — `engine-api` (code-analysis),
C++ symbol → assets (`find-asset-refs`) and `asset-path-lint` — `ue-content-gates`. Without these skills the text
names a fallback (`rg`).

## Installation

A plugin of the `ue-skills` marketplace (how to add the marketplace — the root `README.md`). From the project folder:

```
claude plugin install ue-cpp-authoring@ue-skills --scope local   :: this project only; the project repository is not changed
claude plugin install ue-cpp-authoring@ue-skills                 :: all projects on the machine
```

Disable — `/plugin` → Installed (space), or `claude plugin disable ue-cpp-authoring@ue-skills`. After installing —
`/reload-plugins` or a new session. `<skill>` paths — the plugin's `skills/ue-cpp-authoring/` folder.

The rule `rules/ue-cpp.md` is fed by the plugin's hook: on the first read or edit of a file under `Source/` in a session
the rule text enters the context (plugins cannot ship `.claude/rules`, and a copy into the project would change the repository).
Needs `node` 18+.
