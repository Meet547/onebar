import { NextResponse } from 'next/server'
import { RateLimiter, providedToken, tokenMatches } from '@/lib/health-token'

/**
 * Aggregated call-quality intake (anonymized by construction — the engine
 * sends numbers only: no ids, no room codes, no IPs, no user agent). Each
 * accepted POST is one stderr JSON line (grep `quality` in the app logs)
 * and lands in a small in-memory ring so the operator can eyeball the last
 * ~200 samples with their HEALTH_TOKEN:
 *   curl -s -H "x-health-token: $HEALTH_TOKEN" https://<domain>/api/quality
 * In-memory only — restarts clear it; for long-term series, ship the JSON
 * log lines to a collector.
 */
export const dynamic = 'force-dynamic'

const limiter = new RateLimiter(120, 60_000)
const RING_MAX = 200
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ring: any[] = []

const num = (v: unknown, max: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : null
const str = (v: unknown, max: number) =>
  typeof v === 'string' ? v.slice(0, max) : ''

export async function POST(request: Request) {
  if (!limiter.allow()) {
    return new NextResponse(null, { status: 429, headers: { 'Cache-Control': 'no-store' } })
  }
  let body: Record<string, unknown>
  try {
    const raw = await request.text()
    if (raw.length > 2048) return new NextResponse(null, { status: 413 })
    body = JSON.parse(raw)
  } catch {
    return new NextResponse(null, { status: 400 })
  }
  const sample = {
    ts: new Date().toISOString(),
    ver: str(body.ver, 40),
    level: num(body.level, 3),
    bweKbps: num(body.bweKbps, 1e7),
    budgetKbps: num(body.budgetKbps, 1e6),
    lossPct: num(body.lossPct, 100),
    rttMs: num(body.rttMs, 60_000),
    cpuReason: str(body.cpuReason, 20),
    cpuStep: num(body.cpuStep, 3),
    candType: str(body.candType, 60),
    peers: num(body.peers, 100),
  }
  ring.push(sample)
  if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX)
  console.log(JSON.stringify({ quality: true, ...sample }))
  return new NextResponse(null, { status: 204, headers: { 'Cache-Control': 'no-store' } })
}

export async function GET(request: Request) {
  if (!tokenMatches(providedToken(request))) {
    return NextResponse.json(
      { ok: false, error: 'token required (see /api/health gating)' },
      { status: 401, headers: { 'Cache-Control': 'no-store' } },
    )
  }
  return NextResponse.json({ ok: true, count: ring.length, samples: ring.slice(-RING_MAX) },
    { headers: { 'Cache-Control': 'no-store' } })
}
