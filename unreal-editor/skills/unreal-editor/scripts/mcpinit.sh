#!/bin/bash
# Opens a fresh MCP session with the editor and says which server answers.
#   mcpinit.sh [--project DIR] [--url URL]
# The session id goes to the state dir (UE_MCP_STATE_DIR, default <temp>/unreal-editor-mcp/sid-<port>.txt),
# where ue.py / raw.py pick it up - never next to this script. ue.py renews a stale session by itself,
# so this is for a first look: "is the MCP server up, and in which mode?"
HERE="$(cd "$(dirname "$0")" && pwd)"
case "$1" in -h|--help) sed -n '2,6p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;; esac
PY=$(command -v python || command -v python3 || command -v py)
[ -z "$PY" ] && { echo "python not found in PATH"; exit 2; }
"$PY" "$HERE/ue.py" --init "$@" || exit $?
"$PY" "$HERE/ue.py" --tools "$@" | head -3
