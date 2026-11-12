'use client'

import { io, type Socket } from 'socket.io-client'
import { toast } from 'sonner'
import { SIGNALING_URL, SOCKET_PATH } from './config'
import { useCallStore, setStream as putStream } from './store'
import { createTestStream, createTestScreenStream } from './test-stream'
import { clearAllAudio, trackAudio } from './audio-levels'
import { attachRemoteMusic, detachRemoteMusic } from './music'
import {
  LINK_CAPS,
  MUSIC_BITRATE,
  MUSIC_BITRATE_BY_LEVEL,
  INITIAL_MUSIC,
  QUALITY_PROFILES,
  type NetworkLevel,
  type QualityPreset,
  type QualityProfile,
} from './types'

/**
 * Pico call engine — peer-to-peer WebRTC mesh.
 *
 * Design goals:
 *  - Media never touches a server: every audio/video packet travels directly
 *    between participants (mesh topology). The signaling socket only carries
 *    SDP/ICE/chat text.
 *  - Renegotiation-free quality control: resolution/fps changes ride on
 *    applyConstraints(), bitrate changes on setParameters(), screen share on
 *    replaceTrack(). No expensive offer/answer churn.
 *  - Opus DTX + 24 kbps cap: silence costs (almost) nothing on the wire.
 *  - Per-link adaptive bitrate: getStats() every 3s classifies each
 *    connection (RTT + packet loss) and caps outgoing video per link, so one
 *    weak participant never drags the whole call down.
 *  - Perfect-negotiation pattern (polite/impolite) for glare-free offers.
 */

const ICE_SERVERS: RTCIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: ['stun:stun.cloudflare.com:3478'] },
]

/**
 * ICE servers with TURN support, fetched from /api/ice. TURN is what makes
 * calls work between strict NATs (mobile carriers, offices, hotel wifi) —
 * without it a meaningful slice of real-world pairs can never connect.
 * Cached for an hour; a failed fetch falls back to STUN-only, never blocks
 * the call for more than the 4s timeout.
 */
const ICE_CACHE_TTL_MS = 3_600_000
let iceCache: { servers: RTCIceServer[]; at: number } | null = null

async function fetchIceServers(force = false): Promise<RTCIceServer[]> {
  if (!force && iceCache && Date.now() - iceCache.at < ICE_CACHE_TTL_MS) return iceCache.servers
  try {
    const ctrl = new AbortController()
    // Generous budget: during a cold boot the endpoint waits for the relay
    // keeper to finish reviving before it answers at all.
    const timer = window.setTimeout(() => ctrl.abort(), 10_000)
    const res = await fetch('/api/ice', { signal: ctrl.signal, cache: 'no-store' })
    window.clearTimeout(timer)
    if (res.ok) {
      const data = (await res.json()) as { iceServers?: RTCIceServer[] }
      if (Array.isArray(data.iceServers) && data.iceServers.length > 0) {
        iceCache = { servers: data.iceServers, at: Date.now() }
        return iceCache.servers
      }
    }
  } catch {
    /* unreachable or slow — STUN-only still works on friendly networks */
  }
  iceCache = { servers: ICE_SERVERS, at: Date.now() }
  return iceCache.servers
}

const AUDIO_SENDER_BITRATE = 24_000
const STATS_INTERVAL_MS = 3000

export type MediaMode = 'full' | 'audio' | 'none'

export interface StartOptions {
  roomId: string
  name: string
  preset: QualityPreset
  /** Preview stream acquired on the pre-join screen, reused to avoid opening the camera twice. */
  initialStream?: MediaStream | null
  testMode?: boolean
  /** Hashed room passcode (see hashPasscode) — required when the room is protected. */
  passwordHash?: string
}

interface LinkInfo {
  lastCap: number | null
}

/** Everything the engine needs from a live music source. Optional control
 *  hooks exist only for element-backed sources (files), not raw tracks. */
export interface MusicSource {
  stream: MediaStream
  title: string
  duration: number
  getPosition(): number
  isPlaying(): boolean
  play?(): Promise<void>
  pause?(): void
  seek?(t: number): void
  setMonitorVolume?(v: number): void
  stop?(): void
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Opus tuning per m-section. Speech sections get DTX + a 24 kbps ceiling so
 * silence costs (almost) nothing; music sections get stereo and a high
 * ceiling. Sections are recognized by their msid (local sends) or by mid
 * (recvonly answers, where the msid lives in the remote offer).
 */
function mungeOpus(sdp: string, musicIds: Set<string>, musicMids: Set<string>): string {
  const lines = sdp.split('\r\n')
  const mIdx: number[] = []
  lines.forEach((l, i) => {
    if (l.startsWith('m=')) mIdx.push(i)
  })
  mIdx.push(lines.length)

  const sectionMusic = new Array<boolean>(lines.length).fill(false)
  for (let s = 0; s < mIdx.length - 1; s++) {
    const from = mIdx[s]
    const to = mIdx[s + 1]
    let music = false
    for (let i = from; i < to; i++) {
      const msid = lines[i].match(/^a=msid:(\S+)/)
      if (msid && musicIds.has(msid[1])) {
        music = true
        break
      }
      const mid = lines[i].match(/^a=mid:(.+)$/)
      if (mid && musicMids.has(mid[1].trim())) {
        music = true
        break
      }
    }
    for (let i = from; i < to; i++) sectionMusic[i] = music
  }

  const opusPTs = new Set<string>()
  for (const line of lines) {
    const m = line.match(/^a=rtpmap:(\d+) opus\/48000/i)
    if (m) opusPTs.add(m[1])
  }

  const out = lines.map((line, i) => {
    const m = line.match(/^a=fmtp:(\d+)(.*)$/)
    if (!m || !opusPTs.has(m[1])) return line
    let params = m[2] ?? ''
    if (sectionMusic[i]) {
      params = params.replace(/;?(usedtx|maxaveragebitrate|stereo)=[^;]*/gi, '')
      params += ';stereo=1;maxaveragebitrate=128000'
    } else {
      params = params.replace(/;?(stereo|maxaveragebitrate)=[^;]*/gi, '')
      if (!/usedtx/i.test(params)) params += ';usedtx=1'
      if (!/maxaveragebitrate/i.test(params)) params += ';maxaveragebitrate=24000'
    }
    return `a=fmtp:${m[1]}${params}`
  })
  return out.join('\r\n')
}

function classifyLink(rttSec: number | null, lossFrac: number | null): NetworkLevel {
  const rtt = rttSec ?? 0.4
  const loss = lossFrac ?? 0.05
  if (rtt > 0.5 || loss > 0.08) return 0
  if (rtt > 0.3 || loss > 0.05) return 1
  if (rtt > 0.15 || loss > 0.02) return 2
  return 3
}

/* ------------------------------------------------------------------ */
/* Engine                                                              */
/* ------------------------------------------------------------------ */

export class CallEngine {
  private socket: Socket | null = null
  private roomId = ''
  private myId = ''
  private localStream: MediaStream | null = null
  private cameraTrack: MediaStreamTrack | null = null
  private micTrack: MediaStreamTrack | null = null
  private screenTrack: MediaStreamTrack | null = null
  private pcs = new Map<string, RTCPeerConnection>()
  private sendersMap = new Map<string, { audio?: RTCRtpSender; video?: RTCRtpSender; music?: RTCRtpSender }>()
  private pendingIce = new Map<string, RTCIceCandidateInit[]>()
  private links = new Map<string, LinkInfo>()
  private statsTimer: number | null = null
  private makingOffer = new Map<string, boolean>()
  private ignoreOffer = new Map<string, boolean>()
  /** Per-peer signaling op queue — SRD/SLD calls must never interleave. */
  private sigQueue = new Map<string, Promise<void>>()
  /** When our last offer went out per peer — drives the renegotiation watchdog. */
  private lastOfferAt = new Map<string, number>()
  private preset: QualityPreset = 'balanced'
  private adaptiveProfile: Exclude<QualityPreset, 'auto'> = 'balanced'
  private badCount = 0
  private goodCount = 0
  private started = false
  private testMode = false
  private mediaMode: MediaMode = 'full'
  private prevBytes = new Map<string, number>()
  private passwordHash = ''
  private iceServers: RTCIceServer[] = ICE_SERVERS

