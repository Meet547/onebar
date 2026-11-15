#!/usr/bin/env python3
"""Probe /api/health on the standalone build: version reporting + TURN
allocations vs quota (real stats file from the sandbox coturn when present).

Modes exercised:
  1. with TURN_STATS_FILE pointing at a REAL coturn stats file → live numbers
  2. without the file (dev, no coturn) → allocations null, note explains
Also asserts the x-pico-version header is present on responses (SW contract).
"""
import json
import os
import subprocess
import sys
import time

PORT = 3111
BASE = f"http://127.0.0.1:{PORT}"
REAL_STATS = "/tmp/coturn-bin/turn-stats.json"


def curl(path, headers=False, extra=None):
    args = ["curl", "-s"]
    if headers:
        args += ["-D", "-"]
    for h in extra or []:
        args += ["-H", h]
    args.append(BASE + path)
    return subprocess.check_output(args, text=True)


def wait_up():
    for _ in range(30):
        try:
            curl("/")
            return
        except subprocess.CalledProcessError:
            time.sleep(1)
    sys.exit("standalone server did not come up")


def start(env_extra):
    # Clear any stale listener on the probe port first (a leftover server
    # would answer with an old build and poison every assertion).
    subprocess.run(["bash", "-c",
                    "pid=$(ss -ltnp 2>/dev/null | grep ':%d ' | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2); "
                    "[ -n \"$pid\" ] && kill $pid; sleep 1" % PORT], check=False)
    subprocess.run(
        ["setsid", "bash", "-c",
         f"PORT={PORT} PICO_EMBEDDED_RELAY=0 HOSTNAME=127.0.0.1 "
         + " ".join(f"{k}={v}" for k, v in env_extra.items())
         + " node .next/standalone/server.js > /tmp/pico-health.log 2>&1 & disown"],
        cwd="/home/z/my-project", check=False,
    )
    wait_up()


def stop():
    subprocess.run(["bash", "-c",
                    "pid=$(ss -ltnp 2>/dev/null | grep ':%d ' | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2); "
                    "[ -n \"$pid\" ] && kill $pid" % PORT], check=False)
    time.sleep(1)


