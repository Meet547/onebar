import { createHash, timingSafeEqual } from 'node:crypto'

/**
 * Shared HEALTH_TOKEN guard for the gated observability endpoints
 * (/api/health turn data, /api/quality dump). FAILS CLOSED: with no
 * HEALTH_TOKEN configured nothing gated is ever served. Accepted via the
 * x-health-token header or ?token= (checked by the caller). Both sides are
 * hashed to a fixed length before timingSafeEqual.
 */
export function tokenMatches(provided: string | null | undefined): boolean {
  const expected = process.env.HEALTH_TOKEN
  if (!expected) return false
  if (!provided) return false
  const a = createHash('sha256').update(expected).digest()
  const b = createHash('sha256').update(provided).digest()
  return timingSafeEqual(a, b)
}

/** The token as passed by the caller (header first, then query). */
export function providedToken(request: Request): string | null {
  const url = new URL(request.url)
  return request.headers.get('x-health-token') ?? url.searchParams.get('token')
}

/**
 * Minimal in-memory rate limiter (fixed window). Process-local — enough to
 * blunt abuse of tiny POST endpoints; real DoS protection belongs at the
 * edge (Caddy/host firewall).
 */
export class RateLimiter {
  private hits = 0
  private windowStart = 0
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}
  allow(): boolean {
    const now = Date.now()
    if (now - this.windowStart >= this.windowMs) {
      this.windowStart = now
      this.hits = 0
    }
    this.hits++
    return this.hits <= this.max
  }
}
