# Deploying Pico to the world

Pico is a P2P video calling app. The only server-side pieces are tiny:
a **signaling relay** (~KB of traffic per meeting, media never touches it),
a **room-info probe**, and an **ICE config endpoint**. The heavy lifting —
audio/video — goes **directly between participants**, encrypted with
DTLS-SRTP by the browser.

This guide takes you from zero to `https://call.yourdomain.com` working for
people on any network, on any continent.

---

## Architecture

```
                      ┌────────────────────── one small VPS ──────────────────────┐
                      │                                                            │
  browser A ◄─ TLS ──► │  Caddy :443 (auto HTTPS)                                  │
  browser B ◄────────► │    ├── /*            → app :3000        (Next.js, static) │
                      │    ├── /socket.io/*  → signaling :3003  (~KB/meeting)     │
                      │    └── /info*        → signaling :3004  (room probe)      │
                      │                                                            │
                      │  coturn :3478/udp+tcp  ← TURN relay, only for strict NATs │
                      └────────────────────────────────────────────────────────────┘

  browser A ◄══════════ DTLS-SRTP media, direct P2P ══════════► browser B
                     (TURN only when a direct path is impossible)
```

**Why TURN matters.** STUN alone connects ~80–85% of pairs. The rest —
symmetric NATs (most mobile carriers), corporate firewalls, some hotel and
campus networks — can only talk through a relay. Without TURN those users
see "Connecting…" forever. This stack ships a TURN relay, and the app hands
out **time-limited HMAC credentials** (`/api/ice`), so credentials self-expire
and nothing static is exposed.

**Privacy invariants (worth knowing before you deploy):**
- Media is end-to-end encrypted per browser (DTLS-SRTP). TURN relays ciphertext.
- No recording, no server-side storage, no analytics. Passcodes are kept as
  SHA-256 hashes in memory only. Chat lives in RAM for the duration of a call.
- The app sets `Referrer-Policy: no-referrer`, so invite links (which contain
  the room code) never leak via the `Referer` header.

---

## What you need

