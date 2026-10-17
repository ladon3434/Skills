"""Talk to the running Unreal editor's MCP server directly over HTTP (the fallback when the
client's own MCP connection dropped after an editor restart).

    python ue.py [--project DIR] [--url URL] [--raw] [--allow-foreign]  < code
                                                                  run python in the editor (VibeUE); only an
                                                                  editor this session started, unless the person
                                                                  allowed --allow-foreign (VibeUE saves every dirty
                                                                  package before running python)
    python ue.py --call <toolset> <tool> [JSON|-]                  one Epic toolset call via call_tool
    python ue.py --tools                                          which server answers, and its tool list
    python ue.py --init                                           fresh MCP session (what mcpinit.sh does)
    --out FILE                                                    write the whole answer to FILE (UTF-8) instead of
                                                                  printing it cut at 8000 characters

The URL comes from UE_MCP_URL, else UE_MCP_PORT, else the project's settings (mjs/ue-project.mjs).
Before the first request the local listener is checked (mjs/ue-owner.mjs port-owner): when the port is
answered by another project's editor, nothing is sent - the call would change that project.
The session id is runtime state and lives in UE_MCP_STATE_DIR (default <temp>/unreal-editor-mcp),
never next to this file. A stale session (editor restarted) is renewed once, automatically.
stdlib only; output is ASCII-safe.
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request

sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
PROTOCOL = "2025-06-18"
PY_TOOL = "execute_python_code"


class McpError(Exception):
    pass


def _state_dir():
    return os.environ.get("UE_MCP_STATE_DIR") or os.path.join(tempfile.gettempdir(), "unreal-editor-mcp")


def resolve_target(project=None, url=None):
    """(url, sid_file). Env and flags first; the project detector only when they say nothing."""
    if url:
        port = url.split(":")[-1].split("/")[0] if ":" in url else "url"
        return url, os.path.join(_state_dir(), "sid-%s.txt" % port)
    if os.environ.get("UE_MCP_URL"):
        return resolve_target(url=os.environ["UE_MCP_URL"])
    if os.environ.get("UE_MCP_PORT") and not project:
        port = os.environ["UE_MCP_PORT"]
        return "http://127.0.0.1:%s/mcp" % port, os.path.join(_state_dir(), "sid-%s.txt" % port)
    cmd = ["node", os.path.join(HERE, "mjs", "ue-project.mjs"), "--json"]
    if project:
        cmd += ["--project", project]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        info = json.loads(out.stdout)
        return info["url"], info["sidFile"]
    except Exception as e:  # node missing, no project: fall back to the engine default, loudly
        sys.stderr.write("ue.py: project detection failed (%s); using http://127.0.0.1:8000/mcp\n" % e)
        return "http://127.0.0.1:8000/mcp", os.path.join(_state_dir(), "sid-8000.txt")


def check_owner(url, project=None, python=False, allow_foreign=False):
    """None when the editor on a local port may be used by this project, else the refusal text.

    Python goes only into an editor this session started, unless allow_foreign: VibeUE saves every dirty
    package of the editor before it runs any python, so a call into a person's editor saves their unsaved work.
    """
    m = re.match(r"https?://(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)", url or "")
    if not m:
        return None
    cmd = ["node", os.path.join(HERE, "mjs", "ue-owner.mjs"), "port-owner", m.group(1)]
    if project:
        cmd += ["--project", project]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.SubprocessError) as e:
        sys.stderr.write("ue.py: cannot check whose editor answers on port %s (%s) - going on unchecked\n" % (m.group(1), e))
        return None
    if out.returncode == 1:
        return (out.stdout or "").strip().replace("REFUSED: ", "", 1)
    state = re.search(r"^ALLOWED: editor pid \d+ \((\w+)", out.stdout or "", re.M)
    if python and state and state.group(1) != "mine" and not allow_foreign:
        return ("%s. This editor was not started by this session, and VibeUE saves EVERY dirty package of it "
                "before running any python - a person's unsaved edits would be saved without asking. Ask the "
                "person first; with their OK pass --allow-foreign. Toolset calls (--call) save nothing and "
                "need no OK." % (out.stdout or "").strip().replace("ALLOWED: ", "", 1))
    return None


def _parse_body(body, content_type):
    if not body:
        return None
    if "text/event-stream" in (content_type or ""):
        msgs, data = [], []
        for line in body.splitlines() + [""]:
            if line.startswith("data:"):
                data.append(line[5:].lstrip(" "))
            elif line == "" and data:
                try:
                    msgs.append(json.loads("\n".join(data)))
                except ValueError:
                    pass
                data = []
        return msgs[-1] if msgs else None
    return json.loads(body)


class Client:
    def __init__(self, url, sid_file, timeout=180):
        self.url, self.sid_file, self.timeout = url, sid_file, timeout
        self.sid = None
        try:
            with open(sid_file) as f:
                self.sid = f.read().strip() or None
        except OSError:
            pass

    def _post(self, payload, timeout=None):
        headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
        if self.sid:
            headers["Mcp-Session-Id"] = self.sid
        req = urllib.request.Request(self.url, data=json.dumps(payload).encode("utf-8"), headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=timeout or self.timeout) as res:
                sid = res.headers.get("Mcp-Session-Id")
                if sid:
                    self.sid = sid
                body = res.read().decode("utf-8", "replace")
                return res.status, _parse_body(body, res.headers.get("Content-Type"))
        except urllib.error.HTTPError as e:
            return e.code, None
        except (urllib.error.URLError, OSError) as e:
            raise McpError("no MCP server at %s (%s) - is the editor up? scripts/editor-ready.sh waits for it" % (self.url, getattr(e, "reason", e)))

    def init(self):
        self.sid = None
        status, msg = self._post({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                                  "params": {"protocolVersion": PROTOCOL, "capabilities": {},
                                             "clientInfo": {"name": "unreal-editor-skill", "version": "1"}}}, timeout=30)
        if status >= 400 or not msg or "error" in msg:
            raise McpError("initialize refused (HTTP %s): %s" % (status, msg))
        self._post({"jsonrpc": "2.0", "method": "notifications/initialized"}, timeout=30)
        if self.sid:
            os.makedirs(os.path.dirname(self.sid_file), exist_ok=True)
            with open(self.sid_file, "w") as f:
                f.write(self.sid)
        return self.sid

    def rpc(self, method, params, timeout=None):
        if not self.sid:
            self.init()
        payload = {"jsonrpc": "2.0", "id": 99, "method": method, "params": params}
        status, msg = self._post(payload, timeout)
        if status in (400, 404):  # stale session id after an editor restart: renew once
            self.init()
            status, msg = self._post(payload, timeout)
        if status >= 400:
            raise McpError("HTTP %s from %s" % (status, self.url))
        return msg

    def tool_names(self):
        msg = self.rpc("tools/list", {}, timeout=60) or {}
        return [t.get("name") for t in (msg.get("result") or {}).get("tools", [])]


def server_kind(names):
    """What answers, from tools/list alone - the runtime twin of ue-project.mjs's offline guess."""
    s = set(names)
    if PY_TOOL in s:
        return "vibeue: execute_python_code is a top-level tool (python with `import unreal` works)"
    if {"list_toolsets", "describe_toolset", "call_tool"} <= s:
        return "epic (tool search): only list_toolsets/describe_toolset/call_tool - no python tool"
    if any("." in n for n in names):
        return "epic (eager): every toolset function is its own tool - no python tool"
    return "unknown server (%d tools)" % len(names)


