/**
 * Next.js instrumentation hook — runs once per server process.
 *
 * Node runtime only: this is where the signaling relay keeper boots, so the
 * relay on :3003 comes up together with the app (sandbox cold boots, `next
 * dev` restarts) instead of dying with the previous box. The Edge runtime
 * must not touch Node APIs — hence the strict runtime guard.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  // Vercel uses the WebSocket function endpoint and Redis-backed relay.
  if (process.env.VERCEL) return
  // Docker production stack runs the relay as its own supervised container.
  if (process.env.PICO_EMBEDDED_RELAY === '0') return
  const { startRelayKeeper } = await import('./lib/ensure-relay')
  startRelayKeeper()
}
