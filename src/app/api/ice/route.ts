import { NextResponse } from 'next/server'
import { createHmac } from 'crypto'
import { ensureRelayAlive } from '@/lib/ensure-relay'

/**
 * ICE configuration endpoint.
 *
 * Returns the STUN/TURN servers the browser should use to punch through NATs.
 * This is the piece that makes "works on the other side of the world" real:
 * STUN covers direct peer-to-peer in most networks, and a TURN relay catches
 * the remaining symmetric-NAT / strict-firewall cases where a direct path is
 * impossible. Configure it with env vars — no redeploy of the client needed.
 *
 *   TURN_URLS   comma-separated, e.g. turn:turn.example.com:3478?transport=udp,turn:turn.example.com:443?transport=tcp
 *   TURN_USERNAME / TURN_CREDENTIAL      static credentials, or…
 *   TURN_SECRET                          coturn `use-auth-secret` REST API:
 *                                        ephemeral HMAC-SHA1 credentials that
 *                                        expire (TURN_CREDENTIAL_TTL seconds).
 *
 * TLS TURN fallback (turns:): unless TURN_TLS_443=0, the endpoint derives an
 * extra `turns:<host>:<TURN_TLS_PORT>?transport=tcp` entry (default port 443)
 * from the first TURN_URLS host. That is the path that survives corporate
 * firewalls which allow only outbound 443/TLS. coturn must serve TLS on that
 * port — see deploy/coturn/turnserver.conf + DEPLOY.md.
 *
 * TURN credentials are handed to the browser by design — WebRTC clients must
 * know them to use the relay. Ephemeral HMAC credentials keep a leaked value
 * useful for only a few hours and are the standard production setup.
 */

export const dynamic = 'force-dynamic'

const STUN_SERVERS: Array<{ urls: string[] }> = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: ['stun:stun.cloudflare.com:3478'] },
]

const noStore = { 'Cache-Control': 'no-store' } as const

/** STUN-only health warning — logged at most once a minute. */
let lastStunWarnAt = 0
function warnStunOnly(reason: string) {
  if (Date.now() - lastStunWarnAt < 60_000) return
  lastStunWarnAt = Date.now()
  console.warn(
    `[pico] /api/ice is STUN-only (${reason}) — strict-NAT pairs will fail to connect. ` +
      'Set TURN_URLS + TURN_SECRET (see deploy/.env.example) and run coturn (deploy/docker-compose.yml).',
  )
}

export async function GET() {
  // The app calls this on every join — the perfect moment to revive a relay
  // that died (sandbox cold boots). We AWAIT the keeper: the response only
  // goes out once :3003 actually accepts connections (or the wait budget is
  // spent), so the browser never races a relay that is still booting.
  // No-op (a ~1ms TCP probe) when it is already healthy; disabled in the
  // Docker production stack via PICO_EMBEDDED_RELAY=0.
  const relayUp =
    process.env.PICO_EMBEDDED_RELAY !== '0' ? await ensureRelayAlive(8_000) : true

  if (!relayUp) {
    return NextResponse.json(
      { error: 'relay-unreachable', iceServers: STUN_SERVERS, ttl: 30 },
      { status: 503, headers: noStore },
    )
  }

  const urls = (process.env.TURN_URLS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  if (urls.length === 0) {
    warnStunOnly('TURN_URLS not set')
    return NextResponse.json(
      { iceServers: STUN_SERVERS, ttl: 3600, turn: false, warning: 'stun-only' },
      { headers: noStore },
    )
  }

  let username = process.env.TURN_USERNAME ?? ''
  let credential = process.env.TURN_CREDENTIAL ?? ''

  const secret = process.env.TURN_SECRET
  if (secret) {
    const ttl = Math.max(300, Number(process.env.TURN_CREDENTIAL_TTL ?? 21_600))
    username = String(Math.floor(Date.now() / 1000) + ttl)
    credential = createHmac('sha1', secret).update(username).digest('base64')
  }

  if (!username || !credential) {
    // Misconfigured TURN is worse than none — fail closed to STUN-only.
    warnStunOnly('TURN credentials missing')
    return NextResponse.json(
      { iceServers: STUN_SERVERS, ttl: 3600, turn: false, warning: 'stun-only' },
      { headers: noStore },
    )
  }

  // TLS fallback: turns:<host>:<port>?transport=tcp — TCP 443 reaches networks
  // that drop every other outbound port. Derived from the first TURN host so
  // operators only configure TURN_URLS once. (The WHATWG URL parser treats
  // 'turn:' as an opaque path with no hostname, so extract the host by regex.)
  const tlsOn = process.env.TURN_TLS_443 !== '0'
  const tlsPort = Number(process.env.TURN_TLS_PORT ?? 443)
  if (tlsOn) {
    const host = urls[0].match(/^turns?:([^:@/?#]+):\d+/)?.[1]
    if (host && tlsPort > 0 && tlsPort < 65_536) {
      urls.push(`turns:${host}:${tlsPort}?transport=tcp`)
    }
  }

  return NextResponse.json(
    {
      iceServers: [...STUN_SERVERS, { urls, username, credential }],
      ttl: 3600,
      turn: true,
    },
    { headers: noStore },
  )
}
