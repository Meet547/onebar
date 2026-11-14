#!/usr/bin/env bash
# Pico live-deployment check — run from ANY machine with only curl, openssl
# and python3:  scripts/check-live.sh <domain> [HEALTH_TOKEN]
#
# Prints PASS/FAIL per line (a–g below) and exits non-zero if any check
# fails. Never prints TURN credentials.
#   a. /api/ice advertises TURN: turn:true, urls include turn: and turns:
#      (hostnames and ports only).
#   b. TLS handshake with SNI turn.<domain> on 443: chain verifies against
#      the system store (so not self-signed), SAN matches, days to expiry,
#      issuer. Requires the SNI multiplex (DEPLOY.md) — see also check (a)
#      for the direct turns:8443 port.
#   c. TLS with SNI <domain> on 443 still serves the website.
#   d. /api/health without a token reveals NO allocation/quota data; with
#      HEALTH_TOKEN it shows allocations vs quota.
#   e. x-pico-version present and not a fallback ("dev" / "dev-*" / empty);
#      content-encoding is br or gzip.
#   f. Cold first-load transfer size of the home page and its assets.
#   g. / and /sw.js load over HTTPS; /api/ice is not cacheable.
#
# Test/override env (defaults are production-correct):
#   CHECK_LIVE_PORT     default 443
#   CHECK_LIVE_CAFILE   default system store (openssl default)
#   CHECK_LIVE_SCHEME   default https
set -u

DOMAIN="${1:-}"
HEALTH_TOKEN="${2:-${HEALTH_TOKEN:-}}"
PORT="${CHECK_LIVE_PORT:-443}"
CAFILE_ARG=()
[ -n "${CHECK_LIVE_CAFILE:-}" ] && CAFILE_ARG=(-CAfile "$CHECK_LIVE_CAFILE")
SCHEME="${CHECK_LIVE_SCHEME:-https}"
BASE="$SCHEME://$DOMAIN"
[ "$PORT" != "443" ] && BASE="$SCHEME://$DOMAIN:$PORT"

if [ -z "$DOMAIN" ]; then
  echo "usage: $0 <domain> [HEALTH_TOKEN]"
  exit 2
fi

