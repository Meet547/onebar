import { upgradeWebSocket } from '@vercel/functions'
import { handleVercelSocket } from '@/lib/vercel-relay'

export const runtime = 'nodejs'
export const maxDuration = 300

export async function GET(request: Request) {
  const origin = request.headers.get('origin')
  if (origin) {
    const allowedHost = request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? ''
    const allowlist = (process.env.ORIGIN ?? '').split(',').map((value) => value.trim()).filter(Boolean)
    let sameOrigin = false
    try { sameOrigin = new URL(origin).host === allowedHost } catch { /* reject below */ }
    let configuredOrigin = false
    try { configuredOrigin = allowlist.includes(new URL(origin).origin) || new URL(origin).origin === new URL(process.env.NEXT_PUBLIC_SITE_URL ?? '').origin } catch { /* no configured public origin */ }
    if (!sameOrigin && !configuredOrigin) return new Response('Forbidden', { status: 403 })
  }
  return upgradeWebSocket((socket) => handleVercelSocket(socket, request), { maxPayload: 100_000 })
}
