/*
 * Pico version guard — plain JS, runs before React on every page.
 *  1. Registers the app-shell service worker (HTTPS-only).
 *  2. Auto-reloads ONCE when a lazy-loaded chunk fails to load: a deploy
 *     changed the bundle underneath a long-lived tab and its hashed chunk
 *     URLs 404. The socket version check in the engine covers the other
 *     direction (server moved ahead of the page).
 * The one-time guard (sessionStorage key + 60 s minimum spacing) mirrors
 * src/lib/version.ts — change them together.
 */
(function () {
  var KEY = 'pico-last-auto-reload'
  var MIN_INTERVAL = 60000
  function readLast() {
    try {
      var v = Number(sessionStorage.getItem(KEY))
      return v > 0 ? v : null
    } catch (e) {
      return null
    }
  }
  function mark() {
    try {
      sessionStorage.setItem(KEY, String(Date.now()))
    } catch (e) {
      /* storage disabled */
    }
  }
  function maybeReload(reason) {
    var last = readLast()
    var now = Date.now()
    if (last && now - last < MIN_INTERVAL) return
    mark()
    console.warn('[pico] auto-reload (' + reason + ')')
    location.reload()
  }
  function isChunkFailure(msg) {
    return /ChunkLoadError|Loading chunk|Failed to fetch dynamically imported module|error loading dynamically imported module/i.test(
      msg || '',
    )
  }
  // capture phase: script element failures fire on the element, not window
  window.addEventListener(
    'error',
    function (e) {
      var t = e && e.target
      if (t && t.tagName === 'SCRIPT' && t.src && t.src.indexOf(location.origin) === 0) {
        maybeReload('static-script-failed')
        return
      }
      if (e && isChunkFailure(e.message)) maybeReload('chunk-load-failed')
    },
    true,
  )
  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason
    var m = r && (r.message || r.name)
    if (isChunkFailure(m || String(r))) maybeReload('chunk-load-failed')
  })

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js').catch(function () {})
    })
  }
})()
