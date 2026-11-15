#!/usr/bin/env bash
# Pico one-box deploy — run ON the VPS (fresh Ubuntu 22.04/24.04, root):
#
#   ssh root@<server-ip> 'bash -s' < scripts/deploy.sh
#
# What it does: installs Docker, clones this repo into /opt/pico, writes
# .env (generating TURN_SECRET + HEALTH_TOKEN if missing), applies the
# sysctl + firewall rules, builds and starts the stack with --wait (waits
# for every compose healthcheck), and runs scripts/check-live.sh as the
# gate. Idempotent: safe to re-run for updates — every deploy appends its
# PICO_VERSION to .deploy-history, which scripts/rollback.sh consumes.
#
# Nothing here runs without prompts: the script asks before writing .env if
# one already exists, and never prints the secrets it generates.
set -euo pipefail

DEST="${PICO_DEST:-/opt/pico}"
REPO="${PICO_REPO:-$(git -C "$(dirname "$0")/.." remote get-url origin 2>/dev/null || true)}"

if [ "$(id -u)" != "0" ]; then
  echo "run as root: ssh root@<ip> 'bash -s' < scripts/deploy.sh"
  exit 2
fi

echo "== 1/6 Docker =="
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
fi
docker compose version >/dev/null 2>&1 || { echo "docker compose plugin missing"; exit 1; }

echo "== 2/6 Code =="
if [ -z "$REPO" ]; then
  echo "no git remote found — set PICO_REPO=<url> or clone $DEST manually"
  exit 1
fi
if [ -d "$DEST/.git" ]; then
  git -C "$DEST" fetch --quiet
  git -C "$DEST" reset --hard origin/HEAD 2>/dev/null || git -C "$DEST" pull --ff-only --quiet
else
  git clone --quiet "$REPO" "$DEST"
fi
cd "$DEST"

echo "== 3/6 .env =="
if [ ! -f .env ]; then
  read -rp "PICO_DOMAIN (e.g. call.example.com): " PICO_DOMAIN
  read -rp "TURN_SECRET (enter to generate): " TURN_SECRET_IN
  read -rp "HEALTH_TOKEN (enter to generate): " HEALTH_TOKEN_IN
  TURN_SECRET="${TURN_SECRET_IN:-$(openssl rand -hex 32)}"
  HEALTH_TOKEN="${HEALTH_TOKEN_IN:-$(openssl rand -hex 24)}"
  cat > .env <<ENV
PICO_DOMAIN=$PICO_DOMAIN
TURN_SECRET=$TURN_SECRET
HEALTH_TOKEN=$HEALTH_TOKEN
TURN_TLS_HOST=turn.$PICO_DOMAIN
TURN_PUBLIC_IP=$(curl -s https://api.ipify.org)
ENV
  chmod 600 .env
  echo ".env written (secrets not shown)"
else
  echo ".env exists — keeping it (deploy-only update)"
fi
set -a; . ./.env; set +a

echo "== 4/6 sysctl + firewall =="
# Keep coturn's relay range out of Linux's ephemeral egress band.
sysctl -w net.ipv4.ip_local_port_range="1024 49151" >/dev/null
grep -q ip_local_port_range /etc/sysctl.conf || \
  echo 'net.ipv4.ip_local_port_range="1024 49151"' >> /etc/sysctl.conf
if command -v ufw >/dev/null 2>&1; then
  ufw allow 22/tcp          >/dev/null 2>&1 || true
  ufw allow 80/tcp          >/dev/null 2>&1 || true
  ufw allow 443/tcp         >/dev/null 2>&1 || true
  ufw allow 443/udp         >/dev/null 2>&1 || true
  ufw allow 3478/udp        >/dev/null 2>&1 || true
  ufw allow 3478/tcp        >/dev/null 2>&1 || true
  ufw allow 8443/tcp        >/dev/null 2>&1 || true   # turns: (advertised by /api/ice)
  ufw allow 49152:65535/udp >/dev/null 2>&1 || true   # relay range
  ufw --force enable        >/dev/null 2>&1 || true
fi

echo "== 5/6 Build + start (waits for every healthcheck) =="
PICO_VERSION="$(git rev-parse --short HEAD)" docker compose up -d --build --wait --wait-timeout 600
# .deploy-history: "<iso-ts> <version> <commit>" — consumed by rollback.sh.
echo "$(date -Is) $(git rev-parse --short HEAD) $(git rev-parse --short HEAD)" >> .deploy-history

echo "== 6/6 Verify (the gate) =="
DOMAIN="$PICO_DOMAIN" bash "$DEST/scripts/check-live.sh" "$PICO_DOMAIN" "$HEALTH_TOKEN" \
  || { echo "CHECK-LIVE FAILED — see the PASS/FAIL lines above"; exit 1; }
echo
echo "Live. DNS reminders: A  $PICO_DOMAIN -> $(curl -s https://api.ipify.org)"
echo "                     A  turn.$PICO_DOMAIN -> same IP"
echo "Rollback:  scripts/rollback.sh 1"
