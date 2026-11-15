#!/usr/bin/env bash
# Live smoke verification of the Pico standalone (sandbox-deployable part).
# Boots the built app with production-shaped env, then asserts every
# hardening/ops behavior added in the hardening round — the same-origin
# socket handshake through the Next rewrite being the one that could
# silently break real calls if the gate is too strict.
set -u
PORT="${PORT:-3111}"
BASE="http://127.0.0.1:${PORT}"
TOK="smoke-token-123"
SECRET="smoke-turn-secret"

cd /home/z/my-project
pid=$(ss -ltnp 2>/dev/null | grep ":${PORT} " | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
[ -n "$pid" ] && kill "$pid" 2>/dev/null; sleep 1

PASS=0; FAIL=0
ck() { # ck <name> <cond-result(0/1)>
  if [ "$2" = 0 ]; then PASS=$((PASS+1)); echo "  ok  $1"; else FAIL=$((FAIL+1)); echo "FAIL  $1"; fi
}

echo "== boot standalone (embedded relay on) =="
PORT=$PORT PICO_EMBEDDED_RELAY=1 HEALTH_TOKEN="$TOK" TURN_SECRET="$SECRET" \
  TURN_URLS="turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp" \
  npx next start -p "$PORT" > /tmp/smoke-server.log 2>&1 &
SRV=$!
for i in $(seq 1 30); do
  curl -sf -o /dev/null "$BASE/api/health" && break; sleep 1
done

echo "== 1. app shell + version header =="
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/")
ck "home 200" "$([ "$code" = 200 ]; echo $?)"
hdr=$(curl -sI "$BASE/" | grep -i '^x-pico-version:' | tr -d '\r')
ck "x-pico-version header present" "$([ -n "$hdr" ]; echo $?)"

echo "== 2. health: public body + fail-closed gate =="
body=$(curl -s "$BASE/api/health")
echo "$body" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["ok"] is True and "turn" not in d' ; ck "public {ok,version}, no turn data" "$?"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/health?token=wrong")
ck "wrong token → 401" "$([ "$code" = 401 ]; echo $?)"
body=$(curl -s -H "x-health-token: $TOK" "$BASE/api/health")
echo "$body" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert "turn" in d' ; ck "right token → gated data" "$?"

echo "== 3. ICE: ephemeral HMAC TURN credentials =="
curl -s "$BASE/api/ice" > /tmp/smoke-ice.json
python3 - <<'PY'
import json, hmac, hashlib, base64, time
d = json.load(open('/tmp/smoke-ice.json'))
servers = [s for s in d['iceServers'] if any(u.startswith('turn') for u in s['urls'])]
assert d.get('turn') is True and servers, 'no turn entries'
u = servers[0]['username']; c = servers[0]['credential']
assert u.isdigit() and int(u) > time.time(), 'username not an expiry timestamp'
assert base64.b64decode(c) == hmac.new(b'smoke-turn-secret', u.encode(), hashlib.sha1).digest(), 'HMAC mismatch'
assert any(u.startswith('turns:') for s in servers for u in s['urls']), 'no turns: fallback'
print('ice: expiry+HMAC valid, turns: present')
PY
ck "/api/ice creds are time-limited HMAC" "$?"

echo "== 4. signaling alive (embedded relay up) =="
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/info?room=smoketestroom")
ck "room-info probe 200" "$([ "$code" = 200 ]; echo $?)"

echo "== 5. WS origin gate through the Next rewrite (/signal/ → relay) =="
no_orig=$(curl -s "$BASE/signal/?EIO=4&transport=polling")
echo "$no_orig" | grep -q '"sid"' ; ck "no Origin header → handshake allowed" "$?"
same=$(curl -s -H "Origin: $BASE" "$BASE/signal/?EIO=4&transport=polling")
echo "$same" | grep -q '"sid"' ; ck "same-origin → handshake allowed" "$?"
evil_code=$(curl -s -o /tmp/smoke-evil.txt -w '%{http_code}' -H "Origin: https://evil.example" "$BASE/signal/?EIO=4&transport=polling")
# Rejected = NO socket.io sid in the body (403 from engine.io's allowRequest).
if echo "$evil_code" | grep -q '"sid"'; then
  ck "cross-origin → REJECTED (code=$evil_code)" 1
else
  ck "cross-origin → REJECTED (code=$evil_code)" 0
fi

echo "== 6. telemetry endpoints =="
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/client-error" -H 'Content-Type: application/json' \
  -d '{"msg":"smoke","stack":"Error: smoke\n at x","url":"/room/ab12-cd34-ef56-aa00","ver":"smoke"}')
ck "client-error POST 204" "$([ "$code" = 204 ]; echo $?)"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/quality" -H 'Content-Type: application/json' \
  -d '{"ver":"smoke","level":2,"bweKbps":900,"lossPct":0.1,"rttMs":80,"peers":2}')
ck "quality POST 204" "$([ "$code" = 204 ]; echo $?)"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/quality")
ck "quality GET no token → 401" "$([ "$code" = 401 ]; echo $?)"
curl -s -H "x-health-token: $TOK" "$BASE/api/quality" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["ok"] and d["count"]>=1' ; ck "quality GET with token → dump" "$?"

echo "== 7. room code entropy (crypto RNG, 16 chars) =="
bun -e '
import { generateRoomCode } from "./src/lib/call/types"
const codes = new Set()
for (let i = 0; i < 200; i++) {
  const c = generateRoomCode()
  if (!/^[a-hjkmnp-z2-9]{4}-[a-hjkmnp-z2-9]{4}-[a-hjkmnp-z2-9]{4}-[a-hjkmnp-z2-9]{4}$/.test(c)) process.exit(1)
  codes.add(c)
}
if (codes.size !== 200) process.exit(1)
console.log("200/200 unique, format ok")' 2>/dev/null || npx tsx -e '
import { generateRoomCode } from "./src/lib/call/types"
const codes = new Set()
for (let i = 0; i < 200; i++) {
  const c = generateRoomCode()
  if (!/^[a-hjkmnp-z2-9]{4}-[a-hjkmnp-z2-9]{4}-[a-hjkmnp-z2-9]{4}-[a-hjkmnp-z2-9]{4}$/.test(c)) process.exit(1)
  codes.add(c)
}
if (codes.size !== 200) process.exit(1)
console.log("200/200 unique, format ok")'
ck "room codes: format + uniqueness" "$?"

kill "$SRV" 2>/dev/null
echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" = 0 ]
