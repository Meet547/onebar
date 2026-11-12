/**
 * Next.js instrumentation — runs once when the Next.js server boots.
 * Node.js-specific work lives in `instrumentation-node.ts` so the Edge
 * runtime bundle never touches Node built-ins.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const mod = await import('./instrumentation-node')
    await mod.registerNode()
  }
}
