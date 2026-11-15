import { NextResponse } from 'next/server'
import { RateLimiter } from '@/lib/health-token'

/**
 * Client error intake — window.onerror / unhandledrejection land here.
 * Store nothing: one structured JSON line per accepted report on stderr
 * (visible in `docker compose logs app`), capped hard so a runaway client
 * cannot flood the logs. No PII: the hook sends message + stack head +
 * path-without-query; room codes live in query strings and never arrive.
 */
export const dynamic = 'force-dynamic'

const limiter = new RateLimiter(30, 60_000)

export async function POST(request: Request) {
  if (!limiter.allow()) {
    return new NextResponse(null, { status: 429, headers: { 'Cache-Control': 'no-store' } })
  }
  let body: { msg?: unknown; stack?: unknown; url?: unknown; ver?: unknown }
  try {
    const raw = await request.text()
    if (raw.length > 4096) return new NextResponse(null, { status: 413 })
    body = JSON.parse(raw)
  } catch {
    return new NextResponse(null, { status: 400 })
  }
  const clean = (v: unknown, max: number) =>
    typeof v === 'string' ? v.replace(/[\r\n]+/g, ' ⏎ ').slice(0, max) : ''
  console.log(
    JSON.stringify({
      clientError: true,
      ts: new Date().toISOString(),
      ver: clean(body.ver, 40),
      url: clean(body.url, 200),
      msg: clean(body.msg, 300),
      stack: clean(body.stack, 700),
    }),
  )
  return new NextResponse(null, { status: 204, headers: { 'Cache-Control': 'no-store' } })
}