| Thing | Notes |
| --- | --- |
| A VPS | 1 vCPU / 1 GB RAM is genuinely enough for dozens of concurrent rooms (signaling is tiny; media doesn't flow through it) |
| A domain | `call.example.com` → the VPS IP (A/AAAA record) |
| Docker + compose plugin | `docker` and `docker compose` |
| Open firewall ports | `80/tcp`, `443/tcp` (Caddy), `3478/udp+tcp` (TURN), `8443/tcp` on the coturn IP (TURN TLS default — see below), `49152–65535/udp` (TURN relay range) |

---

## Deploy in four steps

### 1 · Prepare

```bash
git clone <your-repo> pico && cd pico
cp .env.example .env
```

Fill in `.env`:

```ini
PICO_DOMAIN=call.example.com
TURN_SECRET=$(openssl rand -hex 32)   # print & paste the result
TURN_PUBLIC_IP=203.0.113.10           # curl -4 ifconfig.me
```

### 2 · Open the firewall

Example for `ufw` (adjust for your cloud security groups too — AWS/GCP
require both the OS firewall *and* the cloud firewall rules):

```bash
ufw allow 80/tcp && ufw allow 443/tcp
ufw allow 3478/udp && ufw allow 3478/tcp
ufw allow 49152:65535/udp
```

### 3 · Launch

```bash
# PICO_VERSION stamps this deploy (socket version handshake, service-worker
# cache pruning, /api/health, check-live.sh all key off it). The git short
# SHA is unique per deploy by construction; the build also falls back to it
# from the build context, but setting it explicitly works even when the
# context has no .git.
PICO_VERSION=$(git rev-parse --short HEAD) docker compose up -d --build
docker compose logs -f caddy   # wait for "certificate obtained successfully"
```

Caddy obtains and renews TLS certificates automatically. That's it —
**https://call.example.com is live.**

### 4 · Verify

```bash
bash scripts/check-live.sh call.example.com "$HEALTH_TOKEN"
```

`check-live.sh` runs from any machine with only `curl`, `openssl` and
`python3`, prints one PASS/FAIL line per check, and exits non-zero if any
check failed. How to read the output:

- **a. `turn:true` + `turn:` / `turns:` URLs** — /api/ice is advertising the
  relay. The listed host:port lines never include credentials. No `turns:`
  line → TURN TLS (the strict-firewall fallback) is not configured.
- **b. SNI `turn.<domain>` on 443** — the TURN TLS path through the Caddy
  multiplex: chain verifies (so **not self-signed** — browsers reject
  self-signed TURN TLS), SAN matches, days-to-expiry (fails under 14 days —
  renewal is broken before users notice), issuer reported. FAIL here with
  PASS on (a) usually means the multiplex is not deployed and turns: rides
  8443 directly.
- **c. SNI `<domain>` on 443** — the website certificate still verifies and
  the site is served; catches a multiplex that swallows the web SNI.
- **d. health privacy** — without a token the public body must be
  `{ok, version}` only; with your `HEALTH_TOKEN` the gated view shows
  `allocations userQuota totalQuota`. Public allocation numbers = someone
  skipped `HEALTH_TOKEN`.
- **e. `x-pico-version` + content-encoding** — version must exist and not be
  the `dev`/package fallback (it stamps the SW caches and the socket version
  handshake); content-encoding must be `br` or `gzip` (identity means the
  Caddyfile encode chain is not in front).
- **f. cold first-load transfer size** — HTML + assets over the wire
  (br/gzip sizes). Compare against ~240 KB brotli as the budget.
- **g. shell + `sw.js` + ice cacheability** — the app shell and service
  worker load over HTTPS, and `/api/ice` is `Cache-Control: no-store` (its
  TURN credentials are short-lived; a cached copy hands out stale creds).

Then the human test: open the site in a normal browser and in a phone on
**cellular data** (not your wifi), join the same room, and confirm both
audio and video flow. Cellular vs. home wifi is exactly the asymmetric-NAT
pair that proves TURN works.

---

## Configuration reference

### Build-time (client, `NEXT_PUBLIC_*` — baked into the bundle)

| Var | Default | Meaning |
| --- | --- | --- |
| `NEXT_PUBLIC_SIGNALING_URL` | `/` | Where socket.io connects |
| `NEXT_PUBLIC_SOCKET_PATH` | `/socket.io` | socket.io path |
| `NEXT_PUBLIC_ROOM_INFO_URL` | `/info` | Room probe (passcode/lock pre-check) |
| `NEXT_PUBLIC_SITE_URL` | — | Canonical origin for OG metadata |

The defaults match the shipped `deploy/Caddyfile.production` (single domain,
path-based routing). To run signaling on a **subdomain** instead
(`sig.example.com`), set:

```ini
PICO_SIGNALING_URL=https://sig.example.com
PICO_ROOM_INFO_URL=https://sig.example.com/info
```

…and give that subdomain a Caddy/nginx block routing `/socket.io*` → 3003 and
`/info*` → 3004. Both topologies are supported; single-domain is simpler.

### Runtime (`/api/ice`)

| Var | Meaning |
| --- | --- |
| `TURN_URLS` | Comma-separated TURN URLs handed to clients |
| `TURN_SECRET` | Enables coturn REST auth: ephemeral HMAC-SHA1 credentials |
| `TURN_USERNAME` / `TURN_CREDENTIAL` | Static credentials (only if `TURN_SECRET` unset) |
| `TURN_CREDENTIAL_TTL` | Credential lifetime in seconds (default 21600 = 6 h) |

If TURN env vars are absent or malformed, `/api/ice` returns STUN-only — the
app degrades gracefully instead of breaking.

### Signaling service

| Var | Default | Meaning |
| --- | --- | --- |
| `SOCKET_PATH` | `/` | Must match `NEXT_PUBLIC_SOCKET_PATH` |
| `ORIGIN` | `*` | Comma-separated allowed CORS origins — set it to your domain in production |
| `PORT` / `INFO_PORT` | `3003` / `3004` | Listen ports |

Built-in protections: 8 peers max per room, per-socket rate limits on every
event, passcode brute-force cooldown (10 misses → 60 s lockout per IP),
128 KB socket payload cap, and room state that evaporates when the last
person leaves.

---

## Using a managed TURN instead of self-hosting

If you'd rather not run coturn (e.g. your host blocks UDP ranges), managed
relays like Cloudflare Calls TURN, Twilio NTS or Xirsys work out of the box:

1. Get static credentials (or a credential generator) from the provider.
2. Set `TURN_URLS=turns:standard.turn.twilio.com:443?transport=tcp` etc.
   plus `TURN_USERNAME` / `TURN_CREDENTIAL` on the **app** service.
3. Remove the `coturn` service from `docker compose`.

## TURN over TLS (turns:) — firewalled networks

Some networks allow only outbound TCP 443 (or a bare TLS whitelist).
`/api/ice` therefore advertises a `turns:<domain>:<TURN_TLS_PORT>?transport=tcp`
entry automatically — derived from `TURN_URLS`'s host, no extra config.

**The certificate must be real.** Browsers validate TURN TLS certificates and
reject self-signed ones, which would make this fallback path useless exactly
where it is needed. The compose stack handles it: coturn mounts Caddy's data
volume read-only and serves the very Let's Encrypt certificate Caddy already
obtained for the domain. On a fresh deploy, Caddy has no cert during the first
seconds — coturn then starts with a loud warning and a (rejected-by-browsers)
self-signed placeholder; run `docker compose restart coturn` once Caddy has
issued, or wire `TURN_CERT_FILE` / `TURN_KEY_FILE` to a certbot-provided pair.

Port placement (coturn uses host networking, so this is a real socket):

| Setup | `TURN_TLS_PORT` | Reachability |
| --- | --- | --- |
| coturn on a dedicated second IP | `443` | **Best.** Survives 80/443-only firewalls. Open `443/tcp` on that IP. |
| SNI multiplex on one IP | `443` | **Equivalent reachability**, one IP; needs a Caddy build with the layer4 module — verified setup below. |
| Single IP, no multiplex | `8443` | Works for whitelists that include 8443, but corporate/hotel firewalls that allow ONLY outbound 80+443 will block it exactly like 3478. Choose this only if those networks don't matter to you. |

**If you care about corporate/hotel/airport Wi-Fi, treat a true-443 setup
(dedicated IP or SNI multiplex) as required, not optional.** 8443 is a
convenience default, not a guarantee.

### SNI multiplexing — verified configuration

Single IP, true 443 for both the website and TURN: a Caddy build with the
layer4 module sniffs the TLS ClientHello on 443 — the ClientHello carrying
the TURN SNI hostname (`TURN_TLS_HOST`, default `turn.<PICO_DOMAIN>`) is
proxied (unterminated) to coturn's TLS port, every other ClientHello falls
through to the ordinary HTTPS server.

This exact shape was validated end-to-end with Caddy 2.11.9 +
`github.com/mholt/caddy-l4` (`scripts/verify-caddy-l4.sh`: validate + live
`openssl s_client` checks — TURN SNI reaches the TURN backend, web SNI
reaches Caddy's HTTPS, unknown SNI is refused by Caddy, and a TLS-ALPN-01
challenge connection is intercepted by Caddy instead of leaking into the
TURN backend):

```caddyfile
# Build: xcaddy build --with github.com/mholt/caddy-l4
#        (the registered package path; "caddyserver/layer4" is NOT valid
#         for `caddy add-package`)
{
    servers :443 {
        listener_wrappers {
            layer4 {
                # ACME TLS-ALPN-01 challenges must reach Caddy even when their
                # SNI is the TURN host — route by ALPN BEFORE the SNI rule,
                # otherwise Let's Encrypt issuance/renewal fails through the
                # multiplex (verified: without this, the challenge leaks into
                # the TURN backend).
                @acme tls alpn acme-tls/1
                route @acme {
                    tls
                }
                @turn tls sni turn.example.com   # your TURN_TLS_HOST
                route @turn {
                    # TLS passes through ENCRYPTED — coturn terminates it
                    # with the ACME cert; Caddy never sees the plaintext.
                    # Caddy runs in a BRIDGE container, so 127.0.0.1 would be
                    # Caddy itself — the TURN target is the host's docker
                    # bridge gateway, where host-networked coturn (compose:
                    # network_mode: host) listens on 0.0.0.0:8443. The caddy
                    # service must carry: extra_hosts: ["host-gateway:host-gateway"].
                    proxy tcp/host-gateway:8443
                }
            }
            # next wrapper: Caddy's own TLS termination for everything else
            tls
        }
    }
}

turn.example.com, call.example.com {
    # ... the ordinary site blocks (reverse_proxy app/signaling) ...
}
```

Certificate issuance for the TURN host: `Caddyfile.production` already
carries a `{$TURN_TLS_HOST}` site block (responds 421) whose only job is to
make Caddy obtain and renew that certificate into `caddy_data`, which coturn
serves. **It requires a DNS record for `TURN_TLS_HOST`.** If you set
`TURN_TLS_HOST` equal to `PICO_DOMAIN`, delete that site block — Caddy
rejects duplicate site addresses, and the multiplex cannot share the web
SNI anyway (all traffic for that name would go to coturn).

Notes: coturn keeps `TURN_TLS_PORT=8443` as its LISTEN port. coturn runs
with `network_mode: host`, so 8443 is bound on every host interface —
including the docker bridge gateway that `host-gateway` resolves to, and the
public interface. **8443 is intentionally publicly reachable**: it is the
`turns:` port `/api/ice` advertises; the 443 multiplex is the additional
path for 80/443-only firewalls. If you instead want multiplex-only (close
8443 to the internet), enforce it on the HOST firewall (`ufw deny 8443/tcp`
— a host-networked container pays no attention to compose `ports:`), and
note /api/ice would then advertise a port those same strict networks cannot
reach directly; keep the multiplex as the turns: path for them. QUIC/HTTP-3
on 443/udp is untouched (coturn's turns: is TCP-only, and the layer4 wrapper
handles TCP). Behind the multiplex every TLS client appears to coturn as the
docker bridge gateway IP (not 127.0.0.1 any more) — that is fine:
`denied-peer-ip`/`no-multicast-peers`/`no-loopback-peers` restrict
relay *targets*, not client source IPs, and the allocation quotas are keyed
by username, not IP (see the comments in `coturn/turnserver.conf`).

### Certificate renewal — do not skip this

coturn reads the certificate at startup ONLY (a reload happens on SIGUSR2;
SIGHUP merely resets the log file). Caddy renews the Let's Encrypt cert
around day 60 — without extra plumbing coturn would keep serving the stale
cert until it expires, and TURN would die silently. The compose stack ships
the fix:

- the coturn entrypoint runs a **cert watcher** (5 min cadence,
  `TURN_CERT_CHECK_INTERVAL` to tune) over the **fullchain** cert + key
  Caddy stores for `TURN_TLS_HOST` (Caddy's `<host>.crt` is the fullchain):
  when the files change it sends **SIGUSR2** to reload, logging
  `[coturn] turns: certificate changed`;
- a **healthcheck** (script generated at `/tmp/turn-health.sh`) marks the
  container unhealthy when the relay process is gone, the certificate is
  **missing/unreadable**, it is **within 14 days of expiry**, or it **does
  not match `TURN_TLS_HOST`** (SAN or CN, wildcard suffix accepted) — wire
  `docker ps` health state (or `docker inspect --format '{{.State.Health.Status}}' coturn`)
  into your monitor. The mismatch check is what catches a stale
  `TURN_TLS_HOST`/cert pairing before browsers start rejecting turns:.

Set `TURN_TLS_443=0` to stop advertising the `turns:` entry entirely.
The app logs a boot warning (and `/api/ice` warns + returns
`"warning":"stun-only"`) whenever TURN is not configured — treat it as a
health-check signal in your monitor.

### Verifying TURN on a live deployment

From any machine, against the real domain:

```sh
curl -s https://<your-domain>/api/ice | python3 -m json.tool
```

You should see `turn:…:3478` entries AND a `turns:…:8443?transport=tcp`
entry (port = `TURN_TLS_PORT`) with short-lived `username`/`credential`.
If the response says `"turn": false, "warning": "stun-only"`, TURN is NOT
live — strict-NAT pairs (carriers, hotel Wi-Fi) will fail to connect while
everything else looks fine. Also check `docker ps` for coturn's health
status and `docker compose logs coturn` for the cert-watcher lines.

## Operations

- **Logs**: `docker compose logs -f app signaling coturn caddy`
- **Health**: `/healthz` (signaling+probe) and `/api/ice` (app) — wire both to
  an uptime monitor. Signaling restart is invisible to ongoing calls (media is
  P2P); a short gap only delays new joins and chat.
- **Updates**: `git pull && docker compose up -d --build` — seconds of
  downtime for the UI only.
- **Backups**: none needed — there is no database and no persisted state.
  `caddy_data` volume holds TLS certs; back it up if you dislike re-issuance.

## Scaling notes

- One room caps at **8 participants** (hard limit in the signaling relay;
  mesh upload grows per participant, and 8 keeps the weakest phone cool).
- A 1-vCPU VPS serves **many hundreds of concurrent rooms** — the server only
  relays kilobytes of SDP/chat per meeting. Media scales because peers scale.
- To run multiple signaling replicas you'd add sticky sessions
  (`ip_hash` / cookie) — but with numbers like these, you'll hit a second VPS
  for capacity long before you need it.

## Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| Works on wifi↔wifi, fails wifi↔cellular | TURN unreachable — check `3478/udp+tcp` and the relay range on the firewall, and `TURN_PUBLIC_IP` |
| `curl /api/ice` shows no TURN entry | TURN env vars missing on the **app** container (`docker compose exec app env \| grep TURN`) |
| Client stuck on "Connecting…" | Signaling unreachable — check `/healthz`, Caddy routing, and `ORIGIN` if you set it |
| Cameras never open at all | Page not on HTTPS (see the in-app banner) — getUserMedia requires a secure context |
| Two clients connect but no audio/video | Wrong `TURN_PUBLIC_IP` behind NAT, or relay range blocked; `docker compose logs coturn` shows allocation errors |
| Chat works, video doesn't | Usually one side has a hard firewall — the network bars and per-peer levels in the quality panel show which link is degraded |
