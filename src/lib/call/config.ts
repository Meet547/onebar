/**
 * Pico runtime configuration.
 *
 * Signaling uses the SAME origin as the app, through Next.js rewrites
 * (/signal/* → relay, /info/* → room-info probe). That is what makes the
 * relay reachable from every front door — preview proxy, gateway, direct
 * port — because the browser only ever talks to the origin it loaded the
 * page from.
 *
 * Self-hosting behind your own domain (see DEPLOY.md): point the rewrites'
 * RELAY_UPSTREAM / INFO_UPSTREAM at the relay boxes, or override the client
 * endpoints at build time:
 *   NEXT_PUBLIC_SIGNALING_URL=https://sig.example.com
 *   NEXT_PUBLIC_SOCKET_PATH=/socket.io
 *   NEXT_PUBLIC_ROOM_INFO_URL=https://sig.example.com/info
 *
 * NOTE: NEXT_PUBLIC_* values are inlined into the client bundle at build time.
 */

/** Empty string = same origin (socket.io defaults to window location). */
export const SIGNALING_URL = process.env.NEXT_PUBLIC_SIGNALING_URL || ""

export const SOCKET_PATH = process.env.NEXT_PUBLIC_SOCKET_PATH || "/signal/"

export const ROOM_INFO_URL = process.env.NEXT_PUBLIC_ROOM_INFO_URL || "/info"
