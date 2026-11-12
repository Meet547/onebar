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
 * Small, fast, dependency-free hash used ONLY as a room entry gate on the
 * signaling relay. Media security does not depend on it: every packet is
 * already encrypted with DTLS-SRTP by the browser.
 */
export function hashPasscode(code: string): string {
  const s = code.trim().toLowerCase()
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  const v = 4294967296 * (2097151 & h2) + (h1 >>> 0)
  return v.toString(16)
}

export interface ChatMessage {
  id: string
  from: string
  name: string
  text: string
  ts: number
  system?: boolean
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

export const ROOM_CODE_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789'

export function generateRoomCode(): string {
  let code = ''
  for (let i = 0; i < 9; i++) {
    if (i === 3 || i === 6) code += '-'
    code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)]
  }
  return code
}
