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
