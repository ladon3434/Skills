#!/bin/bash
# Waits for the editor's MCP server and says what is wrong when it never answers.
#   editor-ready.sh [deadline-seconds] [path-to-log] [--project DIR]
# The URL and the log come from the project (mjs/ue-project.mjs: UE_MCP_URL / UE_MCP_PORT / settings,
# Saved/Logs/<project>.log); the two positional arguments override them.
# Exit 0: the server answered. Exit 1: the deadline passed - the message tells whether the editor is
# still working or standing on a modal window. Exit 2: usage / no project.

HERE="$(cd "$(dirname "$0")" && pwd)"
DEADLINE=""
LOG=""
PROJECT_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    --project) PROJECT_ARGS=(--project "$2"); shift 2 ;;
    *) if [ -z "$DEADLINE" ]; then DEADLINE="$1"; elif [ -z "$LOG" ]; then LOG="$1"; fi; shift ;;
  esac
done
DEADLINE=${DEADLINE:-180}
case "$DEADLINE" in *[!0-9]*|"") echo "deadline must be a number of seconds: $DEADLINE"; exit 2 ;; esac

URL="${UE_MCP_URL:-}"
if [ -z "$URL" ] || [ -z "$LOG" ]; then
  INFO_URL=$(node "$HERE/mjs/ue-project.mjs" "${PROJECT_ARGS[@]}" --field url 2>/dev/null)
  INFO_LOG=$(node "$HERE/mjs/ue-project.mjs" "${PROJECT_ARGS[@]}" --field log 2>/dev/null)
  case "$INFO_URL" in http*) ;; *) echo "no project found (run inside it, or pass --project DIR): $INFO_URL"; exit 2 ;; esac
  URL=${URL:-$INFO_URL}
  LOG=${LOG:-$INFO_LOG}
fi
echo "waiting for $URL (log: $LOG, deadline ${DEADLINE}s)"

start=$(date +%s)
last_size=-1
still_since=$start

while :; do
  code=$(curl -s -m 3 -o /dev/null -w "%{http_code}" "$URL")
  now=$(date +%s)

  if [ "$code" != "000" ]; then
    echo "server up after $((now - start))s (http $code)"
    exit 0
  fi

  size=$(stat -c %s "$LOG" 2>/dev/null || echo 0)
  if [ "$size" != "$last_size" ]; then
    last_size=$size
    still_since=$now
  fi

  if [ $((now - start)) -ge "$DEADLINE" ]; then
    quiet=$((now - still_since))
    echo "server silent after $((now - start))s; log has not grown for ${quiet}s"
    mtime=$(stat -c %Y "$LOG" 2>/dev/null || echo 0)
    if [ "$size" = "0" ]; then
      echo "no log at $LOG - the editor never started (or writes elsewhere: pass the log path)"
    elif [ "$mtime" -lt "$start" ]; then
      echo "the log was last written $((now - mtime))s ago, before this wait began - no editor of this project is running (or it logs elsewhere)"
    elif [ "$quiet" -ge 60 ]; then
      echo "the editor is standing on a modal window - do not relaunch it"
      echo "(also possible: the MCP server is off - bAutoStartServer / -ModelContextProtocolStartServer; grep the log for LogModelContextProtocol)"
    else
      echo "the editor is still working - give it more time"
    fi
    exit 1
  fi

  sleep 5
done