  /**
   * Create the signaling socket and resolve only once it is actually live.
   *
   * Polling-first is deliberate: the initial handshake rides plain HTTP,
   * which survives every proxy, VPN and captive portal on the planet, then
   * socket.io transparently upgrades to websocket. Websocket-first dead-ends
   * behind proxies that block or hang upgrades — there is no downgrade path.
   *
   * /api/ice (fetched just above) also wakes the relay server-side before it
   * answers, so a relay lost to a recycled box is usually alive again before
   * this handshake even starts. If it still fails, start() retries once
   * before surfacing an error — a transient outage never becomes a dead end.
   */
  private async connectSignaling(forceIce: boolean): Promise<Socket> {
    this.iceServers = await fetchIceServers(forceIce)
    const socket = io(SIGNALING_URL, {
      path: SOCKET_PATH,
      transports: ['polling', 'websocket'],
      upgrade: true,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 4000,
      timeout: 10000,
    })
    this.socket = socket
    // Dev/debug handle (harmless in prod, invaluable for live diagnostics)
    if (typeof window !== 'undefined') {
      ;(window as unknown as { __pico?: unknown }).__pico = { engine: this, socket }
    }
    socket.on('connect', () => {
      useCallStore.getState().setSignalingConnected(true)
      if (this.myId) this.rejoin()
    })
    socket.on('disconnect', () => useCallStore.getState().setSignalingConnected(false))
    socket.on('connect_error', () => useCallStore.getState().setSignalingConnected(false))

    // Gate on the first real connect. The temporary listeners are removed
    // once settled so they can never kill socket.io's own reconnection loop
    // on a later mid-call hiccup.
    await new Promise<void>((resolve, reject) => {
      let guard = 0
      const finish = (ok: boolean) => {
        window.clearTimeout(guard)
        socket.off('connect', onOk)
        socket.off('connect_error', onFail)
        if (ok) {
          resolve()
          return
        }
        socket.disconnect()
        reject(new Error('relay unreachable'))
      }
      const onOk = () => finish(true)
      const onFail = () => finish(false)
      guard = window.setTimeout(onFail, 9_000)
      socket.once('connect', onOk)
      socket.once('connect_error', onFail)
    })
    return socket
  }

  /* listen together */
  private musicSource: MusicSource | null = null
  private musicHandleStop: (() => void) | null = null
  private musicUnsub: (() => void) | null = null
  private musicMetaTimer: number | null = null
  private musicStreamId = ''
  private musicOrigin: 'file' | 'test' | 'tab' = 'file'
  private lastMusicBitrate = 0
  private remoteMusicStreamIds = new Set<string>()
  private musicMids = new Set<string>()
  private lastRemoteSdp = ''

