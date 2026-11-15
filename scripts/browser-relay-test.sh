#!/usr/bin/env bash
# Real-browser TURN relay test: Chromium loads the actual app page, fetches
# /api/ice verbatim, and must open a relay-only data channel through the
# local RFC 5766 TURN server (node-turn with coturn static-auth-secret
# semantics). usage: browser-relay-test.sh
set -u
BASE="${BASE:-http://127.0.0.1:3111}"
cd /home/z/my-project

curl -sf "$BASE/api/health" > /dev/null || { echo "app not up at $BASE"; exit 1; }
curl -sf "$BASE/api/ice" > /tmp/turntest/ice.json || { echo "/api/ice failed"; exit 1; }
python3 - <<'PY'
import json, hmac, hashlib, base64, time
d = json.load(open('/tmp/turntest/ice.json'))
u = next(s for s in d['iceServers'] if any(x.startswith('turn:') for x in s['urls']))['username']
c = next(s for s in d['iceServers'] if any(x.startswith('turn:') for x in s['urls']))['credential']
assert base64.b64decode(c) == hmac.new(b'smoke-turn-secret', u.encode(), hashlib.sha1).digest()
assert int(u) > time.time()
print(f"  ok  /api/ice creds valid (expiry in {int(int(u)-time.time())}s)")
PY
[ $? = 0 ] || exit 1

# TURN server up (idempotent)
if ! ss -lun 2>/dev/null | grep -q ":3478 "; then
  (setsid node /tmp/turntest/turn-server.mjs > /tmp/turntest/turn.log 2>&1 &)
  for i in $(seq 1 10); do grep -q "node-turn up" /tmp/turntest/turn.log 2>/dev/null && break; sleep 1; done
fi
grep -q "node-turn up" /tmp/turntest/turn.log 2>/dev/null && echo "  ok  node-turn listening 3478" || { echo "turn server failed:"; tail -5 /tmp/turntest/turn.log; exit 1; }

agent-browser open "$BASE/" > /tmp/turntest/ab.log 2>&1 || { echo "agent-browser open failed:"; tail -5 /tmp/turntest/ab.log; exit 1; }
agent-browser eval "$(cat scripts/inpage-turn.js)" > /tmp/turntest/eval.log 2>&1 || { echo "eval failed:"; tail -5 /tmp/turntest/eval.log; exit 1; }
agent-browser wait --fn "window.__done" --timeout 45000 > /dev/null 2>&1 || echo "(wait: __done not seen, dumping anyway)"
echo "result: $(agent-browser eval 'JSON.stringify(window.__result)')"
