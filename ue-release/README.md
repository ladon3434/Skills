# ue-release

Pre-release pass for any Unreal Engine 5.x project: metadata, branding, debug code that must not reach Shipping,
bundled PSO cache, localization coverage, then the project's own packaging command.

## Contents

Paths are from the skill folder `skills/ue-release/`; `.claude-plugin/`, `hooks/hooks.json`, `bin/`, `agents/` are at the plugin root.

| Path | What |
| --- | --- |
| `SKILL.md` | the full pass in order, the PSO chain, localization, "done" |
| `references/preflight.md` | each audit line and the engine rule behind it; fallback `BuildCookRun` line |
| `references/pso-cache.md` | the 5.8 PSO cache files, folders, commandlet, cvars — verified on engine source |
| `references/localization.md` | gather configs, archive format, C++ text rules |
| `scripts/release-preflight.cmd` | offline audit: metadata, icon/splash, PSO cache presence, debug code in runtime modules |
| `scripts/pso-cache.cmd` | `status` of recordings / stable keys / shipped cache; `expand` into `Build/<Platform>/PipelineCaches` |
| `scripts/loc-check.cmd` | untranslated archive entries per culture; `--gather` (GatherText), `--code` (LOCTEXT / FText::FromString) |
| `scripts/mjs/release-common.mjs` | arguments, project, .ini reader, commandlet runner (dry-run, refuses next to an editor of the project) |
| `scripts/mjs/ue-engine.mjs`, `ue-proc.mjs` | engine lookup and "is an editor of this project running" — copies of the ue-workstation files |

## Installation

A plugin of the `ue-skills` marketplace (adding the marketplace — the root `README.md`). From the project folder:

```
claude plugin install ue-release@ue-skills --scope local   :: this project only; the project repository is not changed
claude plugin install ue-release@ue-skills                 :: every project on the machine
```

Turn off — `/plugin` → Installed (space), or `claude plugin disable ue-release@ue-skills`. After installing —
`/reload-plugins` or a new session. Paths `<skill>` below are the plugin's `skills/ue-release/` folder.

Installs `ue-workstation` as a dependency — for the `editor-guard` hook, since the PSO and gather commandlets start
the editor binary.

## Environment

| Variable | What for | Default |
| --- | --- | --- |
| `UNREAL_HOME` | engine root (required for a source build) | from the Epic registry by the project's version |
| `UE_VERSION` | engine version when the `.uproject` has no `EngineAssociation` like `5.x` | 5.8 |

Needs `node` 18+. Every script takes `--project <dir>` (default: the nearest `.uproject` above the current
folder) and `--help`; the ones that start a commandlet take `--dry-run`.
