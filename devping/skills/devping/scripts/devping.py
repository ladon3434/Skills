#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""devping - pings to the phone from Claude Code windows through ntfy.

    devping connect [--topic T]   connect the project (current folder or --project): its topic
    devping test                  send a test ping with the window name
    devping status                what is connected for the project
    devping show [WHAT]           what the ping title names for the project: all, project, host or none
    devping disconnect            forget the project's topic and title setting: its windows stop pinging
    devping hook                  the Notification hook itself, payload on stdin

A ping carries only the window name ("<folder> @ <machine>" by default) and its kind: «нужен ответ» (a permission prompt or a
question) or «закончил» (waiting for the next word). The topic lives in a user environment variable named after the
project folder: MyGame -> NTFY_TOPIC_MYGAME. The hook is the devping plugin's own Notification hook: it runs in every
window where the plugin is enabled and pings only for a project that has a topic. Nothing is written into a project.

What the title names is set per project in NTFY_SHOW_<FOLDER>: all (folder and machine, the default), project, host
or none. The public server sees the title in plain text, so a project whose folder is an unannounced code name hides it.

The hook is silent on any failure: no topic, no network - the window is never held up.
DEVPING_DEBUG=1 writes every decision to stderr.
"""

import argparse
import base64
import copy
import json
import os
import re
import shutil
import socket
import sys
import urllib.request

MARK = "devping"                       # how an old per-project hook entry is recognised
VAR_PREFIX = "NTFY_TOPIC_"
SHOW_PREFIX = "NTFY_SHOW_"
SHOW_CHOICES = ("all", "project", "host", "none")
SHOW_DEFAULT = "all"
DEFAULT_URL = "https://ntfy.sh"
# A short topic on the public server is easy to guess, and whoever guesses it reads every ping.
TOPIC_RE = re.compile(r"^[A-Za-z0-9_-]{16,64}$")
DEBUG = os.environ.get("DEVPING_DEBUG") == "1"

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass


def debug(msg):
    if DEBUG:
        sys.stderr.write("[devping] %s\n" % msg)


# ------------------------------------------------------------------ names

def _key(project_dir):
    folder = os.path.basename(os.path.normpath(project_dir))
    return re.sub(r"[^A-Z0-9]+", "_", folder.upper()).strip("_") or "PROJECT"


def var_name(project_dir):
    """Variable name from the folder name: MyGame -> NTFY_TOPIC_MYGAME."""
    return VAR_PREFIX + _key(project_dir)


def show_var_name(project_dir):
    """The project's title setting: MyGame -> NTFY_SHOW_MYGAME."""
    return SHOW_PREFIX + _key(project_dir)


def show_of(project_dir):
    """What the title names for the project; an unset or unknown value is the default, so a typo never blocks a ping."""
    value = get_var(show_var_name(project_dir)).lower()
    return value if value in SHOW_CHOICES else SHOW_DEFAULT


def window_name(project_dir):
    show = show_of(project_dir)
    folder = os.path.basename(os.path.normpath(project_dir)) or "Claude"
    host = os.environ.get("COMPUTERNAME") or socket.gethostname() or "?"
    if show == "project":
        return folder
    if show == "host":
        return host
    if show == "none":
        return "Claude"
    return "%s @ %s" % (folder, host)


def new_topic():
    return "ping-" + base64.urlsafe_b64encode(os.urandom(16)).decode().rstrip("=")


# -------------------------------------------------------------- variables
# A user variable lives in HKCU\Environment. Tests replace the store with a file (DEVPING_STORE) so the machine's
# registry is never touched.

def _store_path():
    return os.environ.get("DEVPING_STORE")


