# ue-workstation

Claude Code harness for any UE project on Windows: hooks, settings templates, machine check,
clangd hygiene, safe git.
How to use it — `SKILL.md`.

## Contents

Paths are relative to the skill folder `skills/ue-workstation/`; `.claude-plugin/`, `hooks/hooks.json`, `bin/`, `agents/` sit at the plugin root.

| Path | What |
| --- | --- |
| `hooks/no-tree-git-editor-open.mjs` | refuses tree-rewriting git while the editor is open |
| `hooks/git-policy.mjs` | bypasses of the commit procedure (add of everything, -a, --amend, force push, reset --hard …); only with `UE_WS_GIT_POLICY=1` |
| `hooks/format-after-edit.mjs` | clang-format + a "re-read it" notice through `additionalContext` |
| `hooks/subagent-engine-root.mjs` | engine root and project — into every subagent |
| `hooks/fork-context-guard.mjs` | refuses a fork once the conversation is past 150k tokens of context; limit `UE_WS_FORK_MAX_CONTEXT`, `0` off |
| `hooks/skill-lint-after-edit.mjs`, `scripts/skill-lint.cmd` | every reference in a project's skills and AGENTS.md / CLAUDE.md must resolve; only in projects with `.claude/skill-lint.json` |
| `hooks/unbounded-wait-guard.mjs` | refuses a background command with no time bound of its own (`timeout <N>`, PowerShell `-Timeout…`; opt-out comment `unbounded-ok: <why>`), names a foreground command the client moved to the background; off with `UE_WS_WAIT_GUARD=0` |
| `hooks/state-claim-guard.mjs` | Stop / AskUserQuestion: sends back once a reply or question that says "it builds", "tests pass", "ID-123 is done" with no build, test or git check in the same turn; off with `UE_WS_STATE_GUARD=0` |
| `hooks/session-state.mjs` | at session start: this project's editors and whose, stale modules, git state; off with `UE_WS_SESSION_STATE=0` |
| `hooks/project-writes.mjs` | writes inside the project without asking, outside — ask; only with `UE_WS_PROJECT_WRITES=1` |
| `hooks/editor-guard.mjs` | ownership rule for editors, builds and the MCP port (SKILL.md, "Whose editor") |
| `hooks/hook-io.mjs` | payload reading, block/addContext |
| `scripts/mjs/ue-engine.mjs` | engine, project, platform, UBT path. The master: copied unchanged into every plugin that needs it (`scripts/repo-check.mjs` at the repository root checks) |
| `scripts/mjs/ue-proc.mjs` | is this project's editor running? (tasklist → CIM, matched by command line). The master, as above |
| `scripts/mjs/ue-owner.mjs` | whose editor / build / port; `Saved/AgentEditors` markers. The master copy: `--selftest` checks the copies in `ue-build-test`, `unreal-editor`, `ue-content-gates` (and `ue-blender-bridge` where it sits next to them) |
| `scripts/mjs/ue-pyremote.mjs` | Python in a running editor through Epic's Python Remote Execution (find this project's editor, pid probe, ownership check). The master: copies in `unreal-editor` (`ue.py`) and `ue-build-test` (`ue-stop-editor`), checked by `--selftest` and `scripts/repo-check.mjs` |
| `scripts/install-editor-guard.cmd`, `scripts/mjs/install-editor-guard.mjs` | without the plugin: write `editor-guard` into the user's `settings.json` (or `--settings`), `--uninstall`, `--dry-run` |
| `scripts/mjs/doctor.mjs`, `bin/ue-doctor` | machine and project check (read-only): tools, engine, kit plugins and their dependencies, Blender / ffmpeg for the plugins that need them, MCP ports |
| `scripts/mjs/install-agent-tools.mjs` | winget installer for the CLI tools |
| `scripts/mjs/generate-clang-database.mjs`, `clean-clangd.mjs` | clangd database: create / remove everywhere |
| `scripts/mjs/safe-pull.mjs` | pull that respects the editor |
| `scripts/mjs/git-lock.mjs` | remove a dead `index.lock` |
| `scripts/mjs/statusline.mjs` | cheap status line + editor marker |
| `scripts/mjs/merge-settings.mjs` | merge the settings.json template into an existing one without overwriting |
| `tests/hooks-test.mjs` | fixture tests of the hooks (offline) |
| `templates/*` | settings.json, CLAUDE.md, .clangd, .clang-format, .gitattributes, .gitignore |

## Installation

A plugin of the `ue-skills` marketplace (how to add the marketplace — the root `README.md`). From the project folder:

```
claude plugin install ue-workstation@ue-skills --scope local   :: this project only; the project repository is not changed
claude plugin install ue-workstation@ue-skills                 :: every project on the machine
```

Turn off — `/plugin` → Installed (space), or `claude plugin disable ue-workstation@ue-skills`. After installing —
`/reload-plugins` or a new session. `<skill>` paths below are the plugin's `skills/ue-workstation/` folder.

The hooks (the plugin's `hooks/hooks.json`) live while the plugin is enabled: `editor-guard`, `no-tree-git-editor-open`,
`format-after-edit`, `subagent-engine-root`, `fork-context-guard`, `skill-lint-after-edit`, `session-state`,
`unbounded-wait-guard`, `state-claim-guard`. `project-writes` and `git-policy` stay off until
`UE_WS_PROJECT_WRITES=1` / `UE_WS_GIT_POLICY=1` is set (e.g. `env` in the project's `.claude/settings.local.json`).
Templates, permissions and the status line — step by step in `skills/ue-workstation/SKILL.md`, only if the project owner wants them.

Kit check: `<skill>\scripts\hooks-test.cmd`, `node <skill>\scripts\mjs\ue-owner.mjs --selftest`,
`node <skill>\scripts\mjs\ue-proc.mjs --selftest`, `node <skill>\scripts\mjs\safe-pull.mjs --selftest`,
`node <skill>\scripts\mjs\git-lock.mjs --selftest`.