def main():
    # Build a REAL stats file from the live sandbox coturn. TURN allocations
    # expire (~5 min without refresh), so re-create them first: the quota-test
    # instance is running with user-quota=2, so uclient -m 5 yields exactly 2
    # live allocations (RTP+RTCP of one client) and 486s for the rest.
    # Hex port → decimal via digit lookup: mawk cannot parse "0xEE4E" strings.
    COUNT_AWK = (
        "function h2d(s,  i, c, n, r) { r = 0; s = toupper(s); "
        "for (i = 1; i <= length(s); i++) { c = substr(s, i, 1); "
        "n = index(\"0123456789ABCDEF\", c) - 1; if (n < 0) continue; "
        "r = r * 16 + n } return r } "
        "{ split($2, a, \":\"); if (length(a[2]) == 4) { p = h2d(a[2]); "
        "if (p >= lo && p <= hi) n++ } } END { print n + 0 }"
    )

    def count_relay(lo, hi):
        out = subprocess.run(
            ["awk", "-v", f"lo={lo}", "-v", f"hi={hi}", COUNT_AWK,
             "/proc/net/udp", "/proc/net/udp6"],
            capture_output=True, text=True).stdout.strip()
        return int(out or 0)

    uclient = "/tmp/coturn-bin/ext/usr/bin/turnutils_uclient"
    created = 0
    if os.path.exists(uclient):
        subprocess.run(
            ["bash", "-c",
             "LD_LIBRARY_PATH=/tmp/coturn-bin/ext/usr/lib/x86_64-linux-gnu "
             f"{uclient} -y -u 1794707824 -w Ei6X4PANtV/5o85KLagQsil2uxI= "
             "-p 34781 -m 5 -n 1 127.0.0.1 >/dev/null 2>&1"],
            check=False)
        time.sleep(2)
        created = count_relay(61000, 61050)
    real = count_relay(61000, 61050)
    os.makedirs(os.path.dirname(REAL_STATS), exist_ok=True)
    with open(REAL_STATS, "w") as f:
        json.dump({"ts": int(time.time() * 1000), "allocations": int(real or 0),
                   "relayPorts": [49152, 65535], "userQuota": 30, "totalQuota": 1000}, f)
    print(f"live allocations now: {real} (uclient created: {created > 0})")

    pass_n = fail_n = 0

    def check(name, cond, extra=""):
        nonlocal pass_n, fail_n
        if cond:
            pass_n += 1
            print(f"  ok  {name}")
        else:
            fail_n += 1
            print(f"FAIL  {name} {extra}")

    # 0. Default version (T2 contract): no PICO_VERSION env → build-time
    #    header and runtime resolution must BOTH be the git short hash.
    git_sha = subprocess.run(["git", "rev-parse", "--short", "HEAD"],
                             capture_output=True, text=True,
                             cwd="/home/z/my-project").stdout.strip()
    start({"TURN_STATS_FILE": REAL_STATS})
    body = json.loads(curl("/api/health"))
    check("default version == git short hash", body.get("version") == git_sha,
          f"api={body.get('version')} git={git_sha}")
    hdr = curl("/", headers=True)
    hdr_line = [l for l in hdr.lower().splitlines() if l.startswith("x-pico-version:")]
    check("header version == same git hash (build==runtime)",
          bool(hdr_line) and hdr_line[0].split(":", 1)[1].strip() == git_sha,
          str(hdr_line))
    stop()

    # 1. Real stats present — /api/health must mirror the exact /proc count.
    #    Turn data is fail-closed: every gated read below carries the token.
    TOK = "sekrit"
    start({"TURN_STATS_FILE": REAL_STATS, "PICO_VERSION": "testv1",
           "HEALTH_TOKEN": TOK})
    body = json.loads(curl("/api/health", extra=[f"x-health-token: {TOK}"]))
    check("version reported", body.get("version") == "testv1", str(body.get("version")))
    check("turn.allocations is a number", isinstance(body["turn"]["allocations"], int))
    check("allocations == live /proc count", body["turn"]["allocations"] == int(real or 0),
          f"api={body['turn']['allocations']} proc={real}")
    if created:
        check("allocations > 0 (live uclient allocations)", body["turn"]["allocations"] > 0,
              str(body["turn"]["allocations"]))
    check("not stale", body["turn"]["stale"] is False)
    check("quotas relayed", body["turn"]["userQuota"] == 30 and body["turn"]["totalQuota"] == 1000)
    hdr = curl("/", headers=True)
    # Build-time header: the sandbox build runs inside the git checkout, so
    # the header carries the git short hash (mode 0 asserts the exact match).
    check("x-pico-version header present", "x-pico-version:" in hdr.lower(),
          hdr.lower()[:400])
    stop()

    # 2. Stats file missing (dev without coturn).
    start({"TURN_STATS_FILE": "/nonexistent/turn-stats.json", "PICO_VERSION": "testv2",
           "HEALTH_TOKEN": TOK})
    body = json.loads(curl("/api/health", extra=[f"x-health-token: {TOK}"]))
    check("missing file → allocations null", body["turn"]["allocations"] is None)
    check("missing file → ok:true (health never flaps)", body.get("ok") is True)
    check("note explains the absence", "not found" in body["turn"]["note"])
    stop()

    # 3. Stale file (ts far in the past) — needs the REAL stats path mounted.
    with open(REAL_STATS, "w") as f:
        json.dump({"ts": 1000, "allocations": 9, "relayPorts": [49152, 65535],
                   "userQuota": 30, "totalQuota": 1000}, f)
    start({"TURN_STATS_FILE": REAL_STATS, "PICO_VERSION": "testv3",
           "HEALTH_TOKEN": TOK})
    body = json.loads(curl("/api/health", extra=[f"x-health-token: {TOK}"]))
    check("stale ts → stale:true", body["turn"]["stale"] is True, str(body["turn"]))
    stop()

    # 4. Token gate (T3): with HEALTH_TOKEN set, the public body carries NO
    #    turn data; a wrong token is a 401; the right token shows everything.
    start({"TURN_STATS_FILE": REAL_STATS, "PICO_VERSION": "testv4",
           "HEALTH_TOKEN": "sekrit"})
    body = json.loads(curl("/api/health"))
    check("no token → ok+version still public", body.get("ok") is True
          and body.get("version") == "testv4", str(body))
    check("no token → no turn key at all", "turn" not in body, str(body.keys()))
    code = subprocess.run(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
                           f"{BASE}/api/health?token=wrong"],
                          capture_output=True, text=True).stdout.strip()
    check("wrong token → 401", code == "401", code)
    body = json.loads(curl("/api/health", extra=["x-health-token: sekrit"]))
    check("right token (header) → allocations present",
          isinstance(body.get("turn", {}).get("allocations"), int), str(body)[:200])
    body = json.loads(curl("/api/health?token=sekrit"))
    check("right token (query) → allocations present",
          isinstance(body.get("turn", {}).get("allocations"), int), str(body)[:200])
    stop()

    # 5. Fail closed: with NO HEALTH_TOKEN configured the gated data is never
    #    served — even a guessed or query-supplied token gets nothing.
    start({"TURN_STATS_FILE": REAL_STATS, "PICO_VERSION": "testv5"})
    body = json.loads(curl("/api/health?token=sekrit"))
    check("unset token + query token → still fail-closed", "turn" not in body,
          str(body.keys()))
    body = json.loads(curl("/api/health", extra=["x-health-token: sekrit"]))
    check("unset token + header token → still fail-closed", "turn" not in body,
          str(body.keys()))
    check("public body still ok+version", body.get("ok") is True
          and body.get("version") == "testv5", str(body))
    stop()

    print("—")
    print(f"{pass_n} passed, {fail_n} failed")
    sys.exit(0 if fail_n == 0 else 1)


if __name__ == "__main__":
    main()
