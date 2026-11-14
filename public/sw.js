/*
 * Pico app-shell service worker — repeat joins load from cache, not network.
 *
 * Strategies:
 *  - Navigations (HTML): cache-first with background revalidation. A repeat
 *    join renders instantly even on a dead/slow link; the fresh shell is
 *    fetched quietly and served on the NEXT visit. Deploy-safe: a cached old
 *    shell references its own hashed /_next/static chunks, which stay cached
 *    with it.
 *  - Static assets (/_next/static is content-hashed+immutable, fonts, icons,
 *    manifest): cache-first, fill-on-miss.
 *  - NEVER cached (always network): /api/* (incl. /api/ice — short-lived
 *    TURN credentials), /socket.io* and /signal* (signaling), /info,
 *    /healthz, Next.js HMR, and every non-GET request.
 */
const SHELL = 'pico-shell-v1'
const STATIC = 'pico-static-v1'
const NEVER_PREFIXES = ['/api/', '/socket.io', '/signal', '/info', '/healthz', '/_next/webpack-hmr']
const STATIC_RE = /\.(?:css|js|mjs|woff2?|png|jpe?g|webp|svg|ico)$/

self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Drop everything except the two caches this version owns.
      const keys = await caches.keys()
      await Promise.all(
        keys.filter((k) => k !== SHELL && k !== STATIC).map((k) => caches.delete(k)),
      )
      // Keep the static cache bounded (hashed chunks accumulate over deploys).
      const cache = await caches.open(STATIC)
      const entries = await cache.keys()
      if (entries.length > 400) {
        for (const old of entries.slice(0, entries.length - 200)) await cache.delete(old)
      }
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return
  if (NEVER_PREFIXES.some((p) => url.pathname.startsWith(p))) return
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(SHELL)
        const cached = await cache.match(req, { ignoreSearch: true })
        const revalidate = fetch(req)
          .then((res) => {
            if (res.ok) cache.put(req, res.clone())
            return res
          })
          .catch(() => null)
        if (cached) {
          event.waitUntil(revalidate)
          return cached
        }
        const fresh = await revalidate
        return fresh || new Response('Offline — no cached shell yet', { status: 503 })
      })(),
    )
    return
  }
  if (url.pathname.startsWith('/_next/static') || STATIC_RE.test(url.pathname) || url.pathname === '/manifest.webmanifest') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(STATIC)
        const hit = await cache.match(req)
        if (hit) return hit
        const res = await fetch(req)
        if (res.ok) cache.put(req, res.clone())
        return res
      })(),
    )
  }
})
