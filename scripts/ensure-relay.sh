#!/bin/bash
# Starts the Pico signaling relay if (and only if) both its ports are down.
# Safe to call repeatedly: a healthy relay is left untouched, a partially
# dead one (one port bound, the other gone) is restarted cleanly.
# Used by scripts/bootstrap-dev.sh and scripts/relay-watchdog.sh.
set -u

PORT=3003
INFO_PORT=3004
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../mini-services/signaling" && pwd)"
LOG="$DIR/relay.log"

up() { ss -tln 2>/dev/null | grep -q ":$1 "; }

if up "$PORT" && up "$INFO_PORT"; then
  exit 0
fi

# Partial state — clear whatever is still bound so the fresh start binds both.
pids="$(ss -tlnp 2>/dev/null | grep -E ":(3003|3004) " | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u)"
for p in $pids; do kill "$p" 2>/dev/null || true; done
[ -n "$pids" ] && sleep 1

echo "[ensure-relay] $(date '+%H:%M:%S') starting relay in $DIR"
cd "$DIR"
# Ports are pinned in the env: the Next.js server exports PORT for its own
# port, and an inherited PORT would send the relay to the wrong one.
PORT=3003 INFO_PORT=3004 nohup bun run dev >> "$LOG" 2>&1 &
disown

for _ in $(seq 1 24); do
  if up "$PORT" && up "$INFO_PORT"; then
    echo "[ensure-relay] relay is up on :$PORT/:$INFO_PORT"
    exit 0
  fi
  sleep 0.5
done

echo "[ensure-relay] relay failed to start — see $LOG" >&2
exit 1
