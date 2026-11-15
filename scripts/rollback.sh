#!/usr/bin/env bash
# Roll the Pico deployment back to a previous build. Requires a
# .deploy-history file (one "<iso-ts> <version> <commit>" line per deploy —
# written automatically by scripts/deploy.sh).
#
# Usage:  scripts/rollback.sh [steps]      (default 1 = previous deploy)
#
# The old commit is checked out and rebuilt with ITS original PICO_VERSION
# stamp, so clients see the old version again, the one-shot auto-reload
# fires, and the service worker keeps the previous version's cache warm
# (per-version pruning keeps current + previous by design — rollback is the
# reason why).
set -euo pipefail
cd "$(dirname "$0")/.."

STEPS="${1:-1}"
HIST=.deploy-history
if [ ! -f "$HIST" ]; then
  echo "no $HIST — deploy with scripts/deploy.sh (it records every version)"
  exit 2
fi
LINE=$(tail -n "$STEPS" "$HIST" | head -n 1)
COMMIT=$(echo "$LINE" | awk '{print $3}')
VERSION=$(echo "$LINE" | awk '{print $2}')
if [ -z "$COMMIT" ] || [ -z "$VERSION" ]; then
  echo "bad history line: '$LINE'"
  exit 2
fi

echo ">> rolling back to version=$VERSION (commit $COMMIT)"
PREV_REF=$(git rev-parse --abbrev-ref HEAD)
git checkout "$COMMIT"
PICO_VERSION="$VERSION" docker compose up -d --build
git checkout "$PREV_REF"
echo ">> rolled back. Verify with:"
echo "   bash scripts/check-live.sh <domain> \$HEALTH_TOKEN   # x-pico-version must be $VERSION"
