#!/bin/bash
# Cold first-load transfer size, measured through a REAL Caddy with the
# production encode chain (origin gets `Accept-Encoding: identity` so Caddy
# itself does the encoding), for Brotli and gzip separately.
#
# Encoding fidelity note: production builds Caddy WITH brotli
# (deploy/Dockerfile.caddy → caddy-brotli). The sandbox caddy build has
# gzip+zstd but no brotli encoder, so here:
#   - gzip  → REAL wire bytes through Caddy's encoder
#   - brotli → the same identity payloads re-encoded with the brotli codec
#     (Node zlib, quality 6). Same algorithm as the caddy-brotli plugin;
#     wire sizes may differ slightly with the plugin's quality setting.
# Complements measure-shell.sh (origin-side gzip).
set -euo pipefail
cd "$(dirname "$0")/.."

ORIGIN_PORT=3111
CADDY_PORT=8090
TMP=/tmp/compress-measure
mkdir -p "$TMP"

cleanup() {
  for p in $ORIGIN_PORT $CADDY_PORT; do
    pid=$(ss -ltnp 2>/dev/null | grep ":$p " | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
    [ -n "${pid:-}" ] && kill "$pid" 2>/dev/null
  done
  [ -n "${CADDY_PID:-}" ] && kill "$CADDY_PID" 2>/dev/null
}
trap cleanup EXIT
cleanup 2>/dev/null || true

# 1. Origin: the production standalone build (serves identity upstream here).
PORT=$ORIGIN_PORT PICO_EMBEDDED_RELAY=0 npx next start -p $ORIGIN_PORT \
  > /tmp/compress-origin.log 2>&1 &
for i in $(seq 1 30); do
  curl -s -o /dev/null "http://127.0.0.1:$ORIGIN_PORT/" && break
  sleep 1
done

# 2. Caddy front: production encode chain minus brotli (sandbox limitation,
#    see header note).
cat > "$TMP/caddyfile" <<EOF
{
	admin off
	auto_https off
	http_port $CADDY_PORT
}
:8090 {
	encode zstd gzip
	reverse_proxy 127.0.0.1:$ORIGIN_PORT {
		header_up Accept-Encoding identity
	}
}
EOF
CADDY_BIN=/tmp/caddytest/caddy
[ -x "$CADDY_BIN" ] || CADDY_BIN=caddy
$CADDY_BIN validate --config "$TMP/caddyfile" > /dev/null 2>&1 \
  || { echo "FAIL: caddy config invalid"; exit 1; }
$CADDY_BIN run --config "$TMP/caddyfile" > /tmp/compress-caddy.log 2>&1 &
CADDY_PID=$!
sleep 3

# 3. Cold asset set from the rendered home page.
curl -s "http://127.0.0.1:$CADDY_PORT/" > "$TMP/home.html"
ASSETS=$(python3 - "$TMP/home.html" <<'PY'
import re, sys
html = open(sys.argv[1]).read()
urls = re.findall(r'(?:src|href)="(/[^"]+)"', html)
keep = [u for u in urls if u.startswith('/_next/')
        or u.endswith(('.css', '.js', '.png', '.webmanifest', '.ico'))]
seen, out = set(), []
for u in keep:
    u = u.split('?')[0]
    if u not in seen:
        seen.add(u); out.append(u)
print('\n'.join(out))
PY
)

brlen() { # brotli quality 6 length of a raw file
  node -e "const z=require('zlib'),fs=require('fs');const b=fs.readFileSync('$1');console.log(z.brotliCompressSync(b,{params:{[z.constants.BROTLI_PARAM_QUALITY]:6}}).length)"
}

echo "=== BROTLI (simulated: brotli q6 on identity payloads; see header note) ==="
total=0; n=0
b=$(curl -s -H 'Accept-Encoding: identity' -o "$TMP/a.bin" -w '%{size_download}' "http://127.0.0.1:$CADDY_PORT/")
printf '  %-46s %8s → %8s br bytes\n' '(HTML)' "$b" "$(brlen "$TMP/a.bin")"
total=$(brlen "$TMP/a.bin")
while IFS= read -r asset; do
  [ -z "$asset" ] && continue
  raw=$(curl -s -H 'Accept-Encoding: identity' -o "$TMP/a.bin" -w '%{size_download}' "http://127.0.0.1:$CADDY_PORT$asset")
  br=$(brlen "$TMP/a.bin")
  printf '  %-46s %8s → %8s br bytes\n' "$asset" "$raw" "$br"
  total=$((total + br)); n=$((n + 1))
done <<< "$ASSETS"
echo "  TOTAL (br): $total bytes  (HTML + $n assets)"
BR_TOTAL=$total

echo
echo "=== GZIP (real: Caddy encoder on the wire) ==="
total=0; n=0
g=$(curl -s -H 'Accept-Encoding: gzip' -o /dev/null -w '%{size_download}' "http://127.0.0.1:$CADDY_PORT/")
ge=$(curl -s -I -H 'Accept-Encoding: gzip' "http://127.0.0.1:$CADDY_PORT/" | tr -d '\r' | awk 'tolower($1)=="content-encoding:"{print $2}')
printf '  %-46s %8s bytes  (%s)\n' '(HTML)' "$g" "${ge:-identity}"
total=$g
while IFS= read -r asset; do
  [ -z "$asset" ] && continue
  bytes=$(curl -s -H 'Accept-Encoding: gzip' -o /dev/null -w '%{size_download}' "http://127.0.0.1:$CADDY_PORT$asset")
  aenc=$(curl -s -I -H 'Accept-Encoding: gzip' "http://127.0.0.1:$CADDY_PORT$asset" | tr -d '\r' | awk 'tolower($1)=="content-encoding:"{print $2}')
  printf '  %-46s %8s bytes  (%s)\n' "$asset" "$bytes" "${aenc:-identity}"
  total=$((total + bytes)); n=$((n + 1))
done <<< "$ASSETS"
echo "  TOTAL (gzip): $total bytes  (HTML + $n assets)"
echo
echo "SUMMARY: brotli(sim q6)=$BR_TOTAL  gzip(real)=$total"