  async start(opts: StartOptions): Promise<{ mode: MediaMode }> {
    if (this.started) await this.leave(true)
    this.started = true
    this.roomId = opts.roomId
    this.preset = opts.preset
    this.adaptiveProfile = opts.preset === 'auto' ? 'balanced' : opts.preset
    this.testMode = !!opts.testMode
    this.passwordHash = opts.passwordHash ?? ''

    const store = useCallStore.getState()
    store.setSelf({ name: opts.name })
    store.setPreset(opts.preset)
    store.setEffectiveLabel(this.effectiveLabel())

    // ---- ICE + Signaling ----
    // /api/ice hands out TURN/STUN *and* (server-side) waits for the relay to
    // listen before it answers; connectSignaling() then resolves only once the
    // socket is genuinely connected. A relay lost to a recycled box / dev
    // restart heals right here — one controlled retry, invisible to the user.
    let socket: Socket
    try {
      socket = await this.connectSignaling(false)
    } catch {
      // Second and last attempt: the keeper has now been nudged twice
      // server-side; give it a breath, force-refresh ICE, reconnect fresh.
      await new Promise((r) => setTimeout(r, 1_200))
      try {
        socket = await this.connectSignaling(true)
      } catch {
        await this.cleanupAfterFailedJoin()
        throw new Error('Could not reach the call relay. Check your connection and try again.')
      }
    }

    // ---- Local media ----
    this.localStream = opts.initialStream ?? null
    if (this.localStream) {
      this.micTrack = this.localStream.getAudioTracks()[0] ?? null
      this.cameraTrack = this.localStream.getVideoTracks()[0] ?? null
      this.mediaMode = this.cameraTrack ? 'full' : this.micTrack ? 'audio' : 'none'
      // Register the handed-over preview stream so tiles can attach to it
      putStream('self', this.localStream)
    }
    if (!this.localStream || (!this.cameraTrack && !this.micTrack)) {
      this.mediaMode = await this.acquireMedia()
    }
    this.applyInitialTrackState()
    trackAudio('self', this.localStream)

    // ---- Room ----
    // The ack races a timeout so a dead signaling server can never hang the UI.
    // A rejected join (full room, wrong passcode, locked) aborts the start.
    const joinResult = await new Promise<{ ok: boolean; reason?: string; hostId?: string; locked?: boolean }>((resolve) => {
      let settled = false
      const finish = (r: { ok: boolean; reason?: string }) => {
        if (!settled) {
          settled = true
          resolve(r)
        }
      }
      const guard = window.setTimeout(
        () => finish({ ok: false, reason: 'Could not reach the call relay. Check your connection and try again.' }),
        12000,
      )
      socket.emit(
        'room:join',
        { roomId: this.roomId, name: opts.name, passwordHash: this.passwordHash },
        (res: { ok: boolean; self?: { id: string }; peers?: Array<{ id: string; name: string; micOn: boolean; camOn: boolean; sharing: boolean }>; hostId?: string; locked?: boolean; hasPassword?: boolean; music?: { peerId: string; title: string; playing: boolean; position: number; duration: number; streamId?: string } | null; reason?: string }) => {
          window.clearTimeout(guard)
          if (!res?.ok) {
            finish({ ok: false, reason: res?.reason ?? 'Could not join the room' })
            return
          }
          this.myId = res?.self?.id ?? socket.id!
          useCallStore.getState().setSelf({ id: this.myId })
          useCallStore.getState().setHostId(res.hostId ?? null)
          useCallStore.getState().setLocked(!!res.locked)
          useCallStore.getState().setPasscodeProtected(!!res.hasPassword)
          if (res.music?.peerId) {
            // Late joiner: the music track is already flowing — learn its
            // stream id now so the incoming ontrack is routed to the player.
            this.remoteMusicStreamIds.clear()
            if (res.music.streamId) this.remoteMusicStreamIds.add(res.music.streamId)
            useCallStore.getState().setMusic({
              peerId: res.music.peerId,
              title: res.music.title,
              playing: res.music.playing,
              position: res.music.position,
              duration: res.music.duration,
            })
          }
          if (res?.peers) this.reconcilePeers(res.peers)
          finish({ ok: true })
        },
      )
    })

    if (!joinResult.ok) {
      await this.cleanupAfterFailedJoin()
      throw new Error(joinResult.reason ?? 'Could not join the room')
    }

    // ---- Events ----
    socket.on('peer:joined', ({ peer }: { peer: { id: string; name: string; micOn: boolean; camOn: boolean; sharing: boolean } }) => {
      this.ensurePeer(peer.id, peer.name, peer.micOn, peer.camOn, peer.sharing)
      useCallStore.getState().addChat({
        id: 'sys-' + Math.random(),
        from: 'system',
        name: 'System',
        text: `${peer.name} joined`,
        ts: Date.now(),
        system: true,
      })
    })
    socket.on('peer:left', ({ peerId }: { peerId: string }) => this.dropPeer(peerId))
    socket.on('room:peers', ({ peers }: { peers: Array<{ id: string; name: string; micOn: boolean; camOn: boolean; sharing: boolean }> }) => {
      // Only meaningful after a reconnect — reconcile full presence
      if (this.myId) this.reconcilePeers(peers)
    })
    socket.on('peer:state', ({ peerId, micOn, camOn, sharing }: { peerId: string; micOn: boolean; camOn: boolean; sharing: boolean }) => {
      const store = useCallStore.getState()
      store.patchPeer(peerId, { micOn, camOn, sharing })
      // Follow whoever is presenting, so a remote screen never hides in a small tile
      if (sharing && store.spotlight !== peerId) store.setSpotlight(peerId)
      else if (!sharing && store.spotlight === peerId) store.setSpotlight(null)
    })
    socket.on('chat:message', (msg: { id: string; from: string; name: string; text: string; ts: number }) => {
      useCallStore.getState().addChat(msg)
    })

    /* ---- security & host controls ---- */
    socket.on('host:changed', ({ hostId }: { hostId: string }) => {
      useCallStore.getState().setHostId(hostId)
      if (hostId === this.myId) {
        toast('You are now the host', { duration: 2400 })
        useCallStore.getState().addChat({
          id: 'sys-' + Math.random(),
          from: 'system',
          name: 'System',
          text: 'You are now the host',
          ts: Date.now(),
          system: true,
        })
      }
    })
    socket.on('host:force-mute', () => {
      if (this.micTrack) this.micTrack.enabled = false
      useCallStore.getState().setSelf({ micOn: false })
      this.socket?.emit('state:update', { micOn: false })
      toast('The host muted your microphone', { duration: 2800 })
    })
    socket.on('room:locked', ({ locked }: { locked: boolean }) => {
      useCallStore.getState().setLocked(locked)
      useCallStore.getState().addChat({
        id: 'sys-' + Math.random(),
        from: 'system',
        name: 'System',
        text: locked ? 'The host locked this call' : 'The host unlocked this call',
        ts: Date.now(),
        system: true,
      })
    })
    socket.on('room:kicked', () => {
      useCallStore.getState().setKicked(true)
    })

    /* ---- listen together ---- */
    socket.on('music:state', (data: { peerId: string; action: 'start' | 'meta' | 'stop'; streamId?: string; title?: string; playing?: boolean; position?: number; duration?: number }) => {
      const store = useCallStore.getState()
      if (data.action === 'stop' || !data.peerId) {
        this.remoteMusicStreamIds.clear()
        detachRemoteMusic()
        store.setMusic({ ...INITIAL_MUSIC })
        return
      }
      if (data.action === 'start' && data.streamId) {
        this.remoteMusicStreamIds.add(data.streamId)
        store.setMusic({
          peerId: data.peerId,
          title: data.title ?? 'Music',
          playing: !!data.playing,
          position: data.position ?? 0,
          duration: data.duration ?? 0,
        })
      } else if (data.action === 'meta') {
        store.setMusic({
          title: data.title ?? store.music.title,
          playing: !!data.playing,
          position: data.position ?? 0,
          duration: data.duration ?? store.music.duration,
        })
      }
    })
    socket.on('music:busy', () => {
      toast('Someone is already sharing music', { duration: 2400 })
    })

    socket.on('rtc:offer', ({ from, sdp }: { from: string; sdp: string }) => {
      const pc = this.pcs.get(from)
      if (!pc) return
      const polite = this.myId < from
      this.enqueueSig(from, async () => {
        try {
          // Re-evaluate glare inside the queue — the state may have moved while
          // this op waited for the previous one.
          const offerCollision = this.makingOffer.get(from) || pc.signalingState !== 'stable'
          this.ignoreOffer.set(from, !polite && offerCollision)
          if (this.ignoreOffer.get(from)) return
          await pc.setRemoteDescription({ type: 'offer', sdp: this.munge(sdp) })
          await this.flushIce(from)
          const answer = await pc.createAnswer()
          await pc.setLocalDescription({ type: 'answer', sdp: this.munge(answer.sdp ?? '', pc.remoteDescription?.sdp ?? '') })
          const desc = pc.localDescription
          if (desc) this.socket?.emit('rtc:answer', { to: from, sdp: desc.sdp })
        } catch (err) {
          // A peer that rebuilt its connection mid-session can offer a
          // different m-line layout than ours; rebuild our side so the next
          // offer lands on a matching PC instead of failing forever.
          if (err instanceof Error && /m-line/i.test(err.message) && this.pcs.get(from) === pc) {
            const info = useCallStore.getState().peers[from]
            this.dropPeer(from)
            this.ensurePeer(from, info?.name ?? 'Guest', info?.micOn ?? true, info?.camOn ?? true, info?.sharing ?? false)
          }
        }
      })
    })

    socket.on('rtc:answer', ({ from, sdp }: { from: string; sdp: string }) => {
      const pc = this.pcs.get(from)
      if (!pc) return
      this.enqueueSig(from, async () => {
        try {
          if (pc.signalingState !== 'have-local-offer') return
          await pc.setRemoteDescription({ type: 'answer', sdp: this.munge(sdp, pc.localDescription?.sdp ?? '') })
          await this.flushIce(from)
        } catch {
          /* the renegotiation watchdog re-offers if the pair stays stuck */
        }
      })
    })

    socket.on('rtc:ice', ({ from, candidate }: { from: string; candidate: RTCIceCandidateInit }) => {
      const pc = this.pcs.get(from)
      if (!pc) return
      if (pc.remoteDescription) {
        pc.addIceCandidate(candidate).catch(() => {
          if (!this.ignoreOffer.get(from)) {
            this.pendingIce.set(from, [...(this.pendingIce.get(from) ?? []), candidate])
          }
        })
      } else {
        this.pendingIce.set(from, [...(this.pendingIce.get(from) ?? []), candidate])
      }
    })

    // ---- Stats loop ----
    this.statsTimer = window.setInterval(() => void this.pollStats(), STATS_INTERVAL_MS)

    return { mode: this.mediaMode }
  }

