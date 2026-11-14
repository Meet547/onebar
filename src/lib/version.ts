/**
 * App version plumbing — pure logic for the client/server version handshake
 * and the one-time auto-reload guard. Kept dependency-free so it compiles to
 * CommonJS for the offline tests (scripts/version.test.cjs).
 *
 * Version values come from PICO_VERSION (baked into the client bundle as
 * NEXT_PUBLIC_PICO_VERSION via next.config env, and read from process.env at
 * the relay at runtime); next.config falls back to package.json's version.
 */

export function versionMismatch(
  client: string | null | undefined,
  server: string | null | undefined,
): boolean {
  // Unknown on either side → never reload: a missing version must not cause
  // reload loops on partial deploys.
  if (!client || !server) return false
  return client !== server
}

/** sessionStorage key + minimum spacing between auto-reloads. The chunk-error
 *  guard in public/version-guard.js reuses BOTH constants — change together. */
export const AUTO_RELOAD_KEY = 'pico-last-auto-reload'
export const AUTO_RELOAD_MIN_INTERVAL_MS = 60_000

/** Reload is allowed only once per AUTO_RELOAD_MIN_INTERVAL_MS — a mismatch
 *  that survives a reload (e.g. a proxy caching the old bundle) must not
 *  trap the user in a refresh loop. */
export function shouldAutoReload(now: number, last: number | null | undefined): boolean {
  if (last === null || last === undefined || Number.isNaN(last)) return true
  return now - last >= AUTO_RELOAD_MIN_INTERVAL_MS
}

/** Shared decision helper for both triggers (socket version mismatch and
 *  chunk load failure). Returns true when a reload should happen and records
 *  it. Storage failures (privacy mode) degrade to session-only behavior. */
export function checkAndMarkReload(
  now: number,
  readLast: () => number | null,
  markNow: () => void,
): boolean {
  if (!shouldAutoReload(now, readLast())) return false
  markNow()
  return true
}
