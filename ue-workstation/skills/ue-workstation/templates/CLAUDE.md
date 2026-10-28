# CLAUDE.md — <ProjectName>

Router for agent sessions in this Unreal Engine project. Load the one skill the task routes to and follow it;
project facts live in the documents linked below, not here. Keep this file short: every line is paid by every
session.

## Project

- `<ProjectName>.uproject`, UE <5.x>; runtime module `<Module>` (log category `Log<Module>`); plugins: <list>.
- Architecture, modules, test suites → `<Docs/architecture.md>`.
- Engine root on this machine: `ue-workstation/scripts/mjs/ue-engine.mjs` prints it; every subagent gets it at start.

## Routing

One leading skill per task; compilation, review, git and the editor lifecycle are gates it calls. Each skill's
`description:` names its triggers; this table is the map. Delete the rows of skills not installed.

| Task | Skill | Not to confuse with |
| --- | --- | --- |
| Analyse a module / mechanic, review a diff, debug a failure to its root | `code-analysis` | reads and reports, never edits |
| Compile, rebuild, run automation tests, headless runs | `ue-build-test` | the live editor → `unreal-editor` |
| Live editor: Python in the editor, PIE, asset edits, Blueprint edits | `unreal-editor` | starting it → `ue-launch-editor`; stopping → `ue-stop-editor` (ue-build-test) |
| Machine check, hooks, clangd, git safety in this checkout | `ue-workstation` | |
| <Domain task> | `<skill>` | <neighbour> |

## Communication

- Reply in the language the conversation is held in; code, comments, commits and identifiers in English.
- No Cyrillic (or other non-ASCII) in paths or file names.
- Repository prose carries only the current state; history lives in git.
- If the user's word conflicts with the facts of the code, say so once, plainly, then do what they decide.
- A failed build or test is reported with its exact cause; never imply success.

## Context economy

- Do not read large files whole; batch independent tool calls in one message.
- External corpora (engine source, Epic samples) are read in a subagent, never inline; an engine signature is one
  `engine-api` call (code-analysis).
- Logs are cited by path + line numbers, never pasted.
- A subagent returns text unless told otherwise; when a report file is wanted, the prompt says «write your report
  to `<path>`, then answer with the path and a status line».
- A multi-step feature keeps its plan in a file in the repository; after compaction trust that file + `git log`.

## Parallel work

- One machine has ONE editor, ONE build (UBT is machine-wide) and ONE git index per checkout, shared by every
  session and the person at the keyboard. An agent stops only an editor its own session started (marker in
  `Saved/AgentEditors`, `ue-owner.mjs status`); anything else is waited for. A refusal from a build/editor script or
  the editor-guard hook is contention, not an error.
- An editor without this session's marker belongs to a person or another session: never kill it.
- No tree-rewriting git (pull, checkout, reset --hard, stash, rebase) while the editor is open — the hook refuses
  it; `ue-workstation/scripts/safe-pull.cmd` pulls source-only changes.
- Stage by explicit path, never `git add -A`: the editor rewrites `.ini`/`.uasset` behind you, other sessions
  have work in the same tree.

## Build & verification

- Generated trees are never edited or committed: `Binaries/`, `Intermediate/`, `DerivedDataCache/`, `Saved/`, `.vs/`.
- `.uasset`/`.umap` change only in an asset task.
- `compile_commands.json` stays absent (clangd eats tens of GB of commit charge): generate it for a task, then
  `clean-clangd`.
- Local service ports (MCP servers, bridges) live outside the Windows dynamic TCP range (`doctor --ports ...`).

## Tools

- Shell: prefer `rg`, `fd`, `git`, `gh` over PowerShell cmdlets; `Grep`/`Glob`/`Read` for simple lookups.
- A secret lives only in a user environment variable, never in a file in or beside the repository.
