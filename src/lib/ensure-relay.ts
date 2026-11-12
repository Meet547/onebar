import { spawn } from 'child_process'
import { connect as tcpConnect } from 'net'
import { openSync } from 'fs'

/**
 * Embedded relay keeper (sandbox / single-box convenience).
 *
 * The signaling relay is an independent process on :3003/:3004. In the Docker
 * production stack it runs as its own container with `restart: unless-stopped`
 * (see docker-compose.yml), so this helper is inert there — disabled by
 * setting PICO_EMBEDDED_RELAY=0 on the app service.
 *
 * In the sandbox preview the platform only supervises the Next.js dev server:
 * when the box is recycled the relay is simply gone, and every join would
 * dead-end in "Could not reach the call relay". Two layers make that
 * impossible:
 *
 *  1. startRelayKeeper() — wired through src/instrumentation.ts, it boots the
 *     relay the moment the Next.js server starts and re-checks it every few
 *     seconds for the whole life of the process. Self-healing with zero
 *     traffic.
 *  2. ensureRelayAlive(wait) — awaited by /api/ice before it responds. The
 *     client fetches that endpoint on every join, so even if the keeper were
 *     somehow killed, the join itself revives the relay and waits until it
 *     actually listens before letting the browser connect.
 *
 * Both layers share one single-flight revival, probe real TCP connectivity
 * (never trust "process spawned"), and never throw into the caller.
 */

const RELAY_PORT = 3003
const SPAWN_COOLDOWN_MS = 4_000
const KEEPER_INTERVAL_MS = 10_000

let lastSpawnAt = 0
let inFlight: Promise<boolean> | null = null

export function probeRelay(timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = tcpConnect({ port: RELAY_PORT, host: '127.0.0.1' })
    const done = (ok: boolean) => {
      sock.destroy()
      resolve(ok)
    }
    sock.setTimeout(timeoutMs, () => done(false))
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
  })
}

async function spawnRelay(): Promise<void> {
  const cwd = process.cwd()
  const relayDir = `${cwd}/mini-services/signaling`
  console.log(`[relay-keeper] relay down on :${RELAY_PORT} — reviving…`)
  // Pin the ports explicitly: the Next.js server sets process.env.PORT for
  // its own port, and an inherited PORT would send the relay to the wrong
  // one (bind failure → half-dead relay).
  let logFd: number | undefined
  try {
    logFd = openSync(`${relayDir}/relay.log`, 'a')
  } catch {
    /* logging is best-effort */
  }
  await new Promise<void>((resolve) => {
    try {
      // Plain `bun index.ts` — no --hot watcher in the supervision path, one
      // less subsystem that can fail. The keeper itself provides healing.
      const child = spawn('bun', ['index.ts'], {
        cwd: relayDir,
        detached: true,
        stdio: logFd !== undefined ? ['ignore', logFd, logFd] : 'ignore',
        env: { ...process.env, PORT: '3003', INFO_PORT: '3004', SOCKET_PATH: '/' },
      })
      child.on('error', () => resolve())
      child.unref()
    } catch {
      /* fall through — the probe loop below reports the truth */
    }
    resolve()
  })
}

/**
 * Make sure the relay on :3003 is accepting connections. Resolves `true`
 * only after a real TCP probe succeeds — spawning and waiting when needed.
 * Concurrent callers share a single revival (single-flight), so a burst of
 * joins during a cold boot costs exactly one spawn.
 */
export function ensureRelayAlive(waitMs = 9_000): Promise<boolean> {
  if (inFlight) return inFlight
  inFlight = (async () => {
    try {
      if (await probeRelay()) return true

      const now = Date.now()
      if (now - lastSpawnAt >= SPAWN_COOLDOWN_MS) {
        lastSpawnAt = Date.now()
        await spawnRelay()
      }

      const deadline = Date.now() + waitMs
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 300))
        if (await probeRelay(600)) {
          console.log('[relay-keeper] relay is up')
          return true
        }
      }
      console.log('[relay-keeper] revival failed — relay still unreachable')
      return false
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
  const g = globalThis as { __picoRelayKeeper?: boolean }
  if (g.__picoRelayKeeper) return
  g.__picoRelayKeeper = true

  console.log('[relay-keeper] starting — relay will be kept alive on :3003')
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
