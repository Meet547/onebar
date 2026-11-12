'use client'

import { create } from 'zustand'
import type { ChatMessage, MusicState, NetworkLevel, PeerState, QualityPreset } from './types'
import { INITIAL_MUSIC } from './types'

/**
 * MediaStream registry — deliberately OUTSIDE React state.
 * Video elements attach streams imperatively via refs, so streaming never
 * triggers React reconciliation. Only tiny flags (streamVersion) enter the
 * store, which keeps the UI update cost near zero.
 */
const streamRegistry = new Map<string, MediaStream>()

export const getStream = (peerId: string) => streamRegistry.get(peerId) ?? null
export const setStream = (peerId: string, stream: MediaStream | null) => {
  if (stream) streamRegistry.set(peerId, stream)
  else streamRegistry.delete(peerId)
}

export interface SelfState {
  id: string
  name: string
  micOn: boolean
  camOn: boolean
  sharing: boolean
}

interface CallStore {
  signalingConnected: boolean
  self: SelfState
  peers: Record<string, PeerState>
  chat: ChatMessage[]
  unreadChat: number
  preset: QualityPreset
  effectiveLabel: string
  overallLevel: NetworkLevel
  bitrateKbps: number
  spotlight: string | null // peer id (or 'self') that is sharing a screen
  /** Socket id of the meeting host — null until the server confirms. */
  hostId: string | null
  /** True when the host locked the call (no new joins). */
  locked: boolean
  /** True when the room was created with a passcode. */
  passcodeProtected: boolean
  /** Set when the host removed us — page-level banner + bounce to home. */
  kicked: boolean
  /** Listen-together state (one music session per room). */
  music: MusicState

  setSignalingConnected: (v: boolean) => void
  setSelf: (partial: Partial<SelfState>) => void
  setPeers: (peers: PeerState[]) => void
  upsertPeer: (peer: PeerState) => void
  removePeer: (peerId: string) => void
  patchPeer: (peerId: string, partial: Partial<PeerState>) => void
  bumpPeerStream: (peerId: string, has: boolean) => void
  addChat: (msg: ChatMessage) => void
  clearUnread: () => void
  setPreset: (p: QualityPreset) => void
  setEffectiveLabel: (l: string) => void
  setOverallLevel: (l: NetworkLevel) => void
  setSpotlight: (id: string | null) => void
  setHostId: (id: string | null) => void
  setLocked: (v: boolean) => void
  setPasscodeProtected: (v: boolean) => void
  setKicked: (v: boolean) => void
  setMusic: (partial: Partial<MusicState>) => void
  reset: () => void
}

const initialSelf: SelfState = { id: '', name: 'Guest', micOn: true, camOn: true, sharing: false }

export const useCallStore = create<CallStore>((set, get) => ({
  signalingConnected: false,
  self: initialSelf,
  peers: {},
  chat: [],
  unreadChat: 0,
  preset: 'balanced',
  effectiveLabel: '',
  overallLevel: 3,
  bitrateKbps: 0,
  spotlight: null,
  hostId: null,
  locked: false,
  passcodeProtected: false,
  kicked: false,
  music: INITIAL_MUSIC,

  setSignalingConnected: (v) => set({ signalingConnected: v }),
  setSelf: (partial) => set((s) => ({ self: { ...s.self, ...partial } })),
  setPeers: (peers) =>
    set(() => ({
      peers: Object.fromEntries(peers.map((p) => [p.id, p])),
    })),
  upsertPeer: (peer) => set((s) => ({ peers: { ...s.peers, [peer.id]: peer } })),
  removePeer: (peerId) =>
    set((s) => {
      const peers = { ...s.peers }
      delete peers[peerId]
      const spotlight = s.spotlight === peerId ? null : s.spotlight
      return { peers, spotlight }
    }),
  patchPeer: (peerId, partial) =>
    set((s) => {
      const p = s.peers[peerId]
      if (!p) return s
      return { peers: { ...s.peers, [peerId]: { ...p, ...partial } } }
    }),
  bumpPeerStream: (peerId, has) =>
    set((s) => {
      const p = s.peers[peerId]
      if (!p) return s
      return {
        peers: {
          ...s.peers,
          [peerId]: { ...p, hasStream: has, streamVersion: p.streamVersion + 1 },
        },
      }
    }),
  addChat: (msg) =>
    set((s) => ({
      chat: [...s.chat.slice(-199), msg],
      unreadChat:
        msg.from !== s.self.id && msg.from !== 'system' ? s.unreadChat + 1 : s.unreadChat,
    })),
  clearUnread: () => set({ unreadChat: 0 }),
  setPreset: (p) => set({ preset: p }),
  setEffectiveLabel: (l) => set({ effectiveLabel: l }),
  setOverallLevel: (l) => set({ overallLevel: l }),
  setSpotlight: (id) => set({ spotlight: id }),
  setHostId: (id) => set({ hostId: id }),
  setLocked: (v) => set({ locked: v }),
  setPasscodeProtected: (v) => set({ passcodeProtected: v }),
  setKicked: (v) => set({ kicked: v }),
  setMusic: (partial) => set((s) => ({ music: { ...s.music, ...partial } })),
  reset: () =>
    set({
      signalingConnected: false,
      self: { ...initialSelf, name: get().self.name },
      peers: {},
      chat: [],
      unreadChat: 0,
      overallLevel: 3,
      bitrateKbps: 0,
      spotlight: null,
      hostId: null,
      locked: false,
      passcodeProtected: false,
      kicked: false,
      music: INITIAL_MUSIC,
    }),
}))