PASS=0; FAIL=0; SKIP=0
ok()  { PASS=$((PASS+1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL: $1${2:+ — $2}"; }
skip(){ SKIP=$((SKIP+1)); echo "SKIP: $1${2:+ — $2}"; }
CURL="curl -s --max-time 20"
# Custom CA (internal testing against non-public deployments): make curl
# trust it too — openssl already gets it via -CAfile above.
[ -n "${CHECK_LIVE_CAFILE:-}" ] && CURL="$CURL --cacert $CHECK_LIVE_CAFILE"

echo "== Pico live check: $DOMAIN (port $PORT) =="

# ---------- a. /api/ice ----------
ICE=$($CURL "$BASE/api/ice" 2>/dev/null) || ICE=""
if [ -z "$ICE" ]; then
  bad "a1 /api/ice reachable" "empty response"
else
  echo "$ICE" | python3 -c '
import json, sys
data = json.load(sys.stdin)
ok = data.get("turn") is True
urls = [u for s in data.get("iceServers", []) for u in s.get("urls", [])]
turns = [u for u in urls if u.startswith("turn:")]
turnss = [u for u in urls if u.startswith("turns:")]
def hostport(u):
    rest = u.split(":", 1)[1]
    return rest.split("?")[0]
print("RESULT", ok, len(turns), len(turnss))
for u in turns:  print("TURN ", hostport(u), ("("+u.split("?transport=")[1]+")" if "?transport=" in u else ""))
for u in turnss: print("TURNS", hostport(u), ("("+u.split("?transport=")[1]+")" if "?transport=" in u else ""))
' > /tmp/check-live-ice.txt 2>/dev/null || echo "RESULT parse-error 0 0" > /tmp/check-live-ice.txt
  RES=$(head -1 /tmp/check-live-ice.txt | awk '{print $2}')
  NT=$(head -1 /tmp/check-live-ice.txt | awk '{print $3}')
  NTS=$(head -1 /tmp/check-live-ice.txt | awk '{print $4}')
  [ "$RES" = "True" ] && ok "a2 turn:true" || bad "a2 turn:true" "got $RES"
  [ "${NT:-0}" -ge 1 ] && ok "a3 turn: urls present ($(grep -c '^TURN ' /tmp/check-live-ice.txt))" \
    || bad "a3 turn: urls present" "none"
  [ "${NTS:-0}" -ge 1 ] && ok "a4 turns: urls present ($(grep -c '^TURNS ' /tmp/check-live-ice.txt))" \
    || bad "a4 turns: urls present" "none — TURN TLS fallback missing"
  grep '^TURN\|^TURNS' /tmp/check-live-ice.txt | sed 's/^/      /'
  # credentials are never printed: only host:port lines above
fi

# ---------- b. TLS with SNI turn.<domain> ----------
TURN_HOST="turn.$DOMAIN"
sni_out() { # $1=sni → single handshake output: verify line (stderr) + PEM chain
  echo | openssl s_client -connect "$DOMAIN:$PORT" -servername "$1" \
    "${CAFILE_ARG[@]}" -showcerts 2>&1
}
TURN_RAW=$(sni_out "$TURN_HOST")
VERIFY=$(echo "$TURN_RAW" | grep -o "Verify return code: .*" | tail -1)
case "$VERIFY" in
  *"0 (ok)"*) ok "b2 chain verifies against system roots ($VERIFY)" ;;
  *) bad "b2 chain verifies" "got: ${VERIFY:-none}" ;;
esac
CERT=$(echo "$TURN_RAW" | sed -n '/BEGIN CERT/,/END CERT/p')
SUBJ=$(echo "$CERT" | openssl x509 -noout -subject 2>/dev/null)
ISSUER=$(echo "$CERT" | openssl x509 -noout -issuer 2>/dev/null)
ENDDATE=$(echo "$CERT" | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
SAN=$(echo "$CERT" | openssl x509 -noout -ext subjectAltName 2>/dev/null)
[ -n "$SUBJ" ] || bad "b3 certificate parsed" "no cert returned for SNI $TURN_HOST (multiplex not deployed? see DEPLOY.md SNI multiplexing)"
if [ -n "$SUBJ" ]; then
  if [ "$SUBJ" != "$ISSUER" ]; then
    ok "b4 not self-signed (issuer: $(echo "$ISSUER" | sed 's/^issuer=//'))"
  else
    bad "b4 not self-signed" "issuer == subject (self-signed cert on the TURN path)"
  fi
  echo "$SAN" | grep -qi "DNS:$TURN_HOST" \
    && ok "b5 SAN matches $TURN_HOST" || bad "b5 SAN matches $TURN_HOST" "got: ${SAN:-none}"
  DAYS=$(python3 -c "
from datetime import datetime, timezone
d = datetime.strptime('$ENDDATE', '%b %d %H:%M:%S %Y %Z').replace(tzinfo=timezone.utc)
print((d - datetime.now(timezone.utc)).days)" 2>/dev/null)
  if [ -n "$DAYS" ] && [ "$DAYS" -ge 14 ]; then
    ok "b6 expires in $DAYS days ($ENDDATE)"
  else
    bad "b6 certificate expiry" "only ${DAYS:-?} days left ($ENDDATE) — renewal broken?"
  fi
fi

# ---------- c. TLS with SNI <domain> (website) ----------
WEB_RAW=$(sni_out "$DOMAIN")
WEB_VERIFY=$(echo "$WEB_RAW" | grep -o "Verify return code: .*" | tail -1)
case "$WEB_VERIFY" in
  *"0 (ok)"*) ok "c1 site TLS verifies with SNI $DOMAIN" ;;
  *) bad "c1 site TLS verifies" "got: ${WEB_VERIFY:-none}" ;;
esac
CODE=$($CURL -o /dev/null -w '%{http_code}' "$BASE/" 2>/dev/null)
[ "$CODE" = "200" ] && ok "c2 website served over HTTPS" || bad "c2 website served over HTTPS" "HTTP $CODE"

# ---------- d. /api/health privacy ----------
HEALTH=$($CURL "$BASE/api/health" 2>/dev/null)
if echo "$HEALTH" | grep -q '"allocations"\|"userQuota"\|"totalQuota"\|"relayPorts"'; then
  bad "d1 health without token hides allocation data" "public body exposes TURN numbers — set HEALTH_TOKEN"
else
  ok "d1 health without token hides allocation data"
fi
echo "$HEALTH" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("      public body:", {k: d[k] for k in d if k != "turn"})' 2>/dev/null
if [ -n "$HEALTH_TOKEN" ]; then
  GH=$($CURL -H "x-health-token: $HEALTH_TOKEN" "$BASE/api/health" 2>/dev/null)
  ALLOC=$(echo "$GH" | python3 -c 'import json,sys; d=json.load(sys.stdin); t=d.get("turn") or {}; print(t.get("allocations"), t.get("userQuota"), t.get("totalQuota"))' 2>/dev/null)
  if [ -n "$ALLOC" ] && [ "$ALLOC" != "None None None" ]; then
    ok "d2 health with token shows allocations vs quota ($ALLOC)"
  else
    bad "d2 health with token shows allocations vs quota" "got: $GH"
  fi
else
  skip "d2 health with token shows allocations vs quota" "no HEALTH_TOKEN given — pass it as the 2nd argument"
fi

# ---------- e. version + compression headers ----------
HEADERS=$($CURL -I -H 'Accept-Encoding: br, gzip' "$BASE/" 2>/dev/null | tr -d '\r')
PICOV=$(echo "$HEADERS" | awk 'tolower($1)=="x-pico-version:"{print $2}')
if [ -z "$PICOV" ]; then
  bad "e1 x-pico-version present" "header missing"
elif [ "$PICOV" = "dev" ] || echo "$PICOV" | grep -q '^dev-'; then
  bad "e1 x-pico-version present" "still the dev fallback ('$PICOV') — set PICO_VERSION at deploy"
else
  ok "e1 x-pico-version present: $PICOV"
fi
# content-encoding on a real JS asset (the HTML head) — br or gzip per spec
ENC=$(echo "$HEADERS" | awk 'tolower($1)=="content-encoding:"{print $2}')
case "$ENC" in
  br|gzip) ok "e2 content-encoding is $ENC" ;;
  zstd)    bad "e2 content-encoding" "zstd — acceptable wire format but spec asks for br or gzip; check Accept-Encoding probing" ;;
  "")      bad "e2 content-encoding" "identity — compression not applied; Caddyfile 'encode zstd br gzip' + header_up identity missing?" ;;
  *)       bad "e2 content-encoding" "got '$ENC'" ;;
