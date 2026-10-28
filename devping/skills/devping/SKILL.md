---
name: devping
description: Pings to the phone from Claude Code windows through ntfy — connect a project, send a test ping, check or stop it. Use for "phone pings", "notify me on the phone", "connect pings", "devping", "stop the pings", "send a test ping", «подключи пинги», «пинги на телефон», «хочу уведомления на телефон», «отключи пинги», «пришли пробный пинг».
---

# devping — pings to the phone

A window sends the phone only its name («<folder> @ <machine>» by default) and a kind: «нужен ответ» (a permission prompt or a
question) or «закончил» (waiting for the next word). The service is ntfy, the public ntfy.sh by default. The ping is
this plugin's `Notification` hook: it runs in every window where the plugin is enabled and pings only for a project
that has a topic — so a project is connected by giving it a topic, nothing is written into the project.

## Connect a project

From the project root (in Bash `devping` is on PATH; otherwise `<skill>\scripts\devping.cmd`):

```
devping connect
```

It creates a random topic in the user variable `NTFY_TOPIC_<FOLDER>` (named after the project folder) and sends a
test ping. Show the person the subscription line from the output: they enter the server and the topic in the ntfy
app on the phone. A devping hook an earlier version wrote into the project's `.claude/settings.local.json` is removed
on the way (with the plugin's hook it would ping twice).

If the project is already connected on another machine and the pings should go to the same feed, the person gives
that topic:

```
devping connect --topic <topic>
```

Never invent a topic from another machine or take one from another project — ask.

## The rest

```
devping test                  a test ping with the window name
devping status                what is connected (warns about an old per-project hook)
devping show [WHAT]           what the ping title names: all, project, host or none
devping disconnect            forget the project's topic and title setting: its windows stop pinging
```

## What the title names

The title goes to the ntfy server in plain text; on the public ntfy.sh that is a server nobody of the team runs. It is
set per project, in the user variable `NTFY_SHOW_<FOLDER>`:

```
devping show project          only the folder: «MyGame»
devping show host             only the machine: «WORKSTATION-3»
devping show none             neither: «Claude»
devping show all              both, the default: «MyGame @ WORKSTATION-3»
```

Hide the folder when it is a code name not announced yet; hide the machine when its name tells who or where it is.
Without an argument `devping show` prints the current title. An unknown value set by hand counts as `all`.

A topic set by `connect` is seen at once (the hook reads the registry). The hook is silent on failures; to look into
one — `DEVPING_DEBUG=1`; another ntfy server — `DEVPING_URL`. The topic works like a password: whoever knows it reads
the pings. Never write it anywhere public. Tests: `python <skill>/scripts/tests/pingtest.py` (a local fake ntfy and
registry, nothing on the machine is touched).
