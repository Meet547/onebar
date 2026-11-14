import { NextResponse } from 'next/server'
import { readFile, stat } from 'node:fs/promises'

/**
 * Service health + TURN allocation observability.
 *
 * `version`    — the deployment version (PICO_VERSION, same source as the
 *                x-pico-version header and the socket version handshake).
 * `turn`       — live allocation counts vs the configured quotas. The counts
 *                come from coturn's stats file (written by the compose
 *                entrypoint's stats loop; shared read-only volume). Each
 *                allocation binds one UDP socket in the relay range, so the
 *                count is EXACT on hosts running the recommended
 *                `net.ipv4.ip_local_port_range="1024 49151"` sysctl (keeps
 *                the range coturn-exclusive) and an upper bound otherwise
 *                — the stats file says which regime the coturn host is in.
 * `allocations: null` means the stats file is not mounted/unreachable
 * (e.g. dev without coturn) — never a hard failure: health probes must not
 * flap because the optional relay stats are missing.
 */

export const dynamic = 'force-dynamic'

const STATS_FILE_DEFAULT = '/etc/coturn/stats/turn-stats.json'
// File is rewritten every TURN_STATS_INTERVAL (default 10 s); anything older
// than this means the coturn stats loop stopped.
const STALE_AFTER_MS = 60_000

interface TurnStats {
  ts?: number
  allocations?: number
  relayPorts?: [number, number]
  userQuota?: number
  totalQuota?: number
}

export async function GET() {
  const noStore = { 'Cache-Control': 'no-store' }
  const file = process.env.TURN_STATS_FILE ?? STATS_FILE_DEFAULT

  let turn: Record<string, unknown> = {
    configured: Boolean(process.env.TURN_SECRET),
    statsSource: file,
    allocations: null,
    stale: false,
    observedAt: null,
    relayPorts: null,
    userQuota: null,
    totalQuota: null,
    note: 'coturn stats file not found — dev without coturn, or the stats volume is not mounted',
  }
  try {
    const raw = await readFile(file, 'utf8')
    const s = JSON.parse(raw) as TurnStats
    const age = s.ts ? Date.now() - s.ts : null
    turn = {
      configured: Boolean(process.env.TURN_SECRET),
      statsSource: file,
      allocations: typeof s.allocations === 'number' ? s.allocations : null,
      stale: age === null || age > STALE_AFTER_MS,
      observedAt: s.ts ?? null,
      relayPorts: s.relayPorts ?? null,
      userQuota: s.userQuota ?? null,
      totalQuota: s.totalQuota ?? null,
      note:
        age !== null && age <= STALE_AFTER_MS
          ? 'live (UDP sockets bound in the relay range)'
          : 'stale — coturn stats loop stopped writing',
    }
    // Sanity: touch the file's mtime too — a frozen clock inside the coturn
    // container would defeat the ts check above.
    if (!turn.stale) {
      try {
        const m = await stat(file)
        turn.stale = Date.now() - m.mtimeMs > STALE_AFTER_MS
      } catch {
        /* stat failed — keep the ts-based verdict */
      }
    }
  } catch {
    /* keep the null-allocation shape */
  }

  return NextResponse.json(
    {
      ok: true,
      version: process.env.PICO_VERSION ?? null,
      turn,
    },
    { headers: noStore },
  )
}
