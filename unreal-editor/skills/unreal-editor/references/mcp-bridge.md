# The lazy MCP bridge (optional)

`<skill>/scripts/mcp-bridge/bridge.mjs` — a stdio MCP server that stands between Claude Code and the editor's
HTTP MCP server (Epic's `unreal-mcp`). Node 18+, no dependencies. An editor it starts has Python Remote Execution
on too (`ue.py < code`). Engines newer than 5.8.3 may ship Epic's own `unreal_mcp_proxy` for the same job
(not in 5.8.3) — `epic-mcp-toolsets.md` §After an engine update.

## What it fixes

| Without it (`type: http` straight to the editor) | With it |
| --- | --- |
| Editor down at session start → no tools for the whole session | Tools listed from a cache (first run: Epic's three meta-tools from `seed-epic-tool-search.json`); the real list arrives with `tools/list_changed` |
| Editor restarted → the client stays disconnected; only curl (`ue.py`) works | The bridge never disconnects: a stale session is renewed and the call replayed; a dead editor is reported and the next call reconnects |
| A tool call with the editor down just fails | The first call boots the editor (headless, only when the ownership rule allows it) and says «EDITOR STARTING, re-run»; the boot continues in the background |
| Screenshots arrive as base64 inside JSON text and overflow the result limit | Images are lifted into native MCP image blocks |
| A cold boot and a modal look alike | Not-ready answers read the project log: advancing = slow boot, frozen = modal or boot error |

It never stops the editor. A headless editor it started gets the ownership marker
`<project>/Saved/AgentEditors/<pid>.json` naming this Claude Code session; after the session ends it stays up as a
headless orphan, which the next session may reuse, adopt or stop (`ue-owner.mjs`, SKILL.md "Ownership rule").

## Install

For yourself only, without touching the project's repository — from the project folder (local scope is stored in
`~/.claude.json` under this project and outranks a project `.mcp.json` entry of the same name):

```
claude mcp add --scope local unreal-mcp -- node "<clone>/unreal-editor/skills/unreal-editor/scripts/mcp-bridge/bridge.mjs"
```

`<clone>` is a stable copy of this repository: the Skills folder when the marketplace was added from disk, else
`%USERPROFILE%\.claude\plugins\marketplaces\ue-skills` (not the versioned plugin cache, whose path changes on every
update). Remove with `claude mcp remove --scope local unreal-mcp`.

For the whole team, in the project's `.mcp.json` (copy of `<skill>/templates/mcp.json.example`, with the path to
`bridge.mjs` every clone has — below, this repository as a submodule at `Tools/Skills`):

```json
{
  "mcpServers": {
    "unreal-mcp": {
      "type": "stdio",
      "command": "node",
      "args": ["Tools/Skills/unreal-editor/skills/unreal-editor/scripts/mcp-bridge/bridge.mjs"]
    }
  }
}
```

Replace an existing `"type": "http"` entry of the same name. The bridge finds the project from its working
directory (Claude Code starts it in the project root; `--project <dir>` otherwise) and the port from the project's
settings (`ue-project.cmd`); `UE_MCP_PORT` / `UE_MCP_URL` override. Restart the Claude Code session after the change.

## Options

| Flag / env | Meaning |
| --- | --- |
| `--launch default` (default) | boot `UnrealEditor-Cmd <uproject> -unattended -nopause -nosplash -RenderOffScreen -nosound -SCCProvider=None -ModelContextProtocolStartServer -ModelContextProtocolPort=<port>` from the project's engine |
| `--launch none` | never launch; calls with the editor down answer «EDITOR NOT STARTED» |
| `--launch "<command>"` / `UE_MCP_LAUNCH` | your own launcher (a `.cmd`, a GUI editor command line) |
| `--name <server>` | the server name it reports (default `unreal-mcp`) |
| `--seed <file>` | tool list to serve before the first live list |
| `--prewarm` | boot (if needed), cache the live tool list, exit |
| `MCP_BRIDGE_CACHE_DIR` | tool-list cache (default `<project>/Saved/mcp-bridge/`) |
| `UE_OWNER_FIXTURE` | tests only: a synthetic process table for `ue-owner.mjs` instead of the live one |
| `MCP_BRIDGE_CALL_TIMEOUT_SEC` / `_WARMUP_SEC` / `_LAUNCH_TIMEOUT_SEC` / `_PROGRESS_SEC` | 900 / 45 / 240 / 15 |

## The launch guard

Before launching it refuses, with the reason in the tool answer, when:

1. `Saved/Autosaves/PackageRestoreData.json` has pending packages — the editor would stop on the restore panel;
2. the process query fails — nobody can tell whose editors run, so nothing is started blind;
3. `ue-owner.mjs canLaunch` says no: an editor of this project runs that is not this session's, an editor of another
   project runs that is not ours (a person's, another live session's, a GUI orphan), or a build that is not ours
   runs — the reason is quoted. A headless orphan elsewhere is named with the pid to stop first.

When this session's own editor of the project is already up (still booting), it waits for it instead of starting a
second one. Two bridges racing to launch are serialized by a file lock in the cache dir. Right after the spawn the
bridge writes the ownership marker (for `--launch "<command>"` it finds the editor by its start time).

## Tests

`node <skill>/scripts/mcp-bridge/test/bridge-test.mjs` — black-box through stdio against a fake HTTP editor, a synthetic
process table (`UE_OWNER_FIXTURE`) and a fake launcher; nothing real is touched (~1 min). Part of `<skill>/scripts/selftest.cmd`.
