/**
 * Build-time inlined deployment version (next.config env → NEXT_PUBLIC_*).
 * Client-safe accessor — the socket version handshake (engine) and the
 * ?debug=1 field report both read this; it MUST equal the x-pico-version
 * header and /api/health's version (see src/lib/server-version.ts).
 */
export const NEXT_PUBLIC_PICO_VERSION: string | null =
  (process.env.NEXT_PUBLIC_PICO_VERSION as string | undefined) || null
