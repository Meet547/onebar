#!/usr/bin/env python3
"""Local HTTPS mock for validating scripts/check-live.sh without a public
deployment: a mini CA + two SNI-selected leaf certs (localhost,
turn.localhost) and endpoints matching the Pico contract:
  /api/ice    turn:true + turn:/turns: urls + credentials (script must NOT
              print them), Cache-Control: no-store
  /api/health {ok,version} public; turn numbers only with the right token
              (x-health-token header or ?token=)
  /           HTML shell with assets; content-encoding gzip when offered
  /sw.js      the service worker file
Usage: python3 scripts/checklive-mock.py [port]  (default 3443)
"""
import gzip
import json
import os
import ssl
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 3443
DIR = "/tmp/checklive"
TOKEN = "sekrit"
VERSION = "abc1234"

HTML = """<!DOCTYPE html><html><head>
<link rel="stylesheet" href="/_next/static/chunks/app.css"/>
<script src="/_next/static/chunks/main.js"></script>
<script src="/_next/static/chunks/framework.js"></script>
<link rel="manifest" href="/manifest.webmanifest"/>
<link rel="icon" href="/icon-192.png"/>
</head><body>Pico mock</body></html>"""

CHUNK = b"window.picoMock=" + (b"x" * 20000)
CSS = b"body{margin:0}" * 400

os.makedirs(DIR, exist_ok=True)

subprocess.run(["bash", "-c", f"""
cd {DIR}
# Skip everything when the CA + leaves already exist: regenerating the CA
# alone would invalidate leaves signed by the previous CA (verify code 21).
if [ -f ca.pem ] && [ -f localhost.pem ] && [ -f turn.localhost.pem ]; then
  exit 0
fi
openssl req -x509 -newkey rsa:2048 -nodes -days 30 -keyout ca.key -out ca.pem \
  -subj '/CN=PicoCheckLive Test CA' >/dev/null 2>&1 || true
"""], check=False)
# SAN files written from Python — shell-quoted $host inside openssl config
# files is parsed as a config variable and breaks x509 -req.
for host in ("localhost", "turn.localhost"):
    with open(f"{DIR}/{host}.ext", "w") as f:
        f.write(f"subjectAltName=DNS:{host}\n")
subprocess.run(["bash", "-c", f"""
cd {DIR}
for host in localhost turn.localhost; do
  [ -f "$host.pem" ] && continue
  openssl req -newkey rsa:2048 -nodes -keyout $host.key -out $host.csr \
    -subj '/CN=$host' >/dev/null 2>&1
  openssl x509 -req -in $host.csr -CA ca.pem -CAkey ca.key -CAcreateserial \
    -out $host.pem -days 30 -extfile $host.ext >/dev/null 2>&1
done
"""], check=False)
missing = [h for h in ("localhost", "turn.localhost")
           if not os.path.exists(f"{DIR}/{h}.pem")]
if missing:
    sys.exit(f"mock setup failed: missing certs {missing}")


def make_ctx(cert):
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(f"{DIR}/{cert}.pem", f"{DIR}/{cert}.key")
    return ctx


CTX_WEB = make_ctx("localhost")
CTX_TURN = make_ctx("turn.localhost")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, body, ctype="application/json", enc=None, cache=None):
        if isinstance(body, str):
            body = body.encode()
        if enc == "gzip":
            body = gzip.compress(body)
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        if enc:
            self.send_header("Content-Encoding", enc)
        if cache:
            self.send_header("Cache-Control", cache)
        self.send_header("x-pico-version", VERSION)
        self.end_headers()
        if not self._head_only:
            self.wfile.write(body)

    def do_HEAD(self):
        # Same headers as GET, no body — check-live.sh uses curl -I for
        # header checks (x-pico-version, content-encoding, cache-control).
        self._head_only = True
        try:
            self.do_GET()
        finally:
            self._head_only = False

    def do_GET(self):
        self._head_only = False
        path, _, query = self.path.partition("?")
        params = dict(p.split("=", 1) for p in query.split("&") if "=" in p)
        tok = self.headers.get("x-health-token") or params.get("token")

        if path == "/api/ice":
            ice = {
                "iceServers": [{
                    "urls": ["turn:turn.localhost:3478?transport=udp",
                             "turn:turn.localhost:3478?transport=tcp",
                             "turns:turn.localhost:8443?transport=tcp"],
                    "username": "1794707824",
                    "credential": "SECRET-DO-NOT-PRINT",
                }],
                "ttl": 3600, "turn": True,
            }
            self._send(json.dumps(ice), cache="no-store")
        elif path == "/api/health":
            if tok and tok != TOKEN:
                self.send_response(401)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            if tok:
                body = {"ok": True, "version": VERSION,
                        "turn": {"allocations": 2, "userQuota": 30,
                                 "totalQuota": 1000, "stale": False}}
            else:
                body = {"ok": True, "version": VERSION}
            self._send(json.dumps(body), cache="no-store")
        elif path == "/sw.js":
            self._send("self.addEventListener('fetch', ()=>{})",
                       ctype="application/javascript", enc="gzip")
        elif path.startswith("/_next/static/chunks/"):
            if path.endswith(".css"):
                self._send(CSS, ctype="text/css", enc="gzip")
            else:
                self._send(CHUNK, ctype="application/javascript", enc="gzip")
        elif path == "/manifest.webmanifest":
            self._send("{}", ctype="application/manifest+json", enc="gzip")
        elif path == "/icon-192.png":
            self._send(b"\x89PNG\r\n\x1a\n" + b"0" * 3000,
                       ctype="image/png")
        else:
            # Browser-ish negotiation: we can gzip, not br → answer gzip.
            ae = self.headers.get("Accept-Encoding", "")
            enc = "gzip" if ("gzip" in ae or "br" in ae) else None
            self._send(HTML, ctype="text/html", enc=enc)


class Server(ThreadingHTTPServer):
    daemon_threads = True


httpd = Server(("127.0.0.1", PORT), Handler)


def sni_callback(sslobj, server_name, ctx):
    if server_name == "turn.localhost":
        sslobj.context = CTX_TURN
    else:
        sslobj.context = CTX_WEB
    return None


ctx0 = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx0.load_cert_chain(f"{DIR}/localhost.pem", f"{DIR}/localhost.key")
ctx0.set_servername_callback(sni_callback)
httpd.socket = ctx0.wrap_socket(httpd.socket, server_side=True)

print(f"mock up on https://127.0.0.1:{PORT} (SNI: localhost, turn.localhost)")
threading.Thread(target=httpd.serve_forever, daemon=True).start()
try:
    threading.Event().wait()
except KeyboardInterrupt:
    pass
