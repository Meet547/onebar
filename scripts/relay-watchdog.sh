#!/bin/bash
# Keeps the signaling relay alive for the whole session: re-checks every 15s
# and restarts it if it died. Runs detached; a sandbox recycle ends it, and
# the next boot's bootstrap-dev.sh starts a fresh one.
set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

while true; do
  bash "$DIR/ensure-relay.sh" || true
  sleep 15
done
