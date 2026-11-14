#!/bin/bash
# Probe /api/ice on the standalone build, both TURN-configured and STUN-only.
set -u
cd /home/z/my-project

kill_by_port() {
  local port="$1"
  local pid
  pid=$(ss -ltnp 2>/dev/null | grep ":${port} " | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
  [ -n "${pid:-}" ] && kill "$pid" 2>/dev/null
  sleep 1
}

echo "--- with TURN_URLS (expect turn:true + turns:...:8443?transport=tcp) ---"
PORT=3111 TURN_URLS='turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp' \
  TURN_SECRET=testsecret PICO_EMBEDDED_RELAY=0 HOSTNAME=127.0.0.1 \
  setsid bash -c 'node .next/standalone/server.js > /tmp/pico-ice.log 2>&1 & disown'
sleep 7
curl -s --max-time 10 http://127.0.0.1:3111/api/ice
echo
kill_by_port 3111

echo "--- STUN-only (expect turn:false + warning + boot log) ---"
PORT=3112 PICO_EMBEDDED_RELAY=0 HOSTNAME=127.0.0.1 \
  setsid bash -c 'node .next/standalone/server.js > /tmp/pico-ice2.log 2>&1 & disown'
sleep 7
curl -s --max-time 10 http://127.0.0.1:3112/api/ice
echo
grep -o '\[pico\] /api/ice is STUN-only[^"]*' /tmp/pico-ice2.log | head -1
kill_by_port 3112
echo done
