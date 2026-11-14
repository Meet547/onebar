import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

/**
 * Runtime deployment version — MUST agree with the build-time resolution in
 * next.config.ts (x-pico-version header + NEXT_PUBLIC_PICO_VERSION inline).
 * Resolution order (keep in sync with next.config.ts):
 *   1. PICO_VERSION env (explicit deploy override),
 *   2. .pico-version file (written by Dockerfile.standalone at build time —
 *      the git short hash of the build context — so a runtime image without
 *      git still reports the exact version the client bundle was built with),
 *   3. `git rev-parse --short HEAD` (repo checkouts, dev),
 *   4. package.json version, with a LOUD warning: a fallback here means the
 *      version is not per-deploy unique and the socket version handshake /
 *      service-worker pruning degrade to best-effort. check-live.sh flags it.
 */
let cached: string | null | undefined

export function resolvePicoVersion(): string | null {
  if (cached !== undefined) return cached
  const env = process.env.PICO_VERSION
  if (env) return (cached = env)
  try {
    const fromFile = readFileSync('.pico-version', 'utf8').trim()
    if (fromFile) return (cached = fromFile)
  } catch {
    /* no build-stamp file */
  }
  try {
    const sha = execSync('git rev-parse --short HEAD', {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim()
    if (sha) return (cached = sha)
  } catch {
    /* not a git checkout (or no git binary) */
  }
  try {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version?: string }
    console.error(
      `[pico] PICO_VERSION is unset and unresolvable (no .pico-version, no git) — ` +
        `falling back to package.json "${pkg.version ?? 'dev'}", which is NOT unique per deploy. ` +
        `Set PICO_VERSION (e.g. the git short SHA) or build from a git checkout — see DEPLOY.md.`,
    )
    return (cached = pkg.version ?? null)
  } catch {
    return (cached = null)
  }
}