def _text_of(msg):
    return "".join(c.get("text", "") for c in ((msg or {}).get("result") or {}).get("content", []) if isinstance(c, dict))


def run_python(client, code):
    msg = client.rpc("tools/call", {"name": PY_TOOL, "arguments": {"code": code}})
    if msg is None:
        return {"success": False, "output": "", "error": "empty response from the editor"}, msg
    if "error" in msg:
        err = msg["error"].get("message", str(msg["error"]))
        if "not found" in err.lower() or "unknown tool" in err.lower():
            err += " -- this server has no %s: it is Epic's stock unreal-mcp, not VibeUE (see SKILL.md, the server branch)" % PY_TOOL
        return {"success": False, "output": "", "error": err}, msg
    text = _text_of(msg)
    try:
        return json.loads(text), msg
    except ValueError:
        return {"success": not (msg.get("result") or {}).get("isError"), "output": text, "error": "unparsed"}, msg


def call_tool(client, toolset, tool, args):
    return client.rpc("tools/call", {"name": "call_tool",
                                     "arguments": {"toolset_name": toolset, "tool_name": tool, "arguments": args}})


OUT_FILE = None


def _out(s, limit=8000):
    if OUT_FILE:
        with open(OUT_FILE, "a", encoding="utf-8") as f:
            f.write(s + "\n")
        sys.stdout.write("written %d chars to %s\n" % (len(s), OUT_FILE))
        return
    s = s if len(s) <= limit else s[:limit] + "\n... (%d more chars; --out FILE keeps all of it)" % (len(s) - limit)
    sys.stdout.write(s.encode("ascii", "backslashreplace").decode("ascii") + "\n")


def main(argv, raw=False):
    def opt(name):
        if name in argv:
            i = argv.index(name)
            val = argv[i + 1] if i + 1 < len(argv) else None
            del argv[i:i + 2]
            return val
        return None

    if "-h" in argv or "--help" in argv:
        _out(__doc__.strip())
        return 0
    project, url = opt("--project"), opt("--url")
    if "--raw" in argv:
        argv.remove("--raw")
        raw = True
    global OUT_FILE
    OUT_FILE = opt("--out")
    if OUT_FILE:
        open(OUT_FILE, "w", encoding="utf-8").close()
    allow_foreign = "--allow-foreign" in argv
    if allow_foreign:
        argv.remove("--allow-foreign")
    url, sid_file = resolve_target(project, url)
    python = not any(a in argv for a in ("--init", "--tools", "--call"))
    refused = check_owner(url, project, python=python, allow_foreign=allow_foreign)
    if refused:
        _out("ERROR: %s" % refused)
        return 2
    client = Client(url, sid_file)
    try:
        if "--init" in argv:
            _out("session: %s  (%s, saved to %s)" % (client.init(), url, sid_file))
            return 0
        if "--tools" in argv:
            names = client.tool_names()
            _out("%s\n%s\n%s" % (url, server_kind(names), "\n".join("  " + n for n in names)))
            return 0
        if "--call" in argv:
            i = argv.index("--call")
            toolset, tool = argv[i + 1], argv[i + 2]
            arg = argv[i + 3] if len(argv) > i + 3 else "{}"
            args = json.loads(sys.stdin.read() if arg == "-" else arg)
            msg = call_tool(client, toolset, tool, args)
            _out(json.dumps(msg) if raw else (_text_of(msg) or json.dumps(msg)))
            return 1 if (msg or {}).get("error") or ((msg or {}).get("result") or {}).get("isError") else 0
        code = sys.stdin.read()
        result, msg = run_python(client, code)
        if raw:
            _out(json.dumps(msg))
            return 0
        _out("success: %s" % result.get("success"))
        _out(result.get("output") or "")
        if result.get("error"):
            _out("error: %s" % result.get("error"), 2000)
        return 0 if result.get("success") else 1
    except McpError as e:
        _out("ERROR: %s" % e)
        return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
