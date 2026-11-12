/**
 * Pico runtime configuration.
 *
 * Every deployment-specific URL is env-driven so the same build works behind
 * any reverse proxy. Defaults match the sandbox gateway (single origin, the
 * Caddy gateway routes by the XTransformPort query parameter).
 *
 * Production (see DEPLOY.md): build with e.g.
 *   NEXT_PUBLIC_SIGNALING_URL=https://sig.example.com
 *   NEXT_PUBLIC_ROOM_INFO_URL=https://sig.example.com/info
 * or, on a single domain:
 *   NEXT_PUBLIC_SIGNALING_URL=/
 *   NEXT_PUBLIC_SOCKET_PATH=/socket.io
 *   NEXT_PUBLIC_ROOM_INFO_URL=/info
 *
 * NOTE: NEXT_PUBLIC_* values are inlined into the client bundle at build time.
 */

export const SIGNALING_URL =
  process.env.NEXT_PUBLIC_SIGNALING_URL || '/?XTransformPort=3003'

export const SOCKET_PATH = process.env.NEXT_PUBLIC_SOCKET_PATH || '/'

export const ROOM_INFO_URL =
  process.env.NEXT_PUBLIC_ROOM_INFO_URL || '/info?XTransformPort=3004'
