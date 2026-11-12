/**
 * Node.js runtime instrumentation (never bundled for the Edge runtime).
 *
 * The signaling mini-service lives in `mini-services/signaling` (port 3003).
 * To survive sandbox restarts, we probe port 3003 on every Next.js boot and
 * respawn the service if it is not running. The dev server is managed by the
 * platform, so this makes signaling self-healing wherever Next.js runs.
 */
export async function registerNode() {
  const g = globalThis as { __picoSignalingSpawn?: Promise<void> }
  if (g.__picoSignalingSpawn) return
  g.__picoSignalingSpawn = (async () => {
    try {
      const net = await import('node:net')
      const alive = await new Promise<boolean>((resolve) => {
        const probe = net.connect(3003, '127.0.0.1')
        const done = (v: boolean) => {
          probe.destroy()
          resolve(v)
        }
        probe.once('connect', () => done(true))
        probe.once('error', () => done(false))
        setTimeout(() => done(false), 1500).unref()
      })
      if (alive) {
        console.log('[pico] signaling service already running on :3003')
        return
      }

      const { spawn } = await import('node:child_process')
      const path = await import('node:path')
      const cwd = path.join(process.cwd(), 'mini-services', 'signaling')
      const child = spawn('bun', ['index.ts'], {
        cwd,
        stdio: 'ignore',
        detached: true,
        env: process.env,
      })
      child.unref()
      console.log('[pico] signaling service spawned on :3003 (pid', child.pid, ')')
    } catch (err) {
      console.error('[pico] failed to ensure signaling service:', err)
    }
  })()
}
