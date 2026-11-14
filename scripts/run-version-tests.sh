#!/bin/bash
# Compile the pure modules (version handshake + field report) to CommonJS and
# run their offline tests. Zero test deps.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT=/tmp/version-test
rm -rf "$OUT" && mkdir -p "$OUT"

npx tsc src/lib/version.ts src/lib/call/field-report.ts \
  --outDir "$OUT" --module commonjs --target es2022 \
  --moduleResolution node --skipLibCheck --esModuleInterop

VERSION_CJS="$OUT/version.js" node scripts/version.test.cjs
VERSION_CJS="$OUT/version.js" REPORT_CJS="$OUT/call/field-report.js" node scripts/field-report.test.cjs
