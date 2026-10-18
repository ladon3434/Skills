# devping

Pings to the phone from Claude Code windows through [ntfy](https://ntfy.sh). A window that waits for an answer, or
has finished and waits for the next word, sends the phone its name («<folder> @ <machine>») and that kind — nothing
of the conversation.

## Contents

Paths are relative to the skill folder `skills/devping/`; `.claude-plugin/`, `hooks/hooks.json`, `bin/` sit at the
plugin root.

| Path | What |
| --- | --- |
| `SKILL.md` | connecting a project, test, status, disconnect |
| `scripts/devping.py`, `scripts/devping.cmd` | the tool: `connect`, `test`, `status`, `disconnect`, `hook` (`bin/devping` puts it on the Bash PATH) |
| `hooks/hooks.json` (plugin root) | the `Notification` hook — pings only for a project that has a topic |
| `scripts/tests/pingtest.py` | end-to-end test with a local fake ntfy and registry |

## Install

A plugin of the `ue-skills` marketplace (adding the marketplace: root `README.md`):

```
claude plugin install devping@ue-skills        :: every project on the machine
```

Then, in a project: `devping connect` and subscribe to the printed topic in the ntfy app. The project's files are not
changed: the topic is a user environment variable `NTFY_TOPIC_<FOLDER>`. Needs Python 3 on PATH; Windows (the topic
is stored in the user environment).