def _store_load():
    try:
        with open(_store_path(), encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


def _store_save(data):
    with open(_store_path(), "w", encoding="utf-8") as fh:
        json.dump(data, fh)


def get_var(name):
    """The process environment first, then the registry: a window opened before connect pings too, no restart."""
    own = os.environ.get(name, "").strip()
    if own:
        return own
    if _store_path():
        return str(_store_load().get(name, "")).strip()
    if sys.platform != "win32":
        return ""
    import winreg
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment") as k:
            return str(winreg.QueryValueEx(k, name)[0]).strip()
    except OSError:
        return ""


def _broadcast_env_change():
    """Tell Explorer the environment changed: new shells see the variable without a re-login."""
    try:
        import ctypes
        HWND_BROADCAST, WM_SETTINGCHANGE, SMTO_ABORTIFHUNG = 0xFFFF, 0x1A, 0x2
        ctypes.windll.user32.SendMessageTimeoutW(
            HWND_BROADCAST, WM_SETTINGCHANGE, 0, "Environment",
            SMTO_ABORTIFHUNG, 2000, ctypes.byref(ctypes.c_ulong()))
    except Exception:
        pass


def set_var(name, value):
    if _store_path():
        data = _store_load()
        if value is None:
            data.pop(name, None)
        else:
            data[name] = value
        _store_save(data)
        return
    if sys.platform != "win32":
        raise SystemExit("a user variable is written on Windows only; set %s by hand" % name)
    import winreg
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment", 0, winreg.KEY_SET_VALUE) as k:
        if value is None:
            try:
                winreg.DeleteValue(k, name)
            except OSError:
                pass
        else:
            winreg.SetValueEx(k, name, 0, winreg.REG_SZ, value)
    _broadcast_env_change()


# ------------------------------------------- the old per-project hook (before the plugin)

def settings_path(project_dir):
    return os.path.join(project_dir, ".claude", "settings.local.json")


def load_json(path):
    if not os.path.exists(path):
        return {}
    try:
        with open(path, encoding="utf-8-sig") as fh:
            return json.load(fh)
    except ValueError:
        raise SystemExit("cannot parse JSON: %s - fix it by hand" % path)


def save_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if os.path.exists(path):
        shutil.copyfile(path, path + ".devping-bak")
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    os.replace(tmp, path)


def unwire_legacy(project_dir):
    """Remove a devping entry an earlier version wrote into the project's hooks.Notification - with the plugin's hook
    it would ping twice. Other hooks are left alone. True when the file changed."""
    path = settings_path(project_dir)
    if not os.path.exists(path):
        return False
    cfg = load_json(path)
    before = copy.deepcopy(cfg)
    hooks = cfg.get("hooks") or {}
    groups = hooks.get("Notification") or []
    for g in list(groups):
        inner = g.get("hooks") or []
        keep = [h for h in inner if MARK not in str(h.get("command", ""))]
        if len(keep) != len(inner):
            if keep:
                g["hooks"] = keep
            else:
                groups.remove(g)
    if "Notification" in hooks and not groups:
        hooks.pop("Notification")
    if "hooks" in cfg and not hooks:
        cfg.pop("hooks")
    if cfg == before:
        return False
    save_json(path, cfg)
    return True


def has_legacy(project_dir):
    cfg = load_json(settings_path(project_dir))
    return any(MARK in str(h.get("command", ""))
               for g in (cfg.get("hooks") or {}).get("Notification") or []
               for h in g.get("hooks") or [])


# ------------------------------------------------------------------ send

def server_url():
    return (os.environ.get("DEVPING_URL") or get_var("DEVPING_URL") or DEFAULT_URL).rstrip("/")


def publish(topic, title, message, priority, tag):
    body = json.dumps({"topic": topic, "title": title, "message": message,
                       "priority": priority, "tags": [tag]}).encode("utf-8")
    req = urllib.request.Request(server_url() + "/", data=body, method="POST",
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=6) as res:
        debug("'%s' -> %s: HTTP %s" % (title, server_url(), res.status))
        return 200 <= res.status < 300


# Claude Code notification types: idle_prompt - done and waiting; permission_prompt and elicitation_dialog - waiting
# for an answer; auth_success - not a reason. The labels are what the phone shows.
DONE = ("закончил", 3, "white_check_mark")
NEED = ("нужен ответ", 4, "raising_hand")


def classify(kind):
    if kind == "idle_prompt":
        return DONE
    if kind == "auth_success":
        return None
    return NEED


def project_of(payload):
    return os.environ.get("CLAUDE_PROJECT_DIR") or payload.get("cwd") or os.getcwd()


def cmd_hook(_args):
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except ValueError:
        return 0
    try:
        kind = str(payload.get("notification_type") or "")
        what = classify(kind)
        if what is None:
            debug("type %s - no reason" % kind)
            return 0
        project = project_of(payload)
        name = var_name(project)
        topic = get_var(name)
        if not TOPIC_RE.match(topic):
            debug("no %s - nothing sent" % name)
            return 0
        label, priority, tag = what
        publish(topic, window_name(project), label, priority, tag)
    except Exception as e:                     # the hook never gets in the window's way
        debug("failure: %s" % e)
    return 0


# --------------------------------------------------------------- commands

def project_dir(args):
    return os.path.abspath(args.project or os.getcwd())


def subscribe_hint(topic):
    return "Subscribe in the ntfy app: server %s, topic %s" % (server_url(), topic)


def cmd_connect(args):
    project = project_dir(args)
    name = var_name(project)
    have = get_var(name)
    topic = args.topic or have or new_topic()
    if not TOPIC_RE.match(topic):
        raise SystemExit("a topic is 16-64 characters of letters, digits, - and _")
    if topic != have:
        set_var(name, topic)
        print("  ok   %s = %s" % (name, topic))
    else:
        print("  ok   %s already set" % name)
    if unwire_legacy(project):
        print("  ok   old per-project hook removed from %s (the plugin's hook pings now)" % settings_path(project))
    print("       " + subscribe_hint(topic))
    print("       On another machine: devping connect --topic %s" % topic)
    if not args.no_test:
        return send_test(project, topic)
    return 0


def send_test(project, topic):
    title = window_name(project)
    try:
        ok = publish(topic, title, "проверка - пинги подключены", 3, "bell")
    except Exception as e:
        print("  !!   not sent: %s" % e)
        return 1
    print("  %s   test ping '%s'" % ("ok" if ok else "!!", title))
    return 0 if ok else 1


def cmd_test(args):
    project = project_dir(args)
    topic = get_var(var_name(project))
    if not TOPIC_RE.match(topic):
        print("  !!   project not connected: devping connect")
        return 1
    return send_test(project, topic)


def cmd_status(args):
    project = project_dir(args)
    name = var_name(project)
    topic = get_var(name)
    print("project:   %s" % project)
    print("window:    %s (%s = %s)" % (window_name(project), show_var_name(project), show_of(project)))
    print("variable:  %s = %s" % (name, topic or "(none)"))
    print("server:    %s" % server_url())
    if has_legacy(project):
        print("WARNING:   an old per-project hook is still in %s - pings would come twice; "
              "devping connect removes it" % settings_path(project))
    return 0 if topic else 1


def cmd_disconnect(args):
    project = project_dir(args)
    if unwire_legacy(project):
        print("  ok   old per-project hook removed")
    set_var(var_name(project), None)
    set_var(show_var_name(project), None)
    print("  ok   %s forgotten - this project's windows stop pinging" % var_name(project))
    return 0


def cmd_show(args):
    project = project_dir(args)
    name = show_var_name(project)
    if args.what:
        # The default is stored as no variable at all, so the registry holds only what differs from it.
        set_var(name, None if args.what == SHOW_DEFAULT else args.what)
        print("  ok   %s = %s" % (name, args.what))
    print("       the ping title: %s" % window_name(project))
    return 0


def main(argv=None):
    p = argparse.ArgumentParser(prog="devping", description=__doc__.split("\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("connect", help="connect the project")
    c.add_argument("--topic", help="take an existing topic (from another machine)")
    c.add_argument("--no-test", action="store_true", help="no test ping")
    for name in ("test", "status"):
        sub.add_parser(name)
    d = sub.add_parser("disconnect", help="forget the project's topic")
    d.add_argument("--forget", action="store_true", help=argparse.SUPPRESS)  # accepted for old habits
    s = sub.add_parser("show", help="what the ping title names for the project")
    s.add_argument("what", nargs="?", choices=SHOW_CHOICES,
                   help="all - folder and machine (default), project, host, none")
    sub.add_parser("hook", help="the Notification hook (stdin)")
    for sp in sub.choices.values():
        sp.add_argument("--project", help="project folder (default: current)")
    args = p.parse_args(argv)
    return {"connect": cmd_connect, "test": cmd_test, "status": cmd_status,
            "disconnect": cmd_disconnect, "show": cmd_show, "hook": cmd_hook}[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())
