#!/bin/bash
# Compile the pure version module to CommonJS and run its offline tests
# (scripts/version.test.cjs). Zero test deps.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT=/tmp/version-test
rm -rf "$OUT" && mkdir -p "$OUT"

npx tsc src/lib/version.ts \
  --outDir "$OUT" --module commonjs --target es2022 \
  --moduleResolution node --skipLibCheck --esModuleInterop

VERSION_CJS="$OUT/version.js" node scripts/version.test.cjs
