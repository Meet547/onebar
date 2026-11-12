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
| Open firewall ports | `80/tcp`, `443/tcp` (Caddy), `3478/udp+tcp` (TURN), `49160–49200/udp` (TURN relay range) |

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
ufw allow 49160:49200/udp
```

### 3 · Launch

```bash
docker compose up -d --build
docker compose logs -f caddy   # wait for "certificate obtained successfully"
```

Caddy obtains and renews TLS certificates automatically. That's it —
**https://call.example.com is live.**

### 4 · Verify

```bash
curl -s https://call.example.com/api/ice        # → {"iceServers":[…TURN…]}
curl -s https://call.example.com/healthz        # → {"ok":true,…}
```

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

## TCP-443 TURN fallback (extreme firewalls)

Some networks only allow TCP 443. That port is taken by Caddy on this host,
so the clean pattern is a second IP (or a second small VPS) running coturn on
TCP 443, added to `TURN_URLS`. Most deployments skip this — UDP 3478 + TCP
3478 already covers the overwhelming majority.

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
