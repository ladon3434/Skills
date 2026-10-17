# -*- coding: utf-8 -*-
"""End to end: connect, the hook on every notification type, an old per-project hook removed, disconnect.

ntfy is a local HTTP server, the registry a file (DEVPING_STORE), the project a temp folder. Neither the machine's
registry nor the network is touched.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

D = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PING = os.path.join(D, "devping.py")

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

GOT = []


class Ntfy(BaseHTTPRequestHandler):
    def do_POST(self):
        GOT.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"{}")

    def log_message(self, *a):
        pass


srv = HTTPServer(("127.0.0.1", 0), Ntfy)
threading.Thread(target=srv.serve_forever, daemon=True).start()

TMP = tempfile.mkdtemp(prefix="devping-test-")
PROJECT = os.path.join(TMP, "My Game-2")
os.makedirs(os.path.join(PROJECT, ".claude"))
# A foreign hook plus an old devping entry from before the plugin: the old one goes, the foreign one stays.
with open(os.path.join(PROJECT, ".claude", "settings.local.json"), "w") as fh:
    json.dump({"hooks": {"Notification": [{"hooks": [{"type": "command", "command": "echo other"}]},
                                          {"hooks": [{"type": "command", "command": 'python "C:/x/devping.py" hook'}]}]},
               "permissions": {"allow": ["Bash(ls)"]}}, fh)

ENV = dict(os.environ, DEVPING_STORE=os.path.join(TMP, "store.json"),
           DEVPING_URL="http://127.0.0.1:%d" % srv.server_port, COMPUTERNAME="TESTBOX")
ENV.pop("NTFY_TOPIC_MY_GAME_2", None)
ENV.pop("CLAUDE_PROJECT_DIR", None)

FAILS = 0


def check(label, ok, extra=""):
    global FAILS
    FAILS += 0 if ok else 1
    print("[%s] %s%s" % ("OK " if ok else "FAIL", label, (" - " + extra) if extra and not ok else ""))


def run(*args, stdin=None, env=None):
    r = subprocess.run([sys.executable, PING] + list(args), cwd=PROJECT,
                       input=(stdin or "").encode("utf-8"), capture_output=True, env=env or ENV)
    return r.returncode, r.stdout.decode("utf-8", "replace") + r.stderr.decode("utf-8", "replace")


def settings():
    with open(os.path.join(PROJECT, ".claude", "settings.local.json"), encoding="utf-8") as fh:
        return json.load(fh)


def store():
    with open(ENV["DEVPING_STORE"], encoding="utf-8") as fh:
        return json.load(fh)


try:
    # --- connect
    rc, out = run("connect")
    check("connect: exit 0", rc == 0, out)
    topic = store().get("NTFY_TOPIC_MY_GAME_2", "")
    check("topic in the variable named after the folder", topic.startswith("ping-") and len(topic) >= 16, str(store()))
    cmds = [h["command"] for g in settings()["hooks"]["Notification"] for h in g["hooks"]]
    check("old per-project hook removed, the foreign one kept", cmds == ["echo other"], str(cmds))
    check("other settings kept", settings().get("permissions") == {"allow": ["Bash(ls)"]})
    check("test ping carries the window name", GOT and GOT[-1]["title"] == "My Game-2 @ TESTBOX"
          and GOT[-1]["topic"] == topic, str(GOT))

    # --- a second connect keeps the topic and writes nothing
    run("connect", "--no-test")
    check("second connect: same topic", store()["NTFY_TOPIC_MY_GAME_2"] == topic)
    check("second connect: no hook written", [h["command"] for g in settings()["hooks"]["Notification"] for h in g["hooks"]] == ["echo other"])

    # --- the hook: every notification type
    hook_env = dict(ENV, CLAUDE_PROJECT_DIR=PROJECT)
    for kind, want in (("idle_prompt", "закончил"), ("permission_prompt", "нужен ответ"),
                       ("elicitation_dialog", "нужен ответ"), ("auth_success", None)):
        before = len(GOT)
        rc, out = run("hook", stdin=json.dumps({"session_id": "s1", "notification_type": kind,
                                                 "message": "secret text"}), env=hook_env)
        sent = GOT[before:]
        if want is None:
            check("hook %s: silent" % kind, rc == 0 and not sent, str(sent))
        else:
            ok = rc == 0 and len(sent) == 1 and sent[0]["message"] == want \
                and sent[0]["title"] == "My Game-2 @ TESTBOX" and "secret" not in json.dumps(sent[0], ensure_ascii=False)
            check("hook %s: '%s', only the name and the kind" % (kind, want), ok, str(sent))

    # --- a project without a topic: silent, no failure (the plugin hook runs in every window)
    before = len(GOT)
    other = os.path.join(TMP, "Unconnected")
    os.makedirs(other)
    rc, _ = run("hook", stdin=json.dumps({"notification_type": "idle_prompt"}), env=dict(ENV, CLAUDE_PROJECT_DIR=other))
    check("hook without a topic: silent, exit 0", rc == 0 and len(GOT) == before)

    # --- a dead server does not fail the hook
    rc, _ = run("hook", stdin=json.dumps({"notification_type": "idle_prompt"}),
                env=dict(hook_env, DEVPING_URL="http://127.0.0.1:1"))
    check("hook without network: exit 0", rc == 0)

    # --- a second machine takes the same topic
    store_b = os.path.join(TMP, "store-b.json")
    rc, _ = run("connect", "--topic", topic, "--no-test", env=dict(ENV, DEVPING_STORE=store_b))
    with open(store_b, encoding="utf-8") as fh:
        check("connect --topic: same topic", json.load(fh).get("NTFY_TOPIC_MY_GAME_2") == topic)
    rc, _ = run("connect", "--topic", "short", "--no-test")
    check("connect --topic: short topic refused", rc != 0)

    # --- disconnect
    rc, _ = run("disconnect")
    check("disconnect: topic forgotten", rc == 0 and "NTFY_TOPIC_MY_GAME_2" not in store())
    before = len(GOT)
    run("hook", stdin=json.dumps({"notification_type": "idle_prompt"}), env=hook_env)
    check("after disconnect the hook is silent", len(GOT) == before)
finally:
    srv.shutdown()
    shutil.rmtree(TMP, ignore_errors=True)

print("\n%s" % ("ALL GREEN" if not FAILS else "FAILS: %d" % FAILS))
sys.exit(1 if FAILS else 0)
