#!/bin/bash
# End-to-end validation of the SNI-multiplex pattern for TURN (DEPLOY.md):
# caddy (with mholt/caddy-l4) sniffs the TLS ClientHello on 443 — SNI
# turn.example.com goes to coturn's TLS port, everything else falls through
# to the ordinary HTTPS server. Requires: /tmp/caddytest/caddy with layer4.
set -u
cd /tmp/caddytest || exit 1
CADDY=/tmp/caddytest/caddy

# Self-signed cert standing in for coturn's ACME cert.
openssl req -x509 -newkey rsa:2048 -nodes -days 30 \
  -keyout turn.key -out turn.crt -subj "/CN=turn.example.com" >/dev/null 2>&1

cat > Caddyfile.test <<'EOF'
{
	admin off
	http_port 0
	https_port 4430
	auto_https disable_redirects
	servers :4430 {
		listener_wrappers {
			layer4 {
				@turn tls sni turn.example.com
				route @turn {
					proxy tcp/127.0.0.1:8443
				}
			}
			tls
		}
	}
}

https://web.example.com {
	tls internal
	respond "WEB-OK"
}
EOF

echo "== caddy validate =="
$CADDY validate --config Caddyfile.test 2>&1 | tail -2 || exit 1

# Stand-in coturn TLS: openssl s_server on 8443.
openssl s_server -accept 8443 -cert turn.crt -key turn.key -www -quiet >/dev/null 2>&1 &
SSERVER_PID=$!
trap 'kill $SSERVER_PID 2>/dev/null; $CADDY stop 2>/dev/null' EXIT

echo "== caddy run =="
$CADDY run --config Caddyfile.test >/tmp/caddytest/run.log 2>&1 &
sleep 3

echo "== SNI turn.example.com → should hit the coturn stand-in =="
if openssl s_client -connect 127.0.0.1:4430 -servername turn.example.com </dev/null 2>/dev/null | openssl x509 -noout -subject 2>/dev/null | grep -q "turn.example.com"; then
  echo "PASS: TURN SNI proxied to the stand-in TLS server (real cert served)"
else
  echo "FAIL: TURN SNI did not reach the stand-in"
fi

echo "== SNI web.example.com → should fall through to caddy HTTPS =="
BODY=$(curl -sk --resolve web.example.com:4430:127.0.0.1 https://web.example.com:4430/ 2>/dev/null)
if [ "$BODY" = "WEB-OK" ]; then
  echo "PASS: web SNI falls through to the ordinary HTTPS server"
else
  echo "FAIL: web SNI fall-through broken (got: '$BODY')"
fi

echo "== unknown SNI → must NOT reach the TURN backend (caddy refuses: no cert policy) =="
SUBJ=$(openssl s_client -connect 127.0.0.1:4430 -servername other.example.com </dev/null 2>/dev/null | openssl x509 -noout -subject 2>/dev/null)
if ! echo "$SUBJ" | grep -q "turn.example.com"; then
  echo "PASS: unknown SNI never reaches the TURN backend (got: '${SUBJ:-no cert — handshake refused}')"
else
  echo "FAIL: unknown SNI leaked into the TURN backend"
fi
