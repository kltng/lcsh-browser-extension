#!/bin/bash
# agent_watchdog.sh — liveness monitor for delegated agent sessions.
#
# Every agent dispatch (codex / agy / opencode) gets a paired watchdog.
# Liveness = recent activity on the agent's signal paths (session logs,
# target write dirs), NOT process existence — stalled agents keep running
# while doing nothing.
#
# Usage:
#   agent_watchdog.sh <pid> <stall_seconds> <label> <watch_path>...
#
# Exit codes:
#   0  agent process exited (normal completion — check its own results)
#   2  STALL: process alive but no activity on any watch path for
#      <stall_seconds>. Caller should kill the agent, diagnose, re-dispatch.
#
# Signal paths per agent (see docs/multi_agent/WORKFLOW.md):
#   codex    ~/.codex/sessions/YYYY/MM/DD  + repo target dirs
#   agy      ~/.gemini/antigravity-cli/log + repo target dirs
#   opencode ~/.local/share/opencode       + deliverable dirs

set -u

PID="$1"
STALL="$2"
LABEL="$3"
shift 3

last_activity=$(date +%s)

while kill -0 "$PID" 2>/dev/null; do
    newest=0
    for path in "$@"; do
        while IFS= read -r f; do
            m=$(stat -f %m "$f" 2>/dev/null) || continue
            [ "$m" -gt "$newest" ] && newest=$m
        done < <(find "$path" -type f -mmin -60 2>/dev/null | head -500)
    done
    now=$(date +%s)
    [ "$newest" -gt "$last_activity" ] && last_activity=$newest
    idle=$((now - last_activity))
    if [ "$idle" -gt "$STALL" ]; then
        echo "WATCHDOG STALL: label=$LABEL pid=$PID idle=${idle}s threshold=${STALL}s"
        echo "Process is alive but produced no activity on watched paths:"
        printf '  %s\n' "$@"
        exit 2
    fi
    sleep 30
done

echo "WATCHDOG DONE: label=$LABEL pid=$PID exited normally after watch."
exit 0
