#!/bin/bash
# Live test of the coturn healthcheck script (extracted from the compose
# entrypoint heredoc). Covers: healthy cert, hostname mismatch, expiring
# cert (<14 d), missing cert file, dead relay process.
set -u
cd /tmp || exit 1
rm -rf turn-health-test && mkdir turn-health-test && cd turn-health-test

# Extract the health script from the compose YAML (heredoc body).
python3 - <<'PY'
import yaml
ep = yaml.safe_load(open('/home/z/my-project/deploy/docker-compose.yml'))['services']['coturn']['entrypoint'][2]
body = ep.split("<<'HEALTH'\n")[1].split('\nHEALTH')[0]
open('health.sh', 'w').write(body)
print('health script extracted:', len(body), 'chars')
PY

# Test certs: matching (30 d), wrong host (30 d), expiring (13 d).
openssl req -x509 -newkey rsa:2048 -nodes -days 30  -keyout k1.key -out good.crt -subj "/CN=turn.example.com" -addext "subjectAltName=DNS:turn.example.com" >/dev/null 2>&1
openssl req -x509 -newkey rsa:2048 -nodes -days 30  -keyout k2.key -other.crt -subj "/CN=other.example.com" -addext "subjectAltName=DNS:other.example.com" >/dev/null 2>&1 || mv other.crt wrong.crt
[ -f wrong.crt ] || mv -f other.crt wrong.crt 2>/dev/null
openssl req -x509 -newkey rsa:2048 -nodes -days 13  -keyout k3.key -old.crt -subj "/CN=turn.example.com" -addext "subjectAltName=DNS:turn.example.com" >/dev/null 2>&1 || mv old.crt expiring.crt
[ -f expiring.crt ] || mv -f old.crt expiring.crt 2>/dev/null

# State files the script reads.
echo $$ > pid
cp good.crt cert.crt
echo cert.crt > cert-path
echo turn.example.com > host
export TESTDIR=$PWD

# health.sh reads absolute /tmp paths — run it against a chroot-free stub:
# patch the paths via env-independent copies (script uses fixed /tmp paths).
mkdir -p /tmp/turn-hc-stub
cp health.sh /tmp/turn-hc-stub/health.sh
run_hc() {  # $1 = cert file, $2 = host, $3 = pid-alive(1|0)
  printf '%s' "$TESTDIR/$1" > /tmp/turn-cert-path
  printf '%s' "$2" > /tmp/turn-host
  if [ "$3" = 1 ]; then printf '%s' "$$" > /tmp/turn-pid; else printf '%s' "999999" > /tmp/turn-pid; fi
  sh /tmp/turn-hc-stub/health.sh >/dev/null 2>&1
}

pass=0; fail=0
check() { if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "  ok  $1"; else fail=$((fail+1)); echo "FAIL  $1 (exit $2, want $3)"; fi }

run_hc good.crt turn.example.com 1;      check "matching cert + live pid → healthy" $? 0
run_hc wrong.crt turn.example.com 1;     check "hostname mismatch → unhealthy" $? 1
run_hc expiring.crt turn.example.com 1;  check "cert expires in 13 days → unhealthy" $? 1
printf '%s' "$TESTDIR/missing.crt" > /tmp/turn-cert-path
printf '%s' "$$" > /tmp/turn-pid
printf '%s' "turn.example.com" > /tmp/turn-host
sh /tmp/turn-hc-stub/health.sh >/dev/null 2>&1; check "missing cert file → unhealthy" $? 1
run_hc good.crt turn.example.com 0;      check "dead relay process → unhealthy" $? 1

echo "—"
echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
