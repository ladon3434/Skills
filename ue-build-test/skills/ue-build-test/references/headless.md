# Headless editor: when, how and what not to do

A capability, not a habit. The agent works only with a windowless editor and never starts a GUI
editor by itself. Anything that needs looking or playing goes to a person (below).

## When it is needed at all

| Task | With what |
| --- | --- |
| Automation test run | `ue-test.cmd` — starts and stops its own editor |
| One-off Python pass over assets | commandlet: `UnrealEditor-Cmd <uproject> -run=pythonscript -script=<file> -unattended -nosplash -nullrhi` (not `-ExecutePythonScript`; `-nullrhi` suits a commandlet, not the editor) |
| Long work through the MCP server inside the editor, a live log | `ue-run-editor-headless.cmd` + `ue-wait-editor.cmd` |

Trap: a path with a space in `-script=` or `-abslog=` is a silent no-op. The editor starts, does
nothing and exits without an error. Put the script and the log in a folder without spaces; read
the result from the log, not from the exit code. Before a commandlet — the same ownership check
(`node scripts/mjs/ue-owner.mjs can-launch`) and the same prohibitions as below.

## Launch

`ue-run-editor-headless.cmd` runs `UnrealEditor-Cmd <uproject> -unattended -nopause
-nosplash -RenderOffScreen -SCCProvider=None -nosound -ABSLOG=Saved/Logs/<Name>-Headless.log`
in its own minimised console and refuses if:

- a GUI editor of the same project is open — the person's save would fail with
  `MoveFile ... (Error Code 32)`; tell them and wait, do not launch;
- the sources are newer than the binaries — `ue-compile.cmd` first, otherwise it starts old code;
- an editor started by another session is running (any project: one editor at a time on the
  machine), or someone else's build is running — it waits up to `--wait` seconds and refuses.

For the editor it starts, the script writes the owner marker `Saved/AgentEditors/<pid>.json`: only
this session may close it later (`ue-stop-editor.cmd`).

An already running headless editor of this project is reused: one instance at a time. Reuse does
not make someone else's editor mine: it may be closed only if it is mine or a headless orphan.

`ue-wait-editor.cmd [--timeout s] [--port N]` waits for the line `Engine is initialized` in a log
written after the process started (an old log with the same line will not fool it), or an open
port. Answers: `READY`; `DEAD` — no process of this project (crashed or did not start);
`TIMEOUT` with a diagnosis: the log grows — still working (shaders, DDC); the log has stood still
for 60 s or more — a modal window is up; do not restart in a loop, tell the person which window.

## Stopping

`ue-stop-editor.cmd` — as soon as the editor is not needed, and always before the final report.
A forgotten headless editor eats ~3 cores, holds DLLs and ports, blocks builds and slows the
person's GUI editor. The close order and `--force` — in `SKILL.md`.

## When a person is needed

Only for what a headless run, tests and logs cannot settle. Before asking, check that the named
entry points exist on disk (the map in `Content/Maps`, the actor, the input binding). If the
mechanic cannot be reached in game, the path to it in order: debug CVar → console command
(`open <map>`, `summon`, `ce`) → a test level for it. The request is plain words in three parts:
where to go (the map and how to get there), what to do, what "correct" looks like. Log markers
and filters stay with the agent: it reads the log after the person answers.
