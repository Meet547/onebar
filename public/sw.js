/*
 * Pico app-shell service worker — repeat joins load from cache, not network.
 *
 * Caches are PER-APP-VERSION: the version comes from the x-pico-version
 * response header on navigations (set by next.config.ts from PICO_VERSION)
 * with /api/health as a fallback on first install. The CURRENT and PREVIOUS
 * versions' caches are kept, so an old tab's shell keeps its own hashed
 * chunks across exactly one version transition; everything older is pruned
 * (pruning is tied to the active version, not a counter).
 *
 * Strategies:
 *  - Navigations (HTML): cache-first with background revalidation. A repeat
 *    join renders instantly even on a dead/slow link; the fresh shell is
 *    fetched quietly and served on the NEXT visit. A version change in the
 *    revalidation switches the active cache set.
 *  - Static assets (/_next/static is content-hashed+immutable, fonts, icons,
 *    manifest): cache-first fill-on-miss, falling back to the PREVIOUS
 *    version's cache before the network (that is what keeps an old shell
 *    working after a deploy).
 *  - NEVER cached (always network): /api/* (incl. /api/ice — short-lived
 *    TURN credentials), /socket.io* and /signal* (signaling), /info,
 *    /healthz, Next.js HMR, and every non-GET request.
 */
const META = 'pico-meta-v1'
const NEVER_PREFIXES = ['/api/', '/socket.io', '/signal', '/info', '/healthz', '/_next/webpack-hmr']
const STATIC_RE = /\.(?:css|js|mjs|woff2?|png|jpe?g|webp|svg|ico)$/

let state = null // { version: string|null, previous: string|null }

async function loadState() {
  if (state) return state
  try {
    const cache = await caches.open(META)
    const res = await cache.match('/__pico-state')
    const st = res ? await res.json() : null
    state = { version: (st && st.version) || null, previous: (st && st.previous) || null }
  } catch (e) {
    state = { version: null, previous: null }
  }
  return state
}

async function saveState() {
  try {
    const cache = await caches.open(META)
    await cache.put('/__pico-state', new Response(JSON.stringify(state)))
  } catch (e) {
    /* state stays session-only */
  }
}

function sanitize(v) {
  return String(v || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '')
}
function shellName(v) {
  return `pico-shell-${sanitize(v)}`
}
function staticName(v) {
  return `pico-static-${sanitize(v)}`
}

/** Prune every per-version cache that is neither current nor previous. */
async function pruneVersions() {
  const st = await loadState()
  const keep = new Set([
    shellName(st.version),
    staticName(st.version),
    shellName(st.previous),
    staticName(st.previous),
  ])
  const keys = await caches.keys()
  await Promise.all(
    keys
      .filter((k) => /^pico-(shell|static)-/.test(k) && !keep.has(k))
      .map((k) => caches.delete(k)),
  )
}

/** Switch the active version (from a navigation response header). Keeps the
 *  outgoing version as `previous` so in-flight pages keep their chunks. */
async function adoptVersion(v) {
  const st = await loadState()
  if (!v || v === st.version) return st
  st.previous = st.version
  st.version = v
  state = st
  await saveState()
  await pruneVersions()
  return st
}

async function discoverVersion() {
  try {
    const res = await fetch('/api/health', { cache: 'no-store' })
    if (res.ok) {
      const j = await res.json()
      if (j && j.version) await adoptVersion(j.version)
    }
  } catch (e) {
    /* offline — the version arrives with the first navigation instead */
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(discoverVersion().catch(() => {}))
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      await pruneVersions()
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
        const st = await loadState()
        const cache = await caches.open(shellName(st.version))
        const cached = await cache.match(req, { ignoreSearch: true })
        const revalidate = fetch(req)
          .then(async (res) => {
            if (res.ok) {
              // The response knows its own build — adopt it for the NEXT
              // navigation, then file the shell under that version.
              const v = res.headers.get('x-pico-version')
              const st2 = await adoptVersion(v)
              const freshCache = await caches.open(shellName(st2.version))
              await freshCache.put(req, res.clone())
            }
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
        const st = await loadState()
        const cache = await caches.open(staticName(st.version))
        const hit = await cache.match(req)
        if (hit) return hit
        // Old tab on the previous version? Serve its chunk from the previous
        // cache before touching the network — this is what keeps an old
        // shell working after a deploy swapped the hashed asset names.
        if (st.previous) {
          const prev = await caches.open(staticName(st.previous))
          const prevHit = await prev.match(req)
          if (prevHit) return prevHit
        }
        const res = await fetch(req)
        if (res.ok) cache.put(req, res.clone())
        return res
      })(),
    )
  }
})
