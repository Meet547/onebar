import { spawn } from 'child_process'
import { connect as tcpConnect } from 'net'
import { openSync } from 'fs'

/**
 * Embedded relay keeper (sandbox / single-box convenience).
 *
 * The signaling relay is an independent process on :3003/:3004. In the Docker
 * production stack it runs as its own container with `restart: unless-stopped`
 * (see docker-compose.yml), so this helper is pointless there — it is disabled
 * by setting PICO_EMBEDDED_RELAY=0 on the app service.
 *
 * In the sandbox preview, however, the platform only supervises the Next.js
 * dev server. If the relay process dies (or the box was recycled), every join
 * would time out with "Could not reach the call relay". The app fetches
 * /api/ice on every join anyway — so that endpoint calls this keeper, which
 * revives the relay before the socket ever tries to connect. A join right
 * after a cold boot takes a couple of seconds longer instead of failing.
 */

const RELAY_PORT = 3003
const SPAWN_COOLDOWN_MS = 5_000

let lastSpawnAt = 0
let lastAliveCheck = 0
let aliveCache = true

function probeRelay(timeoutMs = 600): Promise<boolean> {
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

/** Fire-and-forget: make sure the relay is listening. Never throws. */
export function ensureRelayAlive(): void {
  void (async () => {
    try {
      const now = Date.now()
      // Cache the probe for 10s — /api/ice can burst on several joins.
      if (now - lastAliveCheck > 10_000) {
        aliveCache = await probeRelay()
        lastAliveCheck = now
      }
      if (aliveCache) return
      if (now - lastSpawnAt < SPAWN_COOLDOWN_MS) return
      lastSpawnAt = now

      const cwd = process.cwd()
      const relayDir = `${cwd}/mini-services/signaling`
      console.log('[ensure-relay] relay down on :3003 — reviving…')
      // Pin the ports explicitly: the Next.js server sets process.env.PORT
      // for its own port, and an inherited PORT would send the relay to the
      // wrong one (bind failure → half-dead relay).
      let logFd: number | undefined
      try {
        logFd = openSync(`${relayDir}/relay.log`, 'a')
      } catch {
        /* logging is best-effort */
      }
      const child = spawn('bun', ['run', 'dev'], {
        cwd: relayDir,
        detached: true,
        stdio: logFd !== undefined ? ['ignore', logFd, logFd] : 'ignore',
        env: { ...process.env, PORT: '3003', INFO_PORT: '3004' },
      })
      child.unref()
      // Give it a moment, then refresh the cache so the next call sees truth.
      setTimeout(() => {
        void probeRelay(4000).then((ok) => {
          aliveCache = ok
          lastAliveCheck = Date.now()
          console.log(`[ensure-relay] revival ${ok ? 'succeeded' : 'failed'}`)
        })
      }, 3_000)
    } catch {
      /* never let a keeper break the endpoint */
    }
  })()
}
