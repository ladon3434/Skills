# Skills

Portable Claude Code skills for Unreal Engine 5.x development. The repository is a Claude Code plugin marketplace,
`ue-skills`: every skill is its own plugin, installed, switched off and updated on its own.

**Made for**: Windows, git, Unreal Engine 5.8 (the engine version comes from the project's `.uproject`; the live
editor tools of `unreal-editor` follow Epic's 5.8 `unreal-mcp`). Other setups are not tested.

## Start here

In the project folder, once:

```
claude plugin marketplace add ladon3434/Skills
claude plugin install ue-workstation@ue-skills --scope local
claude plugin install code-analysis@ue-skills --scope local
claude plugin install ue-build-test@ue-skills --scope local
```

Then a new session and `ue-doctor` in it (the agent runs it, or `! ue-doctor`): every `[FAIL]` line names its fix.
Add the rest by task from the table below: `unreal-editor` for a live editor, `ue-content-gates` for content
checks, `ue-release` before a release, `ue-cpp-authoring` / `ue-gas` / `ue-systems` for writing code.

## Install

1. Once per machine, add the marketplace:

   ```
   claude plugin marketplace add ladon3434/Skills          :: from GitHub
   claude plugin marketplace add C:\path\to\Skills         :: or from a local clone
   ```

2. Pick plugins: in a session, `/plugin` → Discover, select with Space; or from a console in the project folder:

   ```
   claude plugin install unreal-editor@ue-skills --scope local   :: this project only
   claude plugin install unreal-editor@ue-skills                 :: every project on the machine (scope user)
   ```

3. `/reload-plugins` or a new session.

**The project repository is not touched.** Plugin files live in `%USERPROFILE%\.claude\plugins`; a `--scope local`
install writes one line into `<project>\.claude\settings.local.json`, which Claude Code keeps in the global git
ignore. Do not use `--scope project`: it writes `.claude/settings.json`, which is committed.

**Switch off**: `/plugin` → Installed → Space, or `claude plugin disable <plugin>@ue-skills`. A plugin enabled for the
whole machine is switched off in one project with `claude plugin disable <plugin>@ue-skills --scope local` from that
project's folder. Remove: `claude plugin uninstall <plugin>@ue-skills`.

**Update**: `claude plugin marketplace update ue-skills`, then `claude plugin update <plugin>@ue-skills` (or turn on
the marketplace's auto-update in `/plugin` → Marketplaces). A plugin's version is the repository commit: no
`plugin.json` carries a `version` on purpose — a fixed one pins the plugin and updates skip every commit until it
is bumped.

**Do not remove the marketplace** to reinstall it or to switch its source between GitHub and a local clone:
`claude plugin marketplace remove ue-skills` uninstalls every `ue-skills` plugin in every project on the machine and
deletes their saved options and data, so each plugin has to be installed again in each project. Note which plugins
each project has (`claude plugin list` from its folder) before removing it.

Skills and agents carry the plugin prefix in a session: `/unreal-editor:unreal-editor`, `code-analysis:code-scout`.
Skills still trigger from their descriptions, in English or Russian.

## Plugins

| Plugin | What it does | Installs with it |
| --- | --- | --- |
| [`ue-workstation`](ue-workstation/README.md) | safety hooks (editor ownership, no tree-rewriting git while the editor is open, clang-format, engine root for subagents), optional git policy, templates for settings/CLAUDE.md/.clangd, doctor, safe-pull, clangd hygiene | |
| [`code-analysis`](code-analysis/README.md) | analysis, diff review with a UE checklist (GC, lambdas, timers, perf), debugging to the root cause and crash triage; engine signatures (`engine-api`), known hazards (`hazards`), log scan (`log-scan`), agents code-scout / engine-reader / log-triage | |
| [`ue-cpp-authoring`](ue-cpp-authoring/README.md) | UE C++ conventions, the `Source/**` rule (via hook), assertions/threading/UHT, subsystems and data assets, validators, Blueprint → C++, widgets, logging, refactoring with CoreRedirects, editor-tool plugin contract | |
| [`ue-build-test`](ue-build-test/README.md) | builds, full rebuild, Game/Shipping gate, headless automation tests with quarantine and a RESULT line, test authoring, soft stop of its own editor | `ue-workstation` |
| [`unreal-editor`](unreal-editor/README.md) | live editor: Epic's `unreal-mcp` toolsets and Python through Epic's Remote Execution, port and log from the project, Epic toolset schema snapshots, Live Coding, Agent Skills, content pitfalls, Python inspection of PIE, lazy MCP bridge | `ue-workstation` |
| [`ue-content-gates`](ue-content-gates/README.md) | offline checks without the editor: `.uasset` headers, which content uses a C++ symbol (`find-asset-refs`), forbidden references, `/Game` paths in C++, cook verification | `ue-workstation` |
| [`ue-gas`](ue-gas/README.md) | Gameplay Ability System: cheatsheets for features, review checklist, mechanics reference (working digest + tranek's GASDocumentation, MIT) with 5.5+ corrections | |
| [`ue-systems`](ue-systems/README.md) | Enhanced Input, StateTree and PCG in 5.8, one skill each: setup, C++ idioms, review checklist, traps checked against the engine source | |
| [`ue-release`](ue-release/README.md) | pre-release pass: metadata, branding, debug code out of Shipping, PSO cache, localization coverage, then the project's own packaging command | `ue-workstation` |
| [`ue-perf`](ue-perf/README.md) | profiling with Unreal Insights without its window: capture a `.utrace` (channels, build type), headless export, text digest — frame times and hitches, top timers per thread and GPU, worst frames (`ue-trace`) | |

`ue-workstation` comes as a dependency of the plugins that start or stop the editor: it carries the `editor-guard`
hook that stops an agent from killing or duplicating an editor it did not start. While they are enabled it cannot be
switched off — Claude Code refuses and names what to switch off with it.

### General

| Plugin | What it does |
| --- | --- |
| [`devping`](devping/README.md) | pings to the phone through ntfy when a Claude Code window waits for an answer or has finished; per-project topics, nothing written into the project |
| [`doc-tts`](doc-tts/README.md) | markdown → MP3 with a local neural voice (Qwen3-TTS on a ComfyUI stand, a designed voice), Edge TTS as a fallback |
| [`md-doc-hygiene`](md-doc-hygiene/README.md) | writing docs people read (`docs-for-readers`: structure, problems, open questions, Obsidian table of contents) and form rules with checkers: numbering, anchors, links, tables, tables of contents, repeated sentences; jargon and glossary by the project's dictionaries |
| [`desk-utils`](desk-utils/README.md) | Windows clipboard read/write, screen capture, markdown/HTML → PDF via headless Chrome or Edge |

## Environment

Machine variables: `UNREAL_HOME`, `UE_VERSION` (the `.uproject` version wins), `ENGINE_INDEX_HOME`,
`UE_SAMPLES_ROOT`, `UE_MCP_PORT`. There is no broker: an agent touches only what it started itself
(markers in `Saved/AgentEditors`, `ue-workstation/skills/ue-workstation/scripts/mjs/ue-owner.mjs`). Scripts need
Node 18+, some skills Python 3; the machine check is `ue-doctor` from `ue-workstation`.

## Plugin layout

```
<plugin>/
  .claude-plugin/plugin.json   name, description, dependencies
  skills/<skill>/SKILL.md      the skill with its references/, scripts/, templates/
  hooks/hooks.json             hooks (live while the plugin is enabled)
  agents/*.md                  subagents
  bin/                         commands the plugin puts on the Bash tool's PATH
  README.md
```

Editing a skill: with the marketplace added from a local clone, plugins are read in place from the clone — an edit
takes effect at the next session or `/reload-plugins`, no reinstall. Users who added the marketplace from GitHub
get it after a commit is pushed, through `claude plugin marketplace update ue-skills` and
`claude plugin update <plugin>@ue-skills`. Validate manifests with `claude plugin validate <folder>`.

Before a commit: `node scripts/repo-check.mjs [../PrivateSkills]` — shared modules (`ue-engine.mjs`, `ue-proc.mjs`,
`ue-owner.mjs`) are one file copied into every plugin that needs them, the master in `ue-workstation`; the check
fails on a copy that differs, an unknown dependency, a `version` field, a skill description over 1024 characters.
