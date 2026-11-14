export type QualityPreset = 'auto' | 'saver' | 'balanced' | 'sharp'

export type NetworkLevel = 0 | 1 | 2 | 3 // bad, weak, ok, great

export interface PeerState {
  id: string
  name: string
  micOn: boolean
  camOn: boolean
  sharing: boolean
  level: NetworkLevel
  hasStream: boolean
  streamVersion: number
  /**
   * True while this peer's connection has not completed (or is being
   * re-established). Distinct from a weak-but-connected link: the UI shows
   * "Connecting…" instead of blaming the network quality.
   */
  connecting?: boolean
}

/* ---------------- music (listen together) ---------------- */

/** Extra audio sent when "Listen together" is on — Opus stereo, well above speech quality. */
export const MUSIC_BITRATE = 96_000
/** Music bitrate steps down with the network instead of fighting it. */
export const MUSIC_BITRATE_BY_LEVEL: Record<NetworkLevel, number> = {
  0: 48_000,
  1: 64_000,
  2: 96_000,
  3: 96_000,
}

export interface MusicState {
  /** Peer id of whoever is sharing music (null = nobody). */
  peerId: string | null
  title: string
  playing: boolean
  /** Seconds into the track at the time of the last broadcast. */
  position: number
  duration: number
}

export const INITIAL_MUSIC: MusicState = {
  peerId: null,
  title: '',
  playing: false,
  position: 0,
  duration: 0,
}

/* ---------------- passcode gate ---------------- */

/**
 * Room-entry gate hash (SHA-256 via Web Crypto, with a deterministic fallback
 * for non-secure contexts). The relay only compares hashes in memory — media
 * security does not depend on it: every packet is already encrypted with
 * DTLS-SRTP by the browser, and room ids are 9 random characters (unguessable).
 */
export async function hashPasscode(code: string): Promise<string> {
  const s = code.trim().toLowerCase()
  try {
    if (typeof crypto !== 'undefined' && crypto.subtle) {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
      return Array.from(new Uint8Array(buf))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
    }
  } catch {
    /* fall through to the sync fallback */
  }
  // Deterministic, self-consistent gate hash (FNV-1a, padded). Only used when
  // Web Crypto is unavailable — both sides of the same room run the same code.
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return ('fnv-' + h.toString(16) + '-' + s.length.toString(16)).padEnd(64, 'p').slice(0, 64)
}

export interface ChatMessage {
  id: string
  from: string
  name: string
  text: string
  ts: number
  system?: boolean
  /** Quoted message when this was sent as a reply (plain text snapshot). */
  replyTo?: { id: string; name: string; text: string }
}

export interface QualityProfile {
  width: number
  height: number
  frameRate: number
  /** Max outgoing video bitrate per peer, bits per second */
  maxBitrate: number
  label: string
}

export const QUALITY_PROFILES: Record<Exclude<QualityPreset, 'auto'>, QualityProfile> = {
  saver: { width: 256, height: 144, frameRate: 10, maxBitrate: 90_000, label: 'Data Saver · 144p' },
  balanced: { width: 480, height: 360, frameRate: 15, maxBitrate: 200_000, label: 'Balanced · 360p' },
  sharp: { width: 640, height: 480, frameRate: 24, maxBitrate: 550_000, label: 'Sharp · 480p' },
}

/** Bitrate caps applied per-connection when the network degrades. */
export const LINK_CAPS: Record<NetworkLevel, number | null> = {
  0: 50_000,
  1: 110_000,
  2: null, // use the profile default
  3: null, // use the profile default
}

/* ---------------- screen share ---------------- */

/**
 * Screen share gets its own budget — it is a different medium from a talking
 * head: text must stay readable (resolution-first) and motion is cheap
 * (screens rarely need more than ~15 fps). Compared to Chrome's default
 * screen capture (full resolution, up to 60 fps, no bitrate ceiling) these
 * caps cut encoder CPU by roughly an order of magnitude, which is what keeps
 * the sharer's machine — and everyone's viewer — smooth.
 *
 * Capture size follows the bitrate budget (task 9): 220 kbps carries a
 * readable 720p at 5 fps but not a 1080p slideshow — so saver captures 720p,
 * balanced/sharp get the full 1080p their budgets can carry.
 */
export const SCREEN_SHARE: Record<
  Exclude<QualityPreset, 'auto'>,
  { maxBitrate: number; maxFps: number; maxWidth: number; maxHeight: number }
> = {
  saver: { maxBitrate: 220_000, maxFps: 5, maxWidth: 1280, maxHeight: 720 },
  balanced: { maxBitrate: 600_000, maxFps: 15, maxWidth: 1920, maxHeight: 1080 },
  sharp: { maxBitrate: 1_100_000, maxFps: 24, maxWidth: 1920, maxHeight: 1080 },
}

export const ROOM_CODE_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789'

export function generateRoomCode(): string {
  let code = ''
  for (let i = 0; i < 9; i++) {
    if (i === 3 || i === 6) code += '-'
    code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)]
  }
  return code
}
