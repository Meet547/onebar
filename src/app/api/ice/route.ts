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
    return NextResponse.json(
      { iceServers: STUN_SERVERS, ttl: 3600, relay: true },
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
    return NextResponse.json(
      { iceServers: STUN_SERVERS, ttl: 3600, relay: true },
      { headers: noStore },
    )
  }

  return NextResponse.json(
    {
      iceServers: [...STUN_SERVERS, { urls, username, credential }],
      ttl: 3600,
      relay: true,
    },
    { headers: noStore },
  )
}
