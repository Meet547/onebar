#!/usr/bin/env python3
"""Measure cold vs warm shell transfer for the Pico home page against a
locally running `next start` (port 3111).

COLD: HTML + every same-origin asset the HTML references (scripts, CSS, font
      preloads, icons) — summed over-the-wire bytes (gzip accepted).
WARM: what the service worker puts on the network on a repeat visit = 0 B for
      the shell and static (cache-first), only /api/ice + socket.io handshake.
"""
import re
import subprocess
import sys
import time

PORT = 3111
BASE = f"http://localhost:{PORT}"


def curl_bytes(path, html=False):
    args = ["curl", "-s", "-H", "Accept-Encoding: gzip", "-o", "/dev/null",
            "-w", "%{size_download}", BASE + path]
    return int(subprocess.check_output(args, text=True).strip())


def curl_text(path):
    return subprocess.check_output(["curl", "-s", BASE + path], text=True)


def wait_up():
    for _ in range(30):
        try:
            curl_bytes("/")
            return
        except subprocess.CalledProcessError:
            time.sleep(1)
    sys.exit("next start did not come up")


if __name__ == "__main__":
    wait_up()
    html_bytes = curl_bytes("/")
    html = curl_text("/")
    # Same-origin asset references (scripts, styles, preload links).
    paths = sorted(set(re.findall(r'(?:src|href)="(/[^"]+)"', html)))
    paths = [p for p in paths if not p.startswith(("/api/", "/socket.io", "/info", "/healthz"))]
    cold = html_bytes
    print("=== COLD first visit (over-the-wire, gzip) ===")
    print(f"  HTML {html_bytes/1024:8.1f} KB")
    for p in paths:
        b = curl_bytes(p)
        cold += b
        print(f"  {p} {b/1024:8.1f} KB")
    print(f"  TOTAL {cold/1024:8.1f} KB  ({cold} bytes)")
    ice = curl_bytes("/api/ice")
    print("\n=== WARM repeat visit (service worker, cache-first) ===")
    print(f"  HTML + static assets from cache: 0.0 KB over the network")
    print(f"  (shell revalidation runs in the background, served on the NEXT visit)")
    print(f"  still on the network: /api/ice = {ice} B (fresh TURN credentials),")
    print(f"  plus the socket.io handshake (~1-2 KB, browser-only, not measurable here)")