esac

# ---------- f. cold first-load transfer size ----------
COLD=$($CURL --compressed -o /tmp/check-live-home.html -w '%{size_download}' "$BASE/" 2>/dev/null)
ASSETS=$(python3 - /tmp/check-live-home.html <<'PY'
import re, sys
try:
    html = open(sys.argv[1]).read()
except Exception:
    sys.exit(0)
urls = re.findall(r'(?:src|href)="(/[^"]+)"', html)
keep = [u for u in urls if u.startswith('/_next/')
        or u.endswith(('.css', '.js', '.png', '.webp', '.svg', '.webmanifest', '.ico'))]
seen, out = set(), []
for u in keep:
    u = u.split('?')[0]
    if u not in seen:
        seen.add(u); out.append(u)
print('\n'.join(out))
PY
)
TOTAL=$COLD; N=0
while IFS= read -r asset; do
  [ -z "$asset" ] && continue
  B=$($CURL --compressed -o /dev/null -w '%{size_download}' "$BASE$asset" 2>/dev/null)
  TOTAL=$((TOTAL + B)); N=$((N+1))
done <<< "$ASSETS"
if [ "$N" -ge 1 ] && [ "$TOTAL" -gt 0 ]; then
  ok "f1 cold first-load transfer: $TOTAL bytes (HTML + $N assets, br/gzip wire sizes)"
else
  bad "f1 cold first-load transfer" "could not measure (HTML $COLD bytes, $N assets)"
fi

# ---------- g. app shell, sw.js, ice cacheability ----------
SWCODE=$($CURL -o /dev/null -w '%{http_code}' "$BASE/sw.js" 2>/dev/null)
[ "$SWCODE" = "200" ] && ok "g1 /sw.js served over HTTPS" || bad "g1 /sw.js served over HTTPS" "HTTP $SWCODE"
ICE_CC=$($CURL -I "$BASE/api/ice" 2>/dev/null | tr -d '\r' | awk 'tolower($1)=="cache-control:"{print $2}')
case "$ICE_CC" in
  *no-store*|*no-cache*|*max-age=0*) ok "g2 /api/ice not cacheable (Cache-Control: $ICE_CC)" ;;
  "") bad "g2 /api/ice not cacheable" "no Cache-Control header — short-lived TURN credentials could be cached" ;;
  *) bad "g2 /api/ice not cacheable" "Cache-Control: $ICE_CC" ;;
esac

echo "== $PASS passed, $FAIL failed, $SKIP skipped =="
[ "$FAIL" -eq 0 ] || exit 1
exit 0
