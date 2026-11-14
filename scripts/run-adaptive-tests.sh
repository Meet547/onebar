#!/bin/bash
# Compile the pure adaptation module to CommonJS and replay the offline
# traces through it (scripts/adaptive.test.cjs). Zero test deps.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT=/tmp/adapt-test
rm -rf "$OUT" && mkdir -p "$OUT"

npx tsc src/lib/call/adaptive.ts src/lib/call/types.ts \
  --outDir "$OUT" --module commonjs --target es2022 \
  --moduleResolution node --skipLibCheck --esModuleInterop

ADAPTIVE_CJS="$OUT/adaptive.js" node scripts/adaptive.test.cjs
