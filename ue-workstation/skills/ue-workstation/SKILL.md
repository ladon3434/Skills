---
name: ue-workstation
description: >
  Claude Code harness for an Unreal Engine project on Windows: hooks (no pull/checkout/reset
  while the editor is open, clang-format after a C++ edit, engine root into every subagent,
  editor ownership), templates for settings.json / CLAUDE.md / .clangd / .clang-format /
  .gitattributes, machine check, clangd hygiene, safe pull, commit procedure. Use for "set up a
  new project", "wire the hooks", "check the machine", "doctor", "what is missing on this
  machine", "install the tools", "clangd eats memory", "need compile_commands", "index.lock is
  stuck", "how to pull with the editor open", "how to commit". Russian: «настрой новый
  проект», «подключи хуки», «проверь машину», «чего не хватает на машине», «поставь
  инструменты», «clangd жрёт память», «застрял index.lock», «как спуллить при открытом
  редакторе», «как коммитить».
---

# ue-workstation — the agent's workplace in a UE project

Paths below are relative to the skill folder (`<skill>`, the base folder shown when the skill loads).
Scripts are Node 18+, no dependencies; on Windows call the `.cmd`, otherwise
`node <skill>/scripts/mjs/<name>.mjs`.

The hooks come with the `ue-workstation` plugin (the plugin's `hooks/hooks.json`) and live while the
plugin is enabled: they need not be installed into the project or into `settings.json`, and nothing of
them appears in the project repository. Turn off — `/plugin` or `claude plugin disable ue-workstation`.

## What it provides

| Part | File | What it does |
| --- | --- | --- |
| PreToolUse hook `Bash\|PowerShell\|mcp__.*unreal.*` + PostToolUse `Bash\|PowerShell` | `hooks/editor-guard.mjs` | the rule "touch only what I started", see "Whose editor" |
| PreToolUse hook `Bash\|PowerShell` | `hooks/no-tree-git-editor-open.mjs` | refuses tree-rewriting git (pull, merge, rebase, checkout, switch, restore, clean, reset --hard, stash, submodule update) while THIS project's editor is open (GUI or headless); a submodule counts as its superproject |
| PreToolUse hook `Bash\|PowerShell` — **off unless `UE_WS_GIT_POLICY=1`** | `hooks/git-policy.mjs` | bypasses of the commit procedure: add of the whole tree, commit -a/--amend/-n, --no-verify, force push, reset --hard, clean -f, branch -D, stash clear (see "Git in a UE checkout") |
| PostToolUse hook `Edit\|Write` | `hooks/format-after-edit.mjs` | clang-format of a C++ file under `/Source/` (not generated, not ThirdParty); if the file changed, tells the model "your copy is stale, re-read it" |
| SubagentStart hook | `hooks/subagent-engine-root.mjs` | puts the engine root and the `.uproject` path into every subagent |
| PreToolUse hook `Agent` — limit `UE_WS_FORK_MAX_CONTEXT` | `hooks/fork-context-guard.mjs` | refuses a fork (`subagent_type: fork`) once the conversation is past 150k tokens of context (read from the transcript): a fork carries the whole parent context in every request; a fresh agent with a self-contained prompt instead |
| PostToolUse hook `Edit\|Write` — only with `.claude/skill-lint.json` in the project | `hooks/skill-lint-after-edit.mjs` | after an edit of a skill's `.md` or of the instructions file: every path, script, skill and MCP tool they cite must exist, front matter is valid, the skill list matches the folder (`scripts/skill-lint.cmd` runs it by hand; settings in the header of `scripts/mjs/skill-lint.mjs`) |
| SessionStart hook — off with `UE_WS_SESSION_STATE=0` | `hooks/session-state.mjs` | into the context at session start: this project's editors and whose they are, modules older than their sources, the git branch and uncommitted count; silent outside a UE project |
| PreToolUse + PermissionRequest hook on writes — **off unless `UE_WS_PROJECT_WRITES=1`** | `hooks/project-writes.mjs` | writes inside the project, in `~/.claude`, in `*/Temp/claude/*` and in `UE_WS_WRITE_ROOTS` — without asking; outside — ask; generated trees — no decision |
| status line (wired by hand, see below) | `scripts/mjs/statusline.mjs` | project · model · branch[*] · `UE:open`/`UE:headless` · ctx% · limits; git status at most once a minute, the editor check once per 30 s |
| machine check | `ue-doctor` (on PATH; or `scripts/doctor.cmd`) | read-only: node, git, Git Bash, user.email, git-lfs wired, rg, clang-format, ctags, python, whether the plugin is enabled (so the hooks are live), engine, project, leftovers of the old kit in `.claude\ue-workstation`, submodules, a stray `compile_commands.json`, kit plugins and their dependencies, Blender / ffmpeg where a plugin needs them, MCP ports |
| CLI install | `scripts/install-agent-tools.cmd [--list]` | winget: Git, GitLFS, Node LTS, ripgrep, LLVM, ctags, fd, jq, bat, ast-grep, sd, difftastic, gh, Python, uv, ImageMagick |
| clangd | `scripts/generate-clang-database.cmd`, `scripts/clean-clangd.cmd` | see "clangd policy" |
| git | `scripts/safe-pull.cmd`, `scripts/git-lock.cmd` | pull that respects the editor; removing a dead `index.lock` |
| editor | `scripts/editor-status.cmd [--root <dir>]` | whether this project's editor is open (by the `.uproject` path in the process command line) |
| ownership | `scripts/mjs/ue-owner.mjs` | whose editor, build, port: `status`, `can-launch`, `can-stop <pid>`, `can-build`, `claim <pid>`, `port-owner <port>`. The master copy; `ue-build-test`, `unreal-editor`, `ue-content-gates`, `ue-blender-bridge` hold copies, and `--selftest` of any of them compares them with the rest |
| templates | `templates/` | `settings.json`, `CLAUDE.md`, `.clangd`, `.clang-format`, `.gitattributes`, `.gitignore` |

The hooks and scripts need no `jq` and no bash logic: node reads the JSON (Git for Windows has no jq,
and a bash hook without it silently let everything through).

## New project — step by step

1. `<skill>\scripts\install-agent-tools.cmd --list` — what is missing; without `--list` it installs
   the missing tools through winget. Open a new terminal after installing.
2. Plugins — from the project folder: `claude plugin install ue-workstation@ue-skills --scope local`
   (and the others you need). `local` writes one line into `.claude\settings.local.json`, which git
   does not see; the project repository is not changed. `--scope user` — for every project on the machine.
3. `ue-doctor` from the project folder — fix every `[FAIL]`.
   `--ports 18000,8000` — check the ports of your services; without the flag the ports from `.mcp.json` are used.
4. Restart the Claude Code session (or `/reload-plugins`).

Further steps — only at the project owner's request: these are already changes to their repository or settings.

- **Templates** `<skill>\templates\`: `CLAUDE.md` (project, routing table — delete the rows of skills
  that are not installed), `.clangd`, `.clang-format`, `.gitattributes`, `.gitignore`.
  Copy the missing ones; merge an existing file by hand.
- **Permissions** `templates\settings.json`: `defaultMode: acceptEdits` + a broad `allow`, while all
  deletions and forceful git commands go to `ask` for Bash AND PowerShell (rm, Remove-Item, del,
  git clean, git reset --hard, git push --force …). For yourself only — in `.claude\settings.local.json`,
  for the whole team — in `.claude\settings.json`. Into an existing file:
  `node <skill>\scripts\mjs\merge-settings.mjs <file> --out <file>.merged.json` (the project's scalars
  win, lists are merged), review it, replace by hand. The template does not set the no-confirmation
  mode (`bypassPermissions`) — that is the owner's decision, and the `ask` list is then the only safeguard.
- **Writes inside the project without asking** (`project-writes`): `"env": { "UE_WS_PROJECT_WRITES": "1" }`
  in `.claude\settings.local.json`.
- **Status line**: `"statusLine": { "type": "command", "command": "node \"<clone>/ue-workstation/skills/ue-workstation/scripts/mjs/statusline.mjs\"" }`,
  where `<clone>` is the marketplace folder: the Skills repository if the marketplace was added from disk,
  else `%USERPROFILE%\.claude\plugins\marketplaces\ue-skills`.

Hook check on synthetic data (temporary repositories, a fake process list; no editor needed) —
`<skill>\scripts\hooks-test.cmd`.

## clangd policy

- `compile_commands.json` is ABSENT by default. With it clangd indexes the whole engine in the
  background and eats tens of GB of commit charge; UBA hits "Low on memory" and runs kill/retry
  forever — builds never finish.
- Need an LSP — `generate-clang-database.cmd` (UBT `-Mode=GenerateClangDatabase`;
  `--dry-run` prints the command; refuses while someone else's build runs), work, then
  `clean-clangd.cmd` (`--dry-run` — the list). It removes the database and `.cache/clangd` in the
  project AND next to the engine — an LSP with `--compile-commands-dir` pointing at the engine takes it from there.
- `.clangd` in the repository is the parsing config (MSVC driver mode), never deleted.
  Match `-fms-compatibility-version` to the MSVC that UBT builds with.

## Git in a UE checkout

Commit and push only when the person asked, and always by one procedure, even for a one-line change:

1. Code among the changes (`.cpp`/`.h`/`.cs`, `.Build.cs`/`.Target.cs` included) — format your files and build
   the way the project prescribes (ue-build-test). A failure stops it: fix, do not commit. Docs and config
   only — no build needed.
2. `git fetch`, `git status`. The branch is behind — bring it up to date (`safe-pull.cmd` with the editor
   open); a conflict — stop and hand it to the person, never resolve it silently.
3. The message describes the changes (what and why) and goes into a file.
4. **Show the person the message and the full list of files the commit will contain, and wait for an explicit
   "yes".** No commit, no push before the answer. This step has no fast path.
5. `git add <paths>` by name, `git commit -F <file> -- <paths>`, `git push` (never forced).

The rules below. With `UE_WS_GIT_POLICY=1` the `git-policy` hook holds them (off by default): add of the whole
tree, commit `-a`/`--amend`/`-n`, `--no-verify`, any force push or remote branch deletion, `reset --hard`,
`clean -f`, checkout/restore of the whole tree, `branch -D`, `stash clear`. The hook knows nothing about
approval — step 4 stays with the agent. When the person wants a refused command, they run it themselves:
`! <command>`.

- Stage only your own paths, by name. Never `git add -A` / `git add .` / a whole directory: the
  editor rewrites `.ini`/`.uasset` behind your back, and another session or a person may work in
  the same tree. Limit the commit to paths: `git commit -- <paths>`.
- A multi-line message only from a file: `git commit -F <file>`. cmd.exe breaks a multi-line `-m`,
  and `cmd //c "... -m \"...\""` from Bash splits the message into pathspecs.
- Never `--no-verify`: fix what the hook caught. A new commit is better than an amend.
- With the editor open — no tree-rewriting git (the hook refuses). Pull —
  `safe-pull.cmd [--rebase] [--dry-run]`: fetch first; if origin changed `.uasset`/`.umap`/DLLs —
  refusal with the file list; if only sources — pulls with a warning (restart/rebuild the
  editor). It stashes nothing and makes no merge commits.
- `index.lock exists` after a commit killed by a timeout — `git-lock.cmd [--repo <dir>]`: removes
  the lock only if no git that writes the index is alive (`--dry-run` — only report).
- Only an editor started by this session may be stopped (see "Whose editor"); leave everything
  else alone.

## Whose editor

The canonical rule for every plugin of the kit. There is no broker: **an agent stops, restarts and rebuilds only
what its own session started.** A session is the `claude.exe` process above the command (its pid and start
time); whoever starts an editor writes a marker into the editor's project, `<project>/Saved/AgentEditors/<pid>.json`,
with the pid and start time of the editor and of the owner session. When the session ends, ownership ends.

| What you see | Whose | What you may do |
| --- | --- | --- |
| marker of my session | mine | close, rebuild, restart |
| marker of another live session | another agent's | nothing: wait |
| marker of a finished session, headless | orphaned agent editor | adopt and stop it (`ue-stop-editor`) |
| marker of a finished session, GUI | treated as a person's: a person may have started working in it | nothing: ask |
| no marker / command line unreadable | a person's | nothing: ask |

Machine limits: while an editor that is not mine (any project) or someone else's build runs, my editor is not
started — wait; next to another project's editor only when the person said so (`--alongside`). A second editor of
the same project — never: it gets no MCP port and fights over the same files. A build waits for someone else's
build and does not run while this project's editor is open (the Game target is not blocked by editors). A build
needs no marker: it runs inside the call, and its process tree reaches its own `claude.exe`.

The skills' own scripts (`ue-owner.mjs`) check this, and the `editor-guard` hook on top of them: it
refuses stopping editors by image name, stopping someone else's or a foreground editor by pid,
launching a second editor and building with the project's editor open; an MCP call — if the port is
answered by another project's editor. After the call it writes the marker itself for an editor that
appeared during this call from this session. The hook lives while the `ue-workstation` plugin is
enabled; `ue-build-test`, `unreal-editor` and `ue-content-gates` install it as a dependency. Without
the plugin (the skill wired as a folder) — `scripts\install-editor-guard.cmd`
(into `%USERPROFILE%\.claude\settings.json`; `--uninstall` — remove, `--dry-run` — show); with the
plugin enabled, remove the manual wiring, otherwise the hook fires twice. State —
`node <skill>\scripts\mjs\ue-owner.mjs status`.

## Ports

Keep the ports of your local services (MCP servers, bridges) OUTSIDE the Windows dynamic TCP range
(`netsh int ipv4 show dynamicport tcp`, usually 49152-65535): WinNAT/Hyper-V reserve blocks in it at
boot, and `listen()` fails with EACCES, which looks like "already running". `doctor --ports` checks
both the range and the currently excluded blocks.

## Variables

| Variable | Why |
| --- | --- |
| `UNREAL_HOME`, `UE_VERSION` | engine root/version (otherwise `EngineAssociation` from the `.uproject` → Epic registry) |
| `UE_WS_PROJECT_WRITES` | `1` turns on the `project-writes` hook (off by default) |
| `UE_WS_GIT_POLICY` | `1` turns on the `git-policy` hook (off by default) |
| `UE_WS_SESSION_STATE` | `0` turns off the `session-state` hook (on by default) |
| `UE_WS_FORK_MAX_CONTEXT` | context limit in tokens for a fork (`fork-context-guard`, default 150000); `0` turns it off |
| `UE_WS_WRITE_ROOTS` | extra roots for writes without asking, separated by `;` |
| `UE_WS_PROC_FIXTURE` | JSON process list instead of a live query (tests only) |
| `UE_WS_CLANG_FORMAT` | another clang-format (tests, non-standard install) |
