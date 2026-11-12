#!/bin/bash
# Dev bootstrap: supervise the signaling relay, then run the Next.js dev
# server exactly like the platform expects (port 3000, tee dev.log).
# The platform runs `bun run dev`, which lands here — so a sandbox boot
# always comes up with BOTH the app and the call relay.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Long-lived keeper (its own detached loop; never blocks the dev server)
if [ "${PICO_RELAY_WATCHDOG:-1}" = "1" ]; then
  nohup bash scripts/relay-watchdog.sh >> mini-services/signaling/watchdog.log 2>&1 &
  disown
fi

# First start, synchronously, so the relay is up before the UI loads
bash scripts/ensure-relay.sh || true

exec next dev -p 3000 2>&1 | tee dev.log
