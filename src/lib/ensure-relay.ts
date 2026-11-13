/**
 * Embedded relay keeper (single-box / sandbox supervision).
 *
 * The signaling relay lives IN this process (see relay-server.ts) — a
 * standalone production build therefore ships it with zero moving parts.
 * This module adds two guarantees on top:
 *
 *  1. startRelayKeeper() — wired through src/instrumentation.ts, it starts
 *     (or adopts) the relay the moment the Next.js server boots and
 *     re-checks it with a real engine.io handshake every few seconds for the
 *     whole life of the process. Self-healing with zero traffic.
 *  2. ensureRelayAlive(wait) — awaited by /api/ice before it responds. The
 *     client fetches that endpoint on every join, so even if the keeper were
 *     somehow killed, the join itself revives the relay and waits until it
 *     actually speaks engine.io before letting the browser connect.
 *
 * Both layers share one single-flight revival, probe REAL engine.io
 * handshakes (never trust "port is bound" — a zombie that holds the port but
 * stopped serving would otherwise be trusted forever), and never throw into
 * the caller.
 *
 * In the Docker production stack the relay runs as its own container
 * (docker-compose.yml) and everything here is inert — disabled by setting
 * PICO_EMBEDDED_RELAY=0 on the app service.
 */

import {
  probeRelay,
  startEmbeddedRelay,
  resetEmbeddedRelay,
  closeEmbeddedRelay,
  type EmbeddedRelay,
} from './relay-server'

const RESTART_COOLDOWN_MS = 4_000
const KEEPER_INTERVAL_MS = 10_000

let lastRestartAt = 0
let inFlight: Promise<boolean> | null = null

type KeeperGlobal = typeof globalThis & {
  __picoRelayKeeper?: boolean
}

/**
 * Bring the relay to a verified-healthy state:
 *  - healthy (owned or adopted) → true immediately (~1 probe)
 *  - zombie owned handle        → close + fresh in-process bind
 *  - dead adopted relay         → take over the port in-process
 *  - nothing running            → start embedded
 */
async function ensureInternal(): Promise<boolean> {
  // Fast path: a relay already answers a real engine.io handshake.
  if (await probeRelay(800)) return true

  const now = Date.now()
  if (now - lastRestartAt < RESTART_COOLDOWN_MS) {
    // Recently restarted — give it a moment instead of thrashing.
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250))
      if (await probeRelay(500)) return true
    }
    return false
  }
  lastRestartAt = Date.now()

  // Whatever state we were in is dead: drop the singleton (closing sockets we
  // own) so the embedded relay can bind cleanly — adopting first if a healthy
  // foreign relay appeared in the meantime.
  await closeEmbeddedRelay()
  resetEmbeddedRelay()

  const handle = (await startEmbeddedRelay()) as EmbeddedRelay | null
  if (!handle) return false

  // Verify with a real handshake before declaring victory.
  const deadline = Date.now() + 6_000
  while (Date.now() < deadline) {
    if (await probeRelay(700)) return true
    await new Promise((r) => setTimeout(r, 200))
  }
  console.log('[relay-keeper] embedded relay bound but not answering — giving up this round')
  return false
}

/**
 * Make sure the relay on the signaling port actually speaks engine.io.
 * Resolves `true` only after a real handshake succeeds — reviving it when
 * needed. Concurrent callers share a single revival (single-flight), so a
 * burst of joins during a cold boot costs exactly one recovery.
 */
export function ensureRelayAlive(waitMs = 9_000): Promise<boolean> {
  if (inFlight) return inFlight
  inFlight = (async () => {
    try {
      if (await probeRelay(800)) return true
      const deadline = Date.now() + waitMs
      for (;;) {
        const ok = await ensureInternal()
        if (ok) return true
        if (Date.now() >= deadline) {
          console.log('[relay-keeper] revival failed — relay still unreachable')
          return false
        }
        await new Promise((r) => setTimeout(r, 300))
      }
    } catch {
      return false
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}

/**
 * Boot-time + periodic keeper. Started once per server process from
 * src/instrumentation.ts (Node runtime only).
 */
export function startRelayKeeper(): void {
  const g = globalThis as KeeperGlobal
  if (g.__picoRelayKeeper) return
  g.__picoRelayKeeper = true

  console.log('[relay-keeper] starting — embedded relay will be kept alive')
  void ensureRelayAlive(15_000)
  const timer = setInterval(() => {
    void (async () => {
      if (await probeRelay(1_000)) return
      console.log('[relay-keeper] periodic check: relay down — reviving')
      await ensureRelayAlive(9_000)
    })()
  }, KEEPER_INTERVAL_MS)
  timer.unref?.()
}
