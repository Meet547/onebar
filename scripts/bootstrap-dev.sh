#!/bin/bash
# Dev bootstrap: run the Next.js dev server exactly like the platform expects
# (port 3000, tee dev.log).
#
# The signaling relay is EMBEDDED in the Next.js server itself
# (src/lib/relay-server.ts, booted by src/instrumentation.ts) and supervised
# by the keeper in src/lib/ensure-relay.ts. There is deliberately NO second
# process to babysit here anymore: a production standalone build and the dev
# server run the exact same relay code, so what you test is what you ship.
#
# (mini-services/signaling still exists for the Docker topology, where the
# relay runs as its own container — see docker-compose.yml + DEPLOY.md.)
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

exec next dev -p 3000 2>&1 | tee dev.log