  /* ---------------- media ---------------- */

  private async acquireMedia(): Promise<MediaMode> {
    if (this.testMode) {
      this.localStream = await createTestStream()
      this.micTrack = this.localStream.getAudioTracks()[0] ?? null
      this.cameraTrack = this.localStream.getVideoTracks()[0] ?? null
      putStream('self', this.localStream)
      return 'full'
    }
    const audio: MediaTrackConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    }
    const video = this.videoConstraints(this.resolveProfile())
    // Full quality first
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({ audio, video })
      this.micTrack = this.localStream.getAudioTracks()[0] ?? null
      this.cameraTrack = this.localStream.getVideoTracks()[0] ?? null
      this.attachLocalStream()
      return 'full'
    } catch {
      /* fall through */
    }
    // Audio only
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({ audio })
      this.micTrack = this.localStream.getAudioTracks()[0] ?? null
      this.cameraTrack = null
      this.attachLocalStream()
      return 'audio'
    } catch {
      /* fall through */
    }
    // Listener mode
    this.localStream = null
    return 'none'
  }

  private videoConstraints(profile: QualityProfile): MediaTrackConstraints {
    return {
      width: { ideal: profile.width },
      height: { ideal: profile.height },
      frameRate: { ideal: profile.frameRate, max: profile.frameRate },
      facingMode: 'user',
    }
  }

  private attachLocalStream() {
    if (!this.localStream) return
    putStream('self', this.localStream)
  }

  private applyInitialTrackState() {
    const s = useCallStore.getState().self
    if (this.cameraTrack) this.cameraTrack.enabled = s.camOn
    if (this.micTrack) this.micTrack.enabled = s.micOn
    if (!s.camOn) void this.setVideoSendersActive(false)
  }

  /* ---------------- peers ---------------- */

  private ensurePeer(
    peerId: string,
    name: string,
    micOn = true,
    camOn = true,
    sharing = false,
  ) {
    const store = useCallStore.getState()
    if (!store.peers[peerId]) {
      store.upsertPeer({ id: peerId, name, micOn, camOn, sharing, level: 3, hasStream: false, streamVersion: 0 })
    }
    if (this.pcs.has(peerId)) return

    const pc = new RTCPeerConnection({
      iceServers: this.iceServers,
      iceCandidatePoolSize: 4,
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
    })
    this.pcs.set(peerId, pc)
    this.links.set(peerId, { lastCap: null })
    this.makingOffer.set(peerId, false)
    this.ignoreOffer.set(peerId, false)

    // Local media into this connection
    const senders: { audio?: RTCRtpSender; video?: RTCRtpSender; music?: RTCRtpSender } = {}
    if (this.localStream) {
      for (const track of this.localStream.getTracks()) {
        try {
          const sender = pc.addTrack(track, this.localStream)
          if (track.kind === 'audio') senders.audio = sender
          else senders.video = sender
        } catch {
          /* ignore */
        }
      }
      // A rebuilt connection (reconnect, ICE restart) must carry the CURRENT
      // outgoing video — if the screen is being shared, that is the screen
      // track, not the camera that localStream still holds.
      if (this.screenTrack && this.screenTrack.readyState === 'live' && senders.video) {
        void senders.video.replaceTrack(this.screenTrack).catch(() => undefined)
      }
      // Keep camera-off cameras off on fresh connections too
      if (!useCallStore.getState().self.camOn && !this.screenTrack) {
        void this.setVideoSendersActive(false)
      }
    } else {
      const at = pc.addTransceiver('audio', { direction: 'recvonly' })
      const vt = pc.addTransceiver('video', { direction: 'recvonly' })
      senders.audio = at.sender
      senders.video = vt.sender
    }
    this.sendersMap.set(peerId, senders)

    // Reserve the music m-line when this peer is the active listen-together
    // sharer: that PC's layout is [audio, video, music], and a connection
    // rebuilt mid-session must match it or every offer fails m-line order
    // checks on the polite side (silent negotiation deadlock).
    const musicPeerId = useCallStore.getState().music.peerId
    if (musicPeerId && musicPeerId === peerId && !senders.music) {
      try {
        const t = pc.addTransceiver('audio', { direction: 'recvonly' })
        senders.music = t.sender
      } catch {
        /* ignore */
      }
    }

    pc.onicecandidate = (e) => {
      if (e.candidate) this.socket?.emit('rtc:ice', { to: peerId, candidate: e.candidate.toJSON() })
    }

    pc.ontrack = (e) => {
      const stream = e.streams[0]
      if (!stream) return
      // Listen-together streams ride their own MediaStream — recognize them by
      // the stream id the sharer announced before the track ever lands.
      if (this.remoteMusicStreamIds.has(stream.id)) {
        void attachRemoteMusic(stream)
        return
      }
      putStream(peerId, stream)
      trackAudio(peerId, stream)
      useCallStore.getState().bumpPeerStream(peerId, true)
    }

    pc.onnegotiationneeded = () => {
      this.enqueueSig(peerId, () => this.makeOffer(peerId, pc))
    }

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') {
        try {
          pc.restartIce()
        } catch {
          /* ignore */
        }
      }
    }

    // Prime encoding params on the fresh senders
    this.capAudioSender(pc)
    const videoSender = senders.video
    if (videoSender) {
      try {
        const params = videoSender.getParameters()
        if (!params.encodings || params.encodings.length === 0) params.encodings = [{}]
        params.encodings[0].maxBitrate = this.resolveProfile().maxBitrate
        void videoSender.setParameters(params).catch(() => undefined)
      } catch {
        /* ignore */
      }
    }
    // Someone joining mid-song gets the music track immediately
    if (this.musicSource) this.ensureMusicSender(peerId, pc)
  }

  private dropPeer(peerId: string) {
    const pc = this.pcs.get(peerId)
    if (pc) {
      pc.close()
    }
    this.pcs.delete(peerId)
    this.sendersMap.delete(peerId)
    this.pendingIce.delete(peerId)
    this.links.delete(peerId)
    this.makingOffer.delete(peerId)
    this.ignoreOffer.delete(peerId)
    this.sigQueue.delete(peerId)
    this.lastOfferAt.delete(peerId)
    trackAudio(peerId, null)
    putStream(peerId, null)
    useCallStore.getState().bumpPeerStream(peerId, false)
    useCallStore.getState().removePeer(peerId)
    // If the music sharer left, the session is over
    if (useCallStore.getState().music.peerId === peerId) {
      detachRemoteMusic()
      this.remoteMusicStreamIds.clear()
      useCallStore.getState().setMusic({ ...INITIAL_MUSIC })
    }
  }

  private reconcilePeers(
    peers: Array<{ id: string; name: string; micOn: boolean; camOn: boolean; sharing: boolean }>,
  ) {
    const store = useCallStore.getState()
    const seen = new Set<string>()
    for (const p of peers) {
      if (p.id === this.myId) continue
      seen.add(p.id)
      this.ensurePeer(p.id, p.name, p.micOn, p.camOn, p.sharing)
    }
    for (const id of Object.keys(store.peers)) {
      if (!seen.has(id)) this.dropPeer(id)
    }
    // Follow whoever is presenting — also for late joiners and reconnects,
    // not just on live peer:state events.
    if (!store.spotlight) {
      const presenter = peers.find((p) => p.sharing && p.id !== this.myId)
      if (presenter) useCallStore.getState().setSpotlight(presenter.id)
    }
    // After a reconnect, old connections may be stale — rebuild them
    for (const [peerId, pc] of this.pcs) {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.dropPeer(peerId)
        const p = peers.find((x) => x.id === peerId)
        if (p) this.ensurePeer(p.id, p.name, p.micOn, p.camOn, p.sharing)
      }
    }
  }

  private async flushIce(peerId: string) {
    const pc = this.pcs.get(peerId)
    const queued = this.pendingIce.get(peerId) ?? []
    if (!pc || queued.length === 0) return
    this.pendingIce.set(peerId, [])
    for (const c of queued) {
      try {
        await pc.addIceCandidate(c)
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Serialize signaling ops per peer. Perfect negotiation only works when
   * setRemoteDescription / setLocalDescription never interleave — during
   * simultaneous reconnects both peers offer at once, and an in-flight
   * setLocalDescription makes the other side's implicit rollback reject.
   * Without this queue that rejection was silently swallowed and the pair
   * sat in have-local-offer forever.
   */
  private enqueueSig(peerId: string, op: () => Promise<void>): Promise<void> {
    const prev = this.sigQueue.get(peerId) ?? Promise.resolve()
    const next = prev.then(op, op)
    this.sigQueue.set(peerId, next)
    next.catch(() => undefined) // branch: keep the chain usable, log nothing
    return next
  }

  private async makeOffer(peerId: string, pc: RTCPeerConnection) {
    this.makingOffer.set(peerId, true)
    try {
      const offer = await pc.createOffer()
      await pc.setLocalDescription({ type: 'offer', sdp: this.munge(offer.sdp ?? '') })
      const desc = pc.localDescription
      if (desc) {
        this.lastOfferAt.set(peerId, Date.now())
        this.socket?.emit('rtc:offer', { to: peerId, sdp: desc.sdp })
      }
    } finally {
      this.makingOffer.set(peerId, false)
    }
  }

  /* ---------------- sdp: music-aware opus tuning ---------------- */

  private musicIds(): Set<string> {
    const ids = new Set<string>()
    if (this.musicStreamId) ids.add(this.musicStreamId)
    for (const id of this.remoteMusicStreamIds) ids.add(id)
    return ids
  }

  /** mids of sections that carry a music msid in a reference (offer) SDP. */
  private midsWithMusicSdp(referenceSdp: string): Set<string> {
    const ids = this.musicIds()
    const mids = new Set<string>()
    if (!referenceSdp || ids.size === 0) return mids
    let mid = ''
    for (const line of referenceSdp.split('\r\n')) {
      if (line.startsWith('m=')) mid = ''
      const m1 = line.match(/^a=mid:(.+)$/)
      if (m1) mid = m1[1].trim()
      const m2 = line.match(/^a=msid:(\S+)/)
      if (m2 && mid && ids.has(m2[1])) mids.add(mid)
    }
    return mids
  }

  private munge(sdp: string, referenceSdp = ''): string {
    const ids = this.musicIds()
    if (ids.size === 0) return mungeOpus(sdp, ids, new Set())
    return mungeOpus(sdp, ids, this.midsWithMusicSdp(referenceSdp))
  }

  /* ---------------- listen together ---------------- */

  private ensureMusicSender(peerId: string, pc: RTCPeerConnection) {
    if (!this.musicSource) return
    const senders = this.sendersMap.get(peerId)
    if (!senders || senders.music) return
    try {
      const track = this.musicSource.stream.getAudioTracks()[0]
      if (!track) return
      const transceiver = pc.addTransceiver(track, {
        streams: [this.musicSource.stream],
        direction: 'sendrecv',
      })
      senders.music = transceiver.sender
      const params = transceiver.sender.getParameters()
      if (!params.encodings || params.encodings.length === 0) params.encodings = [{}]
      params.encodings[0].maxBitrate = MUSIC_BITRATE
      void transceiver.sender.setParameters(params).catch(() => undefined)
    } catch {
      /* ignore */
    }
  }

  /** Share a music source with everyone. Replaces any current session. */
  startMusicShare(source: MusicSource, origin: 'file' | 'test' | 'tab' = 'file') {
    this.stopMusicShare()
    this.musicSource = source
    this.musicOrigin = origin
    this.musicHandleStop = source.stop ?? null
    this.musicStreamId = source.stream.id
    for (const [peerId, pc] of this.pcs) this.ensureMusicSender(peerId, pc)
    useCallStore.getState().setMusic({
      peerId: this.myId,
      title: source.title,
      playing: source.isPlaying(),
      position: source.getPosition(),
      duration: source.duration,
    })
    this.socket?.emit('music:state', {
      action: 'start',
      streamId: this.musicStreamId,
      title: source.title,
      playing: source.isPlaying(),
      position: source.getPosition(),
      duration: source.duration,
    })
    this.startMusicMetaTimer()
  }

  stopMusicShare() {
    if (this.musicUnsub) {
      this.musicUnsub()
      this.musicUnsub = null
    }
    if (this.musicMetaTimer !== null) {
      window.clearInterval(this.musicMetaTimer)
      this.musicMetaTimer = null
    }
    const wasSharing = !!this.musicSource
    const stopHandle = this.musicHandleStop
    this.musicSource = null
    this.musicHandleStop = null
    this.musicStreamId = ''
    for (const [, senders] of this.sendersMap) {
      const sender = senders.music
      if (sender?.track) void sender.replaceTrack(null).catch(() => undefined)
    }
    if (stopHandle) stopHandle()
    if (wasSharing) {
      useCallStore.getState().setMusic({ ...INITIAL_MUSIC })
      this.socket?.emit('music:state', { action: 'stop' })
    }
    this.lastMusicBitrate = 0
  }

  /** The active source, when it offers playback controls (file/test). */
  get activeMusic(): MusicSource | null {
    return this.musicSource
  }

  get musicSharing(): boolean {
    return !!this.musicSource
  }

  get musicOriginKind(): 'file' | 'test' | 'tab' {
    return this.musicOrigin
  }

  /** Push current playback state to everyone (called by the UI after actions). */
  broadcastMusicMeta() {
    if (!this.musicSource || !this.socket) return
    this.socket.emit('music:state', {
      action: 'meta',
      title: this.musicSource.title,
      playing: this.musicSource.isPlaying(),
      position: this.musicSource.getPosition(),
      duration: this.musicSource.duration,
    })
    useCallStore.getState().setMusic({
      title: this.musicSource.title,
      playing: this.musicSource.isPlaying(),
      position: this.musicSource.getPosition(),
      duration: this.musicSource.duration,
    })
  }

  private startMusicMetaTimer() {
    if (this.musicMetaTimer !== null) window.clearInterval(this.musicMetaTimer)
    this.musicMetaTimer = window.setInterval(() => {
      if (this.musicSource?.isPlaying()) this.broadcastMusicMeta()
    }, 5000)
  }

  /** Music tracks ride the network like everything else — step down on a weak link. */
  private applyMusicBitrate(level: NetworkLevel) {
    const target = MUSIC_BITRATE_BY_LEVEL[level]
    if (target === this.lastMusicBitrate) return
    this.lastMusicBitrate = target
    for (const [, senders] of this.sendersMap) {
      const sender = senders.music
      if (!sender?.track) continue
      try {
        const params = sender.getParameters()
        if (!params.encodings || params.encodings.length === 0) params.encodings = [{}]
        params.encodings[0].maxBitrate = target
        void sender.setParameters(params).catch(() => undefined)
      } catch {
        /* ignore */
      }
    }
  }

  /* ---------------- host controls ---------------- */

  get isHost(): boolean {
    return useCallStore.getState().hostId === this.myId && !!this.myId
  }

  hostMute(peerId: string) {
    if (this.isHost) this.socket?.emit('host:mute', { target: peerId })
  }

  hostRemove(peerId: string) {
    if (this.isHost) this.socket?.emit('host:remove', { target: peerId })
  }

  hostMuteAll() {
    if (this.isHost) this.socket?.emit('host:mute-all')
  }

  hostLock(locked: boolean) {
    if (this.isHost) this.socket?.emit('host:lock', { locked })
  }

  /* ---------------- join failure cleanup ---------------- */

  /** Undo everything start() did, without stopping the caller's preview stream. */
  private async cleanupAfterFailedJoin() {
    if (this.statsTimer !== null) {
      window.clearInterval(this.statsTimer)
      this.statsTimer = null
    }
    this.socket?.disconnect()
    this.socket = null
    for (const peerId of Array.from(this.pcs.keys())) this.dropPeer(peerId)
    this.pcs.clear()
    this.pendingIce.clear()
    this.links.clear()
    this.prevBytes.clear()
    clearAllAudio()
    putStream('self', null)
    this.localStream = null
    this.cameraTrack = null
    this.micTrack = null
    this.myId = ''
    this.started = false
  }

  /* ---------------- controls ---------------- */

  toggleMic(): boolean {
    const next = !useCallStore.getState().self.micOn
    if (this.micTrack) this.micTrack.enabled = next
    useCallStore.getState().setSelf({ micOn: next })
    this.socket?.emit('state:update', { micOn: next })
    return next
  }

  async toggleCam(): Promise<boolean> {
    const next = !useCallStore.getState().self.camOn
    useCallStore.getState().setSelf({ camOn: next })
    this.socket?.emit('state:update', { camOn: next })

    if (next && !this.cameraTrack && this.mediaMode !== 'none') {
      // try to acquire a camera mid-call (video track added -> renegotiation fires)
      try {
        const profile = this.resolveProfile()
        const stream = await navigator.mediaDevices.getUserMedia({ video: this.videoConstraints(profile) })
        const track = stream.getVideoTracks()[0]
        this.cameraTrack = track
        track.enabled = true
        if (this.localStream) this.localStream.addTrack(track)
        else this.localStream = stream
        this.publishLocalTrack(track, this.localStream)
        putStream('self', this.localStream)
        await this.setVideoSendersActive(true)
      } catch {
        useCallStore.getState().setSelf({ camOn: false })
        this.socket?.emit('state:update', { camOn: false })
        return false
      }
      return true
    }

    if (this.cameraTrack) this.cameraTrack.enabled = next
    await this.setVideoSendersActive(next && !this.screenTrack)
    return next
  }

  private publishLocalTrack(track: MediaStreamTrack, owner: MediaStream) {
    for (const [peerId, pc] of this.pcs) {
      const senders = this.sendersMap.get(peerId) ?? {}
      try {
        if (track.kind === 'video' && senders.video && senders.video.track?.kind === 'video') {
          // Swap the outgoing source — no renegotiation, seamless for viewers
          void senders.video.replaceTrack(track).catch(() => {
            try {
              const s = pc.addTrack(track, owner)
              senders.video = s
              this.sendersMap.set(peerId, senders)
            } catch {
              /* ignore */
            }
          })
        } else {
          const s = pc.addTrack(track, owner)
          if (track.kind === 'audio') senders.audio = s
          else senders.video = s
          this.sendersMap.set(peerId, senders)
        }
      } catch {
        /* ignore */
      }
    }
  }

  async toggleShare(): Promise<'started' | 'stopped' | 'cancelled'> {
    const sharing = useCallStore.getState().self.sharing
    if (!sharing) {
      try {
        const display = this.testMode
          ? await createTestScreenStream()
          : await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
        const track = display.getVideoTracks()[0]
        if (!track) return 'cancelled'
        this.screenTrack = track
        track.addEventListener('ended', () => {
          void this.stopShare()
        })
        this.publishLocalTrack(track, display)
        // mirror the shared screen into the local preview tile
        putStream('self', display)
        useCallStore.getState().bumpPeerStream('self', true)
        useCallStore.getState().setSelf({ sharing: true })
        this.socket?.emit('state:update', { sharing: true })
        useCallStore.getState().setSpotlight('self')
        // Tab / system audio, when the browser hands it over, rides the
        // music channel (dedicated Opus stereo sender) — not the mic.
        const audioTrack = display.getAudioTracks()[0]
        if (audioTrack && !this.musicSource) {
          this.startMusicShare(
            {
              stream: new MediaStream([audioTrack]),
              title: 'Shared tab audio',
              duration: 0,
              getPosition: () => 0,
              isPlaying: () => true,
            },
            'tab',
          )
        }
        return 'started'
      } catch {
        return 'cancelled'
      }
    } else {
      await this.stopShare()
      return 'stopped'
    }
  }

  private async stopShare() {
    this.screenTrack?.stop()
    this.screenTrack = null
    if (this.musicOrigin === 'tab' && this.musicSource) {
      this.stopMusicShare()
    }
    if (this.cameraTrack && this.cameraTrack.readyState === 'live') {
      // restore the camera as the outgoing video source and the local preview
      this.publishLocalTrack(this.cameraTrack, this.localStream ?? new MediaStream([this.cameraTrack]))
      if (this.localStream) putStream('self', this.localStream)
      await this.setVideoSendersActive(useCallStore.getState().self.camOn)
    } else {
      // no camera available: stop sending video entirely
      await this.setVideoSendersActive(false)
    }
    useCallStore.getState().setSelf({ sharing: false })
    this.socket?.emit('state:update', { sharing: false })
    const spotlight = useCallStore.getState().spotlight
    if (spotlight === 'self') useCallStore.getState().setSpotlight(null)
  }

  private async setVideoSendersActive(active: boolean) {
    for (const [, senders] of this.sendersMap) {
      const sender = senders.video
      if (!sender) continue
      try {
        const params = sender.getParameters()
        if (!params.encodings || params.encodings.length === 0) params.encodings = [{}]
        params.encodings[0].active = active
        await sender.setParameters(params)
      } catch {
        /* browser may not support active toggle */
      }
    }
  }

  private capAudioSender(pc: RTCPeerConnection) {
    const sender = pc.getSenders().find((s) => s.track?.kind === 'audio')
    if (!sender) return
    try {
      const params = sender.getParameters()
      if (!params.encodings || params.encodings.length === 0) params.encodings = [{}]
      params.encodings[0].maxBitrate = AUDIO_SENDER_BITRATE
      void sender.setParameters(params).catch(() => undefined)
    } catch {
      /* ignore */
    }
  }

  /* ---------------- quality ---------------- */

  private resolveProfile(): QualityProfile {
    const preset = useCallStore.getState().preset
    const key = preset === 'auto' ? this.adaptiveProfile : preset
    return QUALITY_PROFILES[key]
  }

  private effectiveLabel(): string {
    const preset = useCallStore.getState().preset
    const profile = this.resolveProfile()
    const short = profile.label.split('·')[1]?.trim() ?? ''
    return preset === 'auto' ? `Auto · ${short}` : profile.label
  }

  async setPreset(p: QualityPreset) {
    this.preset = p
    useCallStore.getState().setPreset(p)
    if (p !== 'auto') this.adaptiveProfile = p
    useCallStore.getState().setEffectiveLabel(this.effectiveLabel())
    await this.applyProfile()
  }

  private async applyProfile() {
    const profile = this.resolveProfile()
    // 1) Capture resolution / fps (no renegotiation needed)
    if (this.cameraTrack && !this.screenTrack && this.cameraTrack.readyState === 'live') {
      try {
        await this.cameraTrack.applyConstraints(this.videoConstraints(profile))
      } catch {
        /* some cameras ignore constraints */
      }
    }
    // 2) Bitrate caps per sender, respecting per-link adaptive caps
    for (const [peerId, senders] of this.sendersMap) {
      const sender = senders.video
      if (!sender) continue
      const link = this.links.get(peerId)
      const cap = link?.lastCap ?? null
      const target = cap !== null ? Math.min(cap, profile.maxBitrate) : profile.maxBitrate
      try {
        const params = sender.getParameters()
        if (!params.encodings || params.encodings.length === 0) params.encodings = [{}]
        params.encodings[0].maxBitrate = target
        await sender.setParameters(params)
      } catch {
        /* ignore */
      }
    }
  }

  /* ---------------- stats / adaptation ---------------- */

  private async pollStats() {
    if (this.pcs.size === 0) return

    // Signaling watchdog: an offer left hanging for 9s+ (a rare race between
    // simultaneous reconnects) self-heals with a fresh offer.
    for (const [peerId, pc] of this.pcs) {
      if (pc.signalingState !== 'have-local-offer') continue
      if (Date.now() - (this.lastOfferAt.get(peerId) ?? 0) < 9000) continue
      if (!this.socket?.connected) continue
      this.lastOfferAt.set(peerId, Date.now())
      this.enqueueSig(peerId, () => this.makeOffer(peerId, pc))
    }

    let overall: NetworkLevel = 3
    let totalKbps = 0
    const nextPrev = new Map<string, number>()

    for (const [peerId, pc] of this.pcs) {
      if (pc.connectionState !== 'connected') {
        overall = Math.min(overall, 1) as NetworkLevel
        continue
      }
      let rtt: number | null = null
      let loss: number | null = null
      let bytesDelta = 0
      try {
        const stats = await pc.getStats()
        stats.forEach((report) => {
          const r = report as RTCStats & {
            currentRoundTripTime?: number
            fractionLost?: number
            type: string
            state?: string
            nominated?: boolean
            bytesSent?: number
            kind?: string
          }
          if (r.type === 'candidate-pair' && r.state === 'succeeded' && typeof r.currentRoundTripTime === 'number') {
            rtt = rtt === null ? r.currentRoundTripTime : Math.min(rtt, r.currentRoundTripTime)
          }
          if (r.type === 'remote-inbound-rtp' && typeof r.fractionLost === 'number') {
            loss = loss === null ? r.fractionLost : Math.max(loss, r.fractionLost)
          }
          if (r.type === 'outbound-rtp' && typeof r.bytesSent === 'number' && (r.kind === 'video' || r.kind === 'audio')) {
            const prevB = this.prevBytes.get(r.id) ?? r.bytesSent
            bytesDelta += Math.max(0, r.bytesSent - prevB)
            nextPrev.set(r.id, r.bytesSent)
          }
        })
      } catch {
        continue
      }

      const level = classifyLink(rtt, loss)
      const prevLevel = useCallStore.getState().peers[peerId]?.level
      if (prevLevel !== level) useCallStore.getState().patchPeer(peerId, { level })
      overall = Math.min(overall, level) as NetworkLevel
      totalKbps += (bytesDelta * 8) / (STATS_INTERVAL_MS * 1000)

      // Adaptive per-link video cap
      const link = this.links.get(peerId)
      const cap = LINK_CAPS[level]
      if (link && link.lastCap !== cap) {
        link.lastCap = cap
        const sender = this.sendersMap.get(peerId)?.video
        if (sender) {
          try {
            const params = sender.getParameters()
            if (!params.encodings || params.encodings.length === 0) params.encodings = [{}]
            const profile = this.resolveProfile()
            params.encodings[0].maxBitrate = cap !== null ? Math.min(cap, profile.maxBitrate) : profile.maxBitrate
            await sender.setParameters(params)
          } catch {
            /* ignore */
          }
        }
      }
    }

    this.prevBytes = nextPrev

    const prevOverall = useCallStore.getState().overallLevel
    if (prevOverall !== overall) {
      useCallStore.getState().setOverallLevel(overall)
      useCallStore.getState().patchPeer(this.myId, { level: overall })
    }
    useCallStore.setState({ bitrateKbps: Math.round(totalKbps) })

    // Music quality follows the network instead of fighting it
    if (this.musicSource) this.applyMusicBitrate(overall)

    // Auto quality profile with hysteresis
    if (this.preset === 'auto') {
      if (overall <= 1) {
        this.badCount++
        this.goodCount = 0
      } else if (overall === 3) {
        this.goodCount++
        this.badCount = 0
      } else {
        this.badCount = 0
        this.goodCount = 0
      }
      const order: Array<Exclude<QualityPreset, 'auto'>> = ['saver', 'balanced', 'sharp']
      const idx = order.indexOf(this.adaptiveProfile)
      if (this.badCount >= 2 && idx > 0) {
        this.adaptiveProfile = order[idx - 1]
        this.badCount = 0
        this.goodCount = 0
        useCallStore.getState().setEffectiveLabel(this.effectiveLabel())
        void this.applyProfile()
      } else if (this.goodCount >= 8 && idx < order.length - 1) {
        this.adaptiveProfile = order[idx + 1]
        this.badCount = 0
        this.goodCount = 0
        useCallStore.getState().setEffectiveLabel(this.effectiveLabel())
        void this.applyProfile()
      }
    }
  }

  /* ---------------- chat / lifecycle ---------------- */

  sendChat(text: string) {
    const clean = text.trim().slice(0, 500)
    if (!clean) return
    this.socket?.emit('chat:message', { text: clean })
  }

  private rejoin() {
    if (!this.roomId || !this.socket) return
    this.socket.emit(
      'room:join',
      { roomId: this.roomId, name: useCallStore.getState().self.name, passwordHash: this.passwordHash },
      (res: { ok: boolean; self?: { id: string }; peers?: Array<{ id: string; name: string; micOn: boolean; camOn: boolean; sharing: boolean }>; hostId?: string; locked?: boolean; hasPassword?: boolean; music?: { peerId: string; title: string; playing: boolean; position: number; duration: number; streamId?: string } | null }) => {
        // The server hands out a fresh socket id after a reconnect — adopt it,
        // otherwise our own messages and presence updates stop matching.
        if (res?.ok) {
          if (res.self?.id && res.self.id !== this.myId) {
            this.myId = res.self.id
            useCallStore.getState().setSelf({ id: res.self.id })
          }
          if (res.hostId) useCallStore.getState().setHostId(res.hostId)
          useCallStore.getState().setLocked(!!res.locked)
          useCallStore.getState().setPasscodeProtected(!!res.hasPassword)
          // Restore the listen-together session (if it survived the reconnect)
          // so the incoming music track is routed to the player, not a tile.
          if (res.music?.peerId && res.music.peerId !== this.myId) {
            this.remoteMusicStreamIds.clear()
            if (res.music.streamId) this.remoteMusicStreamIds.add(res.music.streamId)
            useCallStore.getState().setMusic({
              peerId: res.music.peerId,
              title: res.music.title,
              playing: res.music.playing,
              position: res.music.position,
              duration: res.music.duration,
            })
          }
          if (res.peers) this.reconcilePeers(res.peers)
          // Re-announce our live state: the server rebuilt our peer record
          // with defaults, so everyone else must re-learn mic/cam/sharing —
          // otherwise a mid-share reconnect drops the remote spotlight.
          this.socket?.emit('state:update', {
            micOn: useCallStore.getState().self.micOn,
            camOn: useCallStore.getState().self.camOn,
            sharing: !!(this.screenTrack && this.screenTrack.readyState === 'live'),
          })
          // Same for an active listen-together session: the server dropped it
          // when our old socket left, so re-announce to restore playback for
          // everyone (and our own late-join mapping on the next ontrack).
          if (this.musicSource && this.musicStreamId) {
            this.socket?.emit('music:state', {
              action: 'start',
              streamId: this.musicStreamId,
              title: this.musicSource.title,
              playing: this.musicSource.isPlaying(),
              position: this.musicSource.getPosition(),
              duration: this.musicSource.duration,
            })
          }
        }
      },
    )
  }

  async leave(silent = false) {
    if (this.statsTimer !== null) {
      window.clearInterval(this.statsTimer)
      this.statsTimer = null
    }
    this.stopMusicShare()
    detachRemoteMusic()
    this.socket?.emit('room:leave')
    for (const peerId of Array.from(this.pcs.keys())) this.dropPeer(peerId)
    this.screenTrack?.stop()
    this.localStream?.getTracks().forEach((t) => {
      try {
        t.stop()
      } catch {
        /* ignore */
      }
    })
    const selfStreamTest = (this.localStream as (MediaStream & { __stop?: () => void }) | null)?.__stop
    if (selfStreamTest) selfStreamTest()
    this.localStream = null
    this.cameraTrack = null
    this.micTrack = null
    clearAllAudio()
    putStream('self', null)
    this.pcs.clear()
    this.pendingIce.clear()
    this.links.clear()
    this.prevBytes.clear()
    this.socket?.disconnect()
    this.socket = null
    this.myId = ''
    this.started = false
    if (!silent) {
      useCallStore.getState().reset()
    }
  }
}

// Singleton
let engine: CallEngine | null = null
export function getEngine(): CallEngine {
  if (!engine) engine = new CallEngine()
  return engine
}
