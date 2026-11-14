'use client'

import { io, type Socket } from 'socket.io-client'
import { toast } from 'sonner'
import { SIGNALING_URL, SOCKET_PATH } from './config'
import { useCallStore, setStream as putStream } from './store'
import { createTestStream, createTestScreenStream } from './test-stream'
import { clearAllAudio, trackAudio } from './audio-levels'
// music.ts is lazy-loaded via loadMusic() — listen-together is a niche
// feature and must stay out of the first-load bundle.
import {
  LINK_CAPS,
  MUSIC_BITRATE,
  MUSIC_BITRATE_BY_LEVEL,
  INITIAL_MUSIC,
  QUALITY_PROFILES,
  SCREEN_SHARE,
  type NetworkLevel,
  type QualityPreset,
  type QualityProfile,
} from './types'
import type { DebugPeerInfo, DebugInfo } from './store'

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
 *    connection — transport bandwidth estimate (smoothed, primary) with
 *    loss/RTT as secondary triggers — and caps outgoing video per link, so
 *    one weak participant never drags the whole call down.
 *  - CPU ladder: sustained qualityLimitationReason='cpu' steps the sender
 *    down (resolution → fps → audio-only) with slow, hysteretic recovery.
 *  - Receive-side shedding: peers announce which tiles they watch; senders
 *    pause their encoding toward everyone else (visibility, speaker, lite).
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
/** Speech ceiling when a link sits at level 0 — Opus with FEC + DTX stays
 *  intelligible at 16 kbps, and the 8 kbps saved per peer buys floor space
 *  for the 50 kbps video floor. */
const AUDIO_SENDER_BITRATE_WEAK = 16_000
const STATS_INTERVAL_MS = 3000
/** Receive-side shedding kicks in from this room size on (speaker+spotlight). */
export const SHED_ROOM_SIZE = 5
const LITE_STORAGE_KEY = 'pico-lite'
// All adaptation constants and the pure decision logic (classification,
// budget split, CPU ladder) live in ./adaptive — unit-tested offline.
import {
  APP_LIMITED_FACTOR,
  BWE_WARMUP_POLLS,
  CPU_FPS_CAP,
  PROBE_EVERY_POLLS,
  PROBE_LOSS_GUARD,
  PROBE_POLLS,
  avgSmooth,
  budgetChanged,
  classifyLink,
  cpuLadderTick,
  pushSmooth,
  probeEligibleFor,
  splitBudget,
  type CpuLadderState,
} from './adaptive'

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
  /** Consecutive stats polls where this PC is not (yet) connected. */
  deadTicks: number
  /** ICE restarts issued in the current outage — bounded so a hopeless link
   *  never burns the user's precious bandwidth on retry churn. */
  restarts: number
  /** Connected but zero inbound media bytes for a while — the one-way NAT
   *  signature. Triggers a re-punch exactly like a dead connection. */
  silentTicks: number
  /** Smoothed transport signals — the last SMOOTH_WINDOW samples. */
  bweHist: number[]
  lossHist: number[]
  rttHist: number[]
  /** Last values the budget/adaptive writers applied (hysteresis + honest
   *  first-write). 0 budget = nothing written yet. */
  lastBudget: number
  lastScale: number
  lastAudioCap: number
  /** Poll tick of the last probe-up poll (budget lifted so BWE can recover). */
  lastProbeTick: number
  /** Poll tick of the last BWE sample — drives the budget-hold expiry (a
   *  hold is only valid while the estimate stream is alive). */
  lastBweTick: number
  /** Nominated pair's candidate types (host/srflx/prflx/relay), debug only. */
  candType: string
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
 * Opus tuning per m-section. Speech sections get DTX + in-band FEC + a 16 kHz
 * playback ceiling + a 24 kbps bitrate ceiling + 40 ms packets, so speech
 * costs almost nothing and survives loss; music sections get stereo and a
 * high ceiling. Sections are recognized by their msid (local sends) or by
 * mid (recvonly answers, where the msid lives in the remote offer).
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

  const out: string[] = []
  lines.forEach((line, i) => {
    const m = line.match(/^a=fmtp:(\d+)(.*)$/)
    if (!m || !opusPTs.has(m[1])) {
      out.push(line)
      return
    }
    let params = m[2] ?? ''
    if (sectionMusic[i]) {
      params = params.replace(/;?(usedtx|maxaveragebitrate|stereo)=[^;]*/gi, '')
      params += ';stereo=1;maxaveragebitrate=128000'
      out.push(`a=fmtp:${m[1]}${params}`)
    } else {
      params = params.replace(/;?(stereo|maxaveragebitrate|useinbandfec|maxplaybackrate)=[^;]*/gi, '')
      params += ';usedtx=1;useinbandfec=1;maxplaybackrate=16000;maxaveragebitrate=24000'
      out.push(`a=fmtp:${m[1]}${params}`)
      // a=ptime is a media-level attribute (NOT an fmtp param): 40 ms packets
      // halve the packet rate — fewer, denser packets fare much better on
      // lossy 1-bar links than the 20 ms default.
      out.push('a=ptime:40')
    }
  })
  return out.join('\r\n')
}

/** Rolling-average helpers and the classifier live in ./adaptive (unit-tested). */

/**
 * Codec ordering via setCodecPreferences (task 6), chosen once per video
 * transceiver:
 *  - H.264 is preferred ONLY when the browser reports a power-efficient
 *    (i.e. hardware) H.264 encoder — software H.264 is no lighter than VP8
 *    and burns the same CPU for nothing (see detectCodecPreference).
 *  - Default everywhere else: VP8 first (cheapest encode), VP9 second
 *    (better per-bit quality when the browser picks it).
 *  - AV1 is NEVER preferred — its software encode burns CPU the weak devices
 *    don't have; it is demoted to last, not removed (never re-offer a codec
 *    list the other side may have already selected).
 * Falls back silently to browser defaults when the API or codec list is
 * unavailable — a missing preference must never break negotiation.
 */
function applyVideoCodecPreference(transceiver: RTCRtpTransceiver, pref: 'h264' | 'vp8') {
  if (typeof transceiver.setCodecPreferences !== 'function') return
  const caps = RTCRtpSender.getCapabilities?.('video')?.codecs
  if (!caps || caps.length === 0) return
  const rank = (mime: string): number => {
    const m = mime.toLowerCase()
    if (pref === 'h264') {
      if (m === 'video/h264') return 0
      if (m === 'video/vp8') return 1
      if (m === 'video/vp9') return 2
    } else {
      if (m === 'video/vp8') return 0
      if (m === 'video/vp9') return 1
      if (m === 'video/h264') return 2
    }
    if (m === 'video/av1') return 99
    return 10 // rtx/red/flexfec and friends keep their relative order
  }
  const ordered = [...caps].sort((a, b) => rank(a.mimeType) - rank(b.mimeType))
  try {
    transceiver.setCodecPreferences(ordered)
  } catch {
    /* browser rejected the list — defaults apply */
  }
}

/** Set a sender's encoding bitrate in one place (audio weak-cap helper). */
function setSenderMaxBitrate(sender: RTCRtpSender | undefined, bps: number) {
  if (!sender) return
  try {
    const params = sender.getParameters()
    if (!params.encodings || params.encodings.length === 0) params.encodings = [{}]
    params.encodings[0].maxBitrate = bps
    void sender.setParameters(params).catch(() => undefined)
  } catch {
    /* ignore */
  }
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
  private prevInbound = new Map<string, number>()
  /** Camera capture forced to saver dims during a weak-link episode. */
  private captureShrunk = false
  private passwordHash = ''
  private iceServers: RTCIceServer[] = ICE_SERVERS

  /* ---- adaptation state (tasks 2-5, 7, debug overlay) ---- */
  /** Last encode-time sample per peer — delta vs this gives ms/frame. */
  private prevEncode = new Map<string, { t: number; f: number }>()
  /** Stats-poll counter since join — drives BWE warmup and probe-up cadence. */
  private pollTick = 0
  /** CPU ladder state (pure logic in ./adaptive): 0 ok → 1 resolution down
   *  → 2 +fps cap → 3 audio-only send. */
  private cpu: CpuLadderState = { step: 0, badTicks: 0, cleanTicks: 0 }
  private cpuVideoPaused = false
  /** Receive-side interest: each remote peer's wish-set for MY video. */
  private wishBy = new Map<string, Set<string>>()
  private lastWish = ''
  /** Debug overlay (?debug=1) — written by pollStats every 3 s. */
  private debugEnabled = false
  /** Codec order decision ('h264' only with a power-efficient encoder). */
  private codecPref: 'h264' | 'vp8' = 'vp8'
  private codecPrefPromise: Promise<'h264' | 'vp8'> | null = null
  /** Network-change watchers (online / connection change → restartIce). */
  private unbindNetwork: (() => void) | null = null
  private lastNetworkKick = 0

  /* ---- listen together (lazy module — task 11) ---- */
  private musicMod: Promise<typeof import('./music')> | null = null
  private loadMusic(): Promise<typeof import('./music')> {
    if (!this.musicMod) this.musicMod = import('./music')
    return this.musicMod
  }

  /**
   * Create the signaling socket and resolve only once it is actually live.
   *
   * Websocket-first (task 10): socket.io tries the transports in array order
   * and falls back to the next one when the handshake fails, so healthy
   * networks skip the polling round-trip entirely while proxies that block
   * or hang upgrades land on polling automatically.
   *
   * /api/ice (fetched just above) also wakes the relay server-side before it
   * answers, so a relay lost to a recycled box is usually alive again before
   * this handshake even starts. If it still fails, start() retries once
   * before surfacing an error — a transient outage never becomes a dead end.
   */
  private async connectSignaling(forceIce: boolean): Promise<Socket> {
    this.iceServers = await fetchIceServers(forceIce)
    const opts = {
      path: SOCKET_PATH,
      transports: ['websocket', 'polling'],
      upgrade: true,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 4000,
      timeout: 10000,
    }
    // Empty SIGNALING_URL = connect to the origin the page was loaded from —
    // preview proxy, gateway or direct, they all serve the app, so they all
    // serve signaling too (Next rewrites /signal/* to the relay).
    const socket = SIGNALING_URL ? io(SIGNALING_URL, opts) : io(opts)
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

  /**
   * Up to four connect attempts inside one join. Every attempt after the
   * first force-refreshes /api/ice, which (server-side) revives a dead relay
   * and waits for it to listen before replying — so a cold or flapping relay
   * is healed mid-join instead of surfacing an error to the user.
   */
  private async connectWithRetry(): Promise<Socket> {
    let lastErr: unknown
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        return await this.connectSignaling(attempt > 0)
      } catch (err) {
        lastErr = err
        if (attempt < 3) await new Promise((r) => setTimeout(r, attempt === 0 ? 1_200 : 500))
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('relay unreachable')
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
    // restart heals right here — the retry loop nudges the keeper server-side
    // on every attempt, so a transient outage never becomes a dead end.
    let socket: Socket
    try {
      socket = await this.connectWithRetry()
    } catch {
      await this.cleanupAfterFailedJoin()
      throw new Error('Could not reach the call relay. Check your connection and try again.')
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

    // Lite mode default (task 8): stored manual choice wins; otherwise a
    // data-saver browser or 2G/3G link auto-enables it for this session.
    this.maybeAutoLite()

    // Network-change recovery (Wi-Fi↔LTE hops, captive portals): re-punch
    // every live connection the moment connectivity changes.
    this.bindNetworkWatchers()

    // Codec preference probe: H.264 only when the encoder is power-efficient.
    void this.ensureCodecPref()

    // ---- Events ----
    // Debug overlay (?debug=1) — pollStats writes a snapshot every 3 s only
    // when the flag is on; the store otherwise stays untouched.
    this.debugEnabled =
      typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('debug')

    // Receive-side interest (task 7): a peer tells us which tiles it watches;
    // we pause our video encoding toward peers who are not watched.
    socket.on('video:wish', ({ from, targets }: { from: string; targets: string[] }) => {
      this.wishBy.set(from, new Set(targets))
      this.syncOutgoingVideo()
    })

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
    socket.on(
      'chat:message',
      (msg: { id: string; from: string; name: string; text: string; ts: number; replyTo?: { id: string; name: string; text: string } }) => {
        useCallStore.getState().addChat(msg)
      },
    )

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
        void this.loadMusic().then((m) => m.detachRemoteMusic())
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
      // connecting starts true for remote peers: the tile says "Connecting…"
      // until the PC actually completes, never a misleading signal bar.
      store.upsertPeer({ id: peerId, name, micOn, camOn, sharing, level: 3, hasStream: false, streamVersion: 0, connecting: true })
    }
    if (this.pcs.has(peerId)) return

    const pc = new RTCPeerConnection({
      iceServers: this.iceServers,
      iceCandidatePoolSize: 4,
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
    })
    this.pcs.set(peerId, pc)
    this.links.set(peerId, {
      lastCap: null,
      deadTicks: 0,
      restarts: 0,
      silentTicks: 0,
      bweHist: [],
      lossHist: [],
      rttHist: [],
      lastBudget: 0,
      lastScale: 1,
      lastAudioCap: 0,
      lastProbeTick: 0,
      lastBweTick: 0,
      candType: '?',
    })
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
    this.applySenderPriorities(senders)

    // Codec order (task 6, corrected): H.264 only with a power-efficient
    // encoder, AV1 demoted. Applied now with the current best guess, and
    // re-applied across all transceivers once the async capability probe
    // lands (preference-only change — negotiation handles it).
    try {
      const vt = pc
        .getTransceivers()
        .find((t) => t.sender.track?.kind === 'video' || t.receiver.track.kind === 'video')
      if (vt) applyVideoCodecPreference(vt, this.codecPref)
    } catch {
      /* ignore */
    }
    void this.ensureCodecPref().then(() => {
      for (const p of this.pcs.values()) {
        try {
          const vt = p
            .getTransceivers()
            .find((t) => t.sender.track?.kind === 'video' || t.receiver.track.kind === 'video')
          if (vt) applyVideoCodecPreference(vt, this.codecPref)
        } catch {
          /* ignore */
        }
      }
    })

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
        void this.loadMusic().then((m) => m.attachRemoteMusic(stream))
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
      void this.loadMusic().then((m) => m.detachRemoteMusic())
      this.remoteMusicStreamIds.clear()
      useCallStore.getState().setMusic({ ...INITIAL_MUSIC })
    }
    this.wishBy.delete(peerId)
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
    if (!senders) return
    const track = this.musicSource.stream.getAudioTracks()[0]
    if (!track) return
    try {
      if (senders.music) {
        // Sender already exists (previous session was replaced, not torn
        // down): swap the outgoing source. addTransceiver here would be
        // skipped — and the new session would silently never reach anyone.
        const sender = senders.music
        void sender.replaceTrack(track).catch(() => undefined)
        const params = sender.getParameters()
        if (!params.encodings || params.encodings.length === 0) params.encodings = [{}]
        params.encodings[0].maxBitrate = MUSIC_BITRATE
        void sender.setParameters(params).catch(() => undefined)
        return
      }
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

  /**
   * Share audio from ONE surface the user picks — any open tab, window or
   * screen, chosen in the browser's own picker (that picker IS the source
   * chooser: it lists every open tab across every platform/site). Only the
   * audio track is kept: the video capture stops immediately, so this costs
   * zero video encoding and ~96 kbps of Opus stereo for every listener.
   */
  async startTabAudioShare(): Promise<'started' | 'cancelled' | 'no-audio'> {
    try {
      const display = await navigator.mediaDevices.getDisplayMedia({
        // video:true is only required so the browser offers its full picker;
        // the track is stopped a line below — no frame is ever encoded.
        video: true,
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        ...this.displayPickerHints(),
      } as unknown as DisplayMediaStreamOptions)
      const audioTrack = display.getAudioTracks()[0]
      for (const t of display.getVideoTracks()) t.stop()
      if (!audioTrack) {
        toast('That source has no sound — pick a Chrome tab and tick “Share audio”', { duration: 4500 })
        return 'no-audio'
      }
      // Chrome names tab tracks after the page — that is the friendliest label.
      const label = audioTrack.label?.trim() ?? ''
      // One listen-together session per room: this intent replaces any current one.
      if (this.musicSource) this.stopMusicShare()
      this.startMusicShare(
        {
          stream: new MediaStream([audioTrack]),
          title: (label || 'Shared tab audio').slice(0, 80),
          duration: 0,
          getPosition: () => 0,
          isPlaying: () => true,
        },
        'tab',
      )
      // User stopped the tab / clicked "Stop sharing" in Chrome's toolbar.
      audioTrack.addEventListener('ended', () => {
        if (this.musicOrigin === 'tab') this.stopMusicShare()
      })
      return 'started'
    } catch {
      return 'cancelled'
    }
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
    this.prevInbound.clear()
    this.prevEncode.clear()
    this.wishBy.clear()
    this.lastWish = ''
    this.pollTick = 0
    this.cpu = { step: 0, badTicks: 0, cleanTicks: 0 }
    this.cpuVideoPaused = false
    this.unbindNetwork?.()
    this.unbindNetwork = null
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
        const caps = this.screenCaps()
        const display = this.testMode
          ? await createTestScreenStream()
          : await navigator.mediaDevices.getDisplayMedia({
              // Capture-side caps are the single biggest CPU/bandwidth lever:
              // Chrome's default grabs full resolution at up to 60 fps with no
              // ceiling, which crushes low-end machines and weak links. The
              // capture size follows the bitrate budget (task 9): 720p when the
              // link is capped at ~220 kbps, 1080p otherwise — resolution the
              // budget can actually carry, instead of frames the encoder drops.
              video: {
                frameRate: { max: caps.maxFps },
                width: { max: caps.maxWidth },
                height: { max: caps.maxHeight },
              },
              // Music-grade capture flags: no speech processing on tab audio.
              audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
              ...(this.displayPickerHints()),
            } as unknown as DisplayMediaStreamOptions)
        const track = display.getVideoTracks()[0]
        if (!track) return 'cancelled'
        // Encoder hint (task 9): documents/windows/tabs are text-first content
        // — keep glyphs sharp at any fps. A full monitor may be playing video,
        // so 'detail' (sharp, allows motion) is the safer hint there.
        try {
          const surface = (track.getSettings() as MediaTrackSettings & { displaySurface?: string })
            .displaySurface
          track.contentHint = surface === 'monitor' ? 'detail' : 'text'
        } catch {
          /* older browsers */
        }
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
        // Screen senders get the screen budget (resolution-first encoding),
        // not the talking-head camera caps.
        await this.applyScreenVideoParams()
        // Tab / system audio, when the browser hands it over, rides the
        // music channel (dedicated Opus stereo sender) — not the mic.
        const audioTrack = display.getAudioTracks()[0]
        if (audioTrack) {
          // A screen share with sound is the newer intent — it replaces any
          // running listen-together session instead of being silently dropped.
          if (this.musicSource) this.stopMusicShare()
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
        } else if (!this.testMode) {
          // Most "no sound" reports are a picker choice, not a bug: screen
          // audio only flows when a TAB is shared with "Share audio" ticked
          // (and macOS Chrome cannot capture system audio at all).
          toast('Shared without sound — for audio, pick a Chrome tab and tick “Share audio”', { duration: 4500 })
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

  /** Screen budget for the current (possibly adaptive, possibly CPU-downgraded) preset. */
  private screenCaps(): { maxBitrate: number; maxFps: number; maxWidth: number; maxHeight: number } {
    return SCREEN_SHARE[this.currentKey()]
  }

  /** Picker options: list every surface, include system audio, hide this very
   *  tab (sharing the call into itself would loop echo back to everyone). */
  private displayPickerHints(): Record<string, unknown> {
    return {
      systemAudio: 'include',
      selfBrowserSurface: 'exclude',
      monitorTypeSurfaces: 'include',
    }
  }

  /**
   * Resolution-first encoding for the screen sender: keep text sharp, let fps
   * drop under pressure. Runs on share start, preset change and link-cap
   * changes — always capped by the per-link adaptive ceiling.
   */
  private async applyScreenVideoParams() {
    const caps = this.screenCaps()
    for (const [peerId, senders] of this.sendersMap) {
      const sender = senders.video
      if (!sender) continue
      try {
        const params = sender.getParameters()
        if (!params.encodings || params.encodings.length === 0) params.encodings = [{}]
        const cap = this.links.get(peerId)?.lastCap ?? null
        params.encodings[0].maxBitrate = cap !== null ? Math.min(cap, caps.maxBitrate) : caps.maxBitrate
        params.encodings[0].maxFramerate = caps.maxFps
        // Maintain-resolution: on congestion, shed frames — never blur text.
        ;(params as RTCRtpParameters & { degradationPreference?: RTCDegradationPreference }).degradationPreference =
          'maintain-resolution'
        await sender.setParameters(params)
      } catch {
        /* browser may not support a parameter — caps still apply where they do */
      }
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

  /**
   * Master switch for outgoing video (task 7 aware): a sender goes live only
   * when the camera/screen is active AND the receiving peer actually watches
   * us (its video:wish interest set). Missing wish entry = old client or no
   * info yet → we keep sending (fail-open, never blank a call by accident).
   */
  private async setVideoSendersActive(active: boolean) {
    for (const [peerId, senders] of this.sendersMap) {
      const sender = senders.video
      if (!sender) continue
      const wish = this.wishBy.get(peerId)
      const want = wish ? wish.has(this.myId) : true
      try {
        const params = sender.getParameters()
        if (!params.encodings || params.encodings.length === 0) params.encodings = [{}]
        params.encodings[0].active = active && want
        await sender.setParameters(params)
      } catch {
        /* browser may not support active toggle */
      }
    }
  }

  /** Re-evaluate outgoing video activity after any interest/camera change. */
  private syncOutgoingVideo() {
    const self = useCallStore.getState().self
    const screenLive = !!this.screenTrack && this.screenTrack.readyState === 'live'
    void this.setVideoSendersActive(self.camOn || screenLive)
  }

  /**
   * Announce OUR receive-side interest (task 7): which peers' video we want.
   * Room UI computes it (visible tiles via IntersectionObserver, background
   * tab, active speaker, spotlight, lite mode, room size ≥ SHED_ROOM_SIZE).
   * Remote engines react by pausing their encoders toward us — their CPU and
   * the mesh's upload drop with zero renegotiation.
   */
  setVideoInterest(targets: string[]) {
    const key = [...targets].sort().join(',')
    if (key === this.lastWish) return
    this.lastWish = key
    this.socket?.emit('video:wish', { targets })
  }

  /* ---------------- lite mode (task 8) ---------------- */

  /**
   * One-click Lite: audio-only SEND (camera off, announced to peers) plus
   * receive-side shedding to just the active speaker / spotlight (Room keeps
   * the interest set to those ids while lite is on). A manual choice is
   * persisted in localStorage; an automatic default (see maybeAutoLite) is
   * not, so it never overrides a later manual decision.
   */
  setLiteMode(on: boolean, opts: { auto?: boolean } = {}) {
    try {
      if (!opts.auto || localStorage.getItem(LITE_STORAGE_KEY) === null) {
        localStorage.setItem(LITE_STORAGE_KEY, on ? '1' : '0')
      }
    } catch {
      /* storage disabled — session-only */
    }
    useCallStore.getState().setLite(on, !!opts.auto)
    if (on && useCallStore.getState().self.camOn) {
      useCallStore.getState().setSelf({ camOn: false })
      this.socket?.emit('state:update', { camOn: false })
      if (this.cameraTrack) this.cameraTrack.enabled = false
    }
    this.syncOutgoingVideo()
  }

  /**
   * Connection-hint defaults (corrected): Lite only for genuinely hostile
   * links (saveData, slow-2g, 2g). "3g" reports for many connections that
   * are perfectly usable — for those, drop to the saver preset and suggest
   * Lite instead of forcing audio-only. A stored manual choice always wins.
   */
  maybeAutoLite() {
    let saved: string | null = null
    try {
      saved = localStorage.getItem(LITE_STORAGE_KEY)
    } catch {
      /* ignore */
    }
    if (saved !== null) {
      if (saved === '1') this.setLiteMode(true)
      return
    }
    const conn = (
      navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }
    ).connection
    const et = conn?.effectiveType ?? '4g'
    if (conn?.saveData || et === 'slow-2g' || et === '2g') {
      this.setLiteMode(true, { auto: true })
      toast('Lite mode on — very slow connection detected', { duration: 2600 })
    } else if (et === '3g') {
      void this.setPreset('saver')
      toast('Slow connection — video set to Data Saver. Lite mode lives in Quality settings if it stays rough.', {
        duration: 4200,
      })
    }
  }

  /**
   * Codec preference detection (task 6, corrected): H.264 is preferred only
   * when the browser reports its H.264 ENCODER as power-efficient — that is
   * the hardware path. Software H.264 is no lighter than VP8, so without
   * that signal we stay on VP8 regardless of core count.
   */
  private async detectCodecPreference(): Promise<'h264' | 'vp8'> {
    try {
      const res = await navigator.mediaCapabilities.encodingInfo({
        type: 'webrtc',
        video: {
          contentType: 'video/h264; codecs=avc1.42E01E',
          width: 640,
          height: 480,
          bitrate: 300_000,
          framerate: 24,
        },
      })
      if (res.powerEfficient === true) return 'h264'
    } catch {
      /* no mediaCapabilities — VP8 default */
    }
    return 'vp8'
  }

  private ensureCodecPref(): Promise<'h264' | 'vp8'> {
    if (!this.codecPrefPromise) {
      this.codecPrefPromise = this.detectCodecPreference().catch(() => 'vp8' as const)
    }
    return this.codecPrefPromise
  }

  /**
   * Network-change recovery: Wi-Fi↔LTE hops and captive-portal re-auths kill
   * the selected candidate pair while the DTLS association still looks fine —
   * the classic "one bar and frozen" state. The moment the OS reports a
   * network change (or connectivity returns), re-punch every live connection.
   * Debounced 3 s: one hop fires several connection-change events.
   */
  private bindNetworkWatchers() {
    const kick = () => {
      const now = Date.now()
      if (now - this.lastNetworkKick < 3000) return
      this.lastNetworkKick = now
      for (const pc of this.pcs.values()) {
        if (pc.connectionState === 'connected' || pc.connectionState === 'disconnected') {
          try {
            pc.restartIce()
          } catch {
            /* ignore */
          }
        }
      }
      for (const link of this.links.values()) {
        link.silentTicks = 0
      }
    }
    const conn = (navigator as Navigator & { connection?: EventTarget }).connection
    window.addEventListener('online', kick)
    conn?.addEventListener?.('change', kick)
    this.unbindNetwork = () => {
      window.removeEventListener('online', kick)
      conn?.removeEventListener?.('change', kick)
    }
  }

  /**
   * Packet-pacer priorities, set once per sender. When a link congests,
   * Chrome schedules audio packets ahead of video — so speech survives even
   * when the picture has to die. This is the single most important line for
   * "we could not even HEAR each other" on a 1-bar connection.
   */
  private applySenderPriorities(senders: { audio?: RTCRtpSender; video?: RTCRtpSender }) {
    const set = (sender: RTCRtpSender | undefined, p: RTCPriorityType) => {
      if (!sender) return
      try {
        const params = sender.getParameters()
        if (!params.encodings || params.encodings.length === 0) params.encodings = [{}]
        params.encodings[0].networkPriority = p
        void sender.setParameters(params).catch(() => undefined)
      } catch {
        /* older browsers — caps below still keep audio small */
      }
    }
    set(senders.audio, 'high')
    set(senders.video, 'low')
  }

  /**
   * Weak-link capture shrink: at the 50–110 kbps budgets a 360p picture
   * renders as unreadable mush — 144p@10 fps is the difference between
   * "slideshow" and "can see you". Applied instantly when any CONNECTED
   * link degrades (a peer still dialing must not downgrade the call),
   * restored the moment links recover. Idempotent, near-zero CPU.
   */
  private async shrinkCapture() {
    if (this.captureShrunk) return
    if (this.screenTrack && this.screenTrack.readyState === 'live') return // screen owns the senders
    if (!this.cameraTrack || this.cameraTrack.readyState !== 'live') return
    this.captureShrunk = true
    try {
      await this.cameraTrack.applyConstraints(this.videoConstraints(QUALITY_PROFILES.saver))
    } catch {
      /* some cameras ignore constraints — bitrate caps still apply */
    }
    await this.setCameraDegradation('maintain-framerate')
  }

  private async restoreCapture() {
    if (!this.captureShrunk) return
    this.captureShrunk = false
    await this.setCameraDegradation('balanced')
    await this.applyProfile()
  }

  /**
   * degradationPreference for talking heads: under congestion keep frames
   * flowing (lip-sync readable) and shed resolution — deliberately opposite
   * to the screen-share policy, which keeps text sharp and sheds frames.
   */
  private async setCameraDegradation(preference: RTCDegradationPreference) {
    for (const [, senders] of this.sendersMap) {
      const sender = senders.video
      if (!sender?.track) continue
      try {
        const params = sender.getParameters()
        if (!params.encodings || params.encodings.length === 0) params.encodings = [{}]
        ;(params as RTCRtpParameters & { degradationPreference?: RTCDegradationPreference }).degradationPreference =
          preference
        await sender.setParameters(params)
      } catch {
        /* browser may not support the parameter — caps still apply */
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

  /** Effective quality key: the user preset (or auto-adaptive profile),
   *  downgraded one step while the CPU ladder sits at step ≥ 1 (task 2). */
  private currentKey(): Exclude<QualityPreset, 'auto'> {
    const preset = useCallStore.getState().preset
    const base = preset === 'auto' ? this.adaptiveProfile : preset
    if (this.cpu.step >= 1) {
      const order: Array<Exclude<QualityPreset, 'auto'>> = ['saver', 'balanced', 'sharp']
      return order[Math.max(0, order.indexOf(base) - 1)]
    }
    return base
  }

  private resolveProfile(): QualityProfile {
    return QUALITY_PROFILES[this.currentKey()]
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
    // Screen share overrides camera quality entirely: while it is live the
    // video senders carry the screen budget, not the talking-head profile.
    if (this.screenTrack && this.screenTrack.readyState === 'live') {
      await this.applyScreenVideoParams()
      return
    }
    // 1) Capture resolution / fps (no renegotiation needed)
    if (this.cameraTrack && this.cameraTrack.readyState === 'live') {
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
      if (link) link.lastBudget = target
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
    this.pollTick++

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
    /** Weakest level among CONNECTED links only — a peer still dialing must
     *  never downgrade the media of everyone already talking. */
    let connectedLevel: NetworkLevel | null = null
    let connectedCount = 0
    let weakCount = 0
    let totalKbps = 0
    const nextPrev = new Map<string, number>()
    const nextPrevIn = new Map<string, number>()
    const nextPrevEncode = new Map<string, { t: number; f: number }>()
    /** Per connected link, resolved after the loop by the budget allocator. */
    const sampled = new Map<
      string,
      {
        level: NetworkLevel
        bytesDelta: number
        inboundDelta: number
        screenLive: boolean
        /** True when the estimate merely echoes our own cap (see pollStats). */
        appLimited: boolean
      }
    >()
    const debugPeers: DebugPeerInfo[] = []
    let worstReason = 'none'
    let worstEncodeMs = 0
    /** Weakest smoothed outgoing BWE across connected links — the shared
     *  uplink bottleneck approximation (task 4). */
    let weakestBwe: number | null = null
    /** This peer's budget share, for the debug overlay. */
    let debugShare = 0

    for (const [peerId, pc] of this.pcs) {
      const link = this.links.get(peerId)
      const storePeer = useCallStore.getState().peers[peerId]

      if (pc.connectionState !== 'connected') {
        // Not connected is NOT "weak" — it is "still dialing" (or re-dialing).
        // Level 0 keeps the bars honest; the tile shows "Connecting…".
        overall = Math.min(overall, 0) as NetworkLevel
        if (storePeer && storePeer.connecting !== true) {
          useCallStore.getState().patchPeer(peerId, { connecting: true })
        }
        if (link) {
          link.deadTicks++
          // ICE restart ladder: first re-punch after ~6 s, then every ~9 s,
          // at most 4 tries. Each restart re-gathers candidates — that is
          // what recovers NAT rebinding, carrier handoffs and AP-isolation
          // flickers without renegotiating media. Bounded so a hopeless pair
          // (no TURN reachable) never churns the user's data plan forever.
          if (link.deadTicks >= 2 && link.restarts < 4 && (link.deadTicks - 2) % 3 === 0) {
            link.restarts++
            try {
              pc.restartIce()
            } catch {
              /* ignore */
            }
          }
        }
        continue
      }

      // (Re)connected — clear outage bookkeeping and the Connecting flag.
      if (link) {
        link.deadTicks = 0
        link.restarts = 0
        link.silentTicks = 0
      }
      if (storePeer?.connecting) useCallStore.getState().patchPeer(peerId, { connecting: false })

      let rtt: number | null = null
      let loss: number | null = null
      let bwe: number | null = null
      let bytesDelta = 0
      let inboundDelta = 0
      let encodeMs = 0
      let cpuLimited = false
      let reason = 'none'
      let nomLocal = ''
      let nomRemote = ''
      const candTypes = new Map<string, string>()
      const prevEncode = this.prevEncode.get(peerId)
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
            bytesReceived?: number
            kind?: string
            availableOutgoingBitrate?: number
            localCandidateId?: string
            remoteCandidateId?: string
            candidateType?: string
            qualityLimitationReason?: string
            totalEncodeTime?: number
            framesEncoded?: number
          }
          if (r.type === 'candidate-pair' && r.state === 'succeeded') {
            if (typeof r.currentRoundTripTime === 'number') {
              rtt = rtt === null ? r.currentRoundTripTime : Math.min(rtt, r.currentRoundTripTime)
            }
            // BWE from the nominated pair only — that is the path media rides.
            if (r.nominated) {
              if (typeof r.availableOutgoingBitrate === 'number') bwe = r.availableOutgoingBitrate
              nomLocal = r.localCandidateId ?? ''
              nomRemote = r.remoteCandidateId ?? ''
            }
          }
          if ((r.type === 'local-candidate' || r.type === 'remote-candidate') && typeof r.candidateType === 'string') {
            candTypes.set(r.id, r.candidateType)
          }
          if (r.type === 'remote-inbound-rtp' && typeof r.fractionLost === 'number') {
            loss = loss === null ? r.fractionLost : Math.max(loss, r.fractionLost)
          }
          if (r.type === 'outbound-rtp' && typeof r.bytesSent === 'number' && (r.kind === 'video' || r.kind === 'audio')) {
            const prevB = this.prevBytes.get(r.id) ?? r.bytesSent
            bytesDelta += Math.max(0, r.bytesSent - prevB)
            nextPrev.set(r.id, r.bytesSent)
            // CPU overload (task 2): qualityLimitationReason + encode ms/frame
            // (delta totalEncodeTime / delta framesEncoded between polls).
            if (r.kind === 'video' && typeof r.framesEncoded === 'number') {
              const t = typeof r.totalEncodeTime === 'number' ? r.totalEncodeTime : null
              if (prevEncode && t !== null && r.framesEncoded > prevEncode.f && t > prevEncode.t) {
                encodeMs = Math.max(encodeMs, ((t - prevEncode.t) / (r.framesEncoded - prevEncode.f)) * 1000)
              }
              if (t !== null) nextPrevEncode.set(peerId, { t, f: r.framesEncoded })
              if (typeof r.qualityLimitationReason === 'string' && r.qualityLimitationReason !== 'none') {
                cpuLimited = true
                reason = r.qualityLimitationReason
              }
            }
          }
          if (r.type === 'inbound-rtp' && typeof r.bytesReceived === 'number') {
            const prevIn = this.prevInbound.get(r.id) ?? r.bytesReceived
            inboundDelta += Math.max(0, r.bytesReceived - prevIn)
            nextPrevIn.set(r.id, r.bytesReceived)
          }
        })
      } catch {
        continue
      }

      // Smooth the transport signals over the last SMOOTH_WINDOW polls —
      // the hysteresis that keeps caps, bars and budgets from flapping on
      // one bad sample (task 3).
      const bweSmooth = avgSmooth(link?.bweHist)
      if (link) {
        if (bwe !== null) {
          pushSmooth(link.bweHist, bwe)
          link.lastBweTick = this.pollTick
        }
        if (loss !== null) pushSmooth(link.lossHist, loss)
        if (rtt !== null) pushSmooth(link.rttHist, rtt)
      }
      // Freshness gate: a BWE sample that has not renewed this poll is STALE
      // (transport-cc stalled, stats flake). Feeding a stale window into
      // classification or the budget would ratchet the cap to the floor on
      // old echo data — treat silence as unknown instead (hold expiry in
      // splitBudget then downgrades conservatively after HOLD_MAX_POLLS).
      const bweNow = !!link && link.lastBweTick === this.pollTick ? bweSmooth : null

      /* Anti-lock-low guards (corrected task 3): availableOutgoingBitrate
         starts near zero and only grows when the sender is allowed to probe.
         Trusting it too early — or while our own cap binds the sender — locks
         quality at the floor forever. Ignore the BWE (classify on loss/RTT
         only, verdict capped at the fallback) when:
         - warmup: the first ~12 s of the call, and
         - app-limited: we sent ≈ our cap AND the estimate ≈ our cap — the
           estimate is mirroring the cap, not measuring the link. */
      const warmup = this.pollTick <= BWE_WARMUP_POLLS
      const sentKbps = (bytesDelta * 8) / (STATS_INTERVAL_MS * 1000)
      const appLimited =
        !warmup &&
        !!link &&
        link.lastBudget > 0 &&
        bweNow !== null &&
        sentKbps >= (link.lastBudget / 1000) * APP_LIMITED_FACTOR &&
        bweNow <= link.lastBudget * 1.2
      const ignoreBwe = warmup || appLimited
      const prevLevel = useCallStore.getState().peers[peerId]?.level
      const level = classifyLink(avgSmooth(link?.rttHist), avgSmooth(link?.lossHist), bweNow, {
        mode: ignoreBwe ? 'ignore-bwe' : 'normal',
        fallback: warmup ? 3 : (prevLevel ?? null),
      })
      if (prevLevel !== level) useCallStore.getState().patchPeer(peerId, { level })
      connectedLevel = connectedLevel === null ? level : (Math.min(connectedLevel, level) as NetworkLevel)
      connectedCount++
      if (level <= 1) weakCount++
      overall = Math.min(overall, level) as NetworkLevel
      totalKbps += sentKbps

      // One-way media watchdog: the DTLS association is up, the peer claims
      // to send, yet not a single byte arrived for ~15 s — the classic
      // symmetric-NAT / hairpin-failure signature. Re-punch while the users
      // can still see the call, instead of leaving them in silence.
      if (link) {
        const remoteSends = !!storePeer && (storePeer.micOn || storePeer.camOn || storePeer.sharing)
        const stalled = remoteSends && inboundDelta === 0
        if (stalled) {
          link.silentTicks++
          const dueNow = link.silentTicks === 5 || (link.silentTicks > 5 && (link.silentTicks - 5) % 3 === 0)
          if (dueNow && link.restarts < 4) {
            link.restarts++
            try {
              pc.restartIce()
            } catch {
              /* ignore */
            }
          }
        } else {
          link.silentTicks = 0
        }
      }

      // Audio efficiency (task 5): at level 0 the speech ceiling drops to
      // 16 kbps — Opus stays intelligible there with FEC + DTX, and the
      // savings widen the 50 kbps video floor. Hysteresis: rewritten only
      // when the target actually changes.
      const audioTarget = level === 0 ? AUDIO_SENDER_BITRATE_WEAK : AUDIO_SENDER_BITRATE
      if (link && link.lastAudioCap !== audioTarget) {
        link.lastAudioCap = audioTarget
        setSenderMaxBitrate(this.sendersMap.get(peerId)?.audio, audioTarget)
      }

      const screenLive = !!this.screenTrack && this.screenTrack.readyState === 'live'
      sampled.set(peerId, { level, bytesDelta, inboundDelta, screenLive, appLimited })

      if (encodeMs > worstEncodeMs) worstEncodeMs = encodeMs
      if (cpuLimited && reason === 'cpu') worstReason = 'cpu'
      else if (cpuLimited && worstReason !== 'cpu') worstReason = reason
      if (link) {
        link.candType = `${candTypes.get(nomLocal) ?? '?'}→${candTypes.get(nomRemote) ?? '?'}`
      }
      debugPeers.push({
        id: peerId,
        kbpsUp: Math.round((bytesDelta * 8) / (STATS_INTERVAL_MS * 1000)),
        kbpsDown: Math.round((inboundDelta * 8) / (STATS_INTERVAL_MS * 1000)),
        level,
        candidateType: link?.candType ?? '?',
      })
      const linkBwe = bweNow
      // An app-limited link's estimate is our own cap echoed back — feeding
      // it into the shared budget would shrink the cap ~20% every poll until
      // the floor (the lock-low loop, caught by the offline tests). Only
      // link-limited (real) estimates set the shared budget — and none at
      // all during warmup: the startup estimate is a probe artifact, so the
      // cold start must run uncapped until the estimator has ramped.
      if (linkBwe !== null && !appLimited && !warmup && (weakestBwe === null || linkBwe < weakestBwe)) {
        weakestBwe = linkBwe
      }
    }

    this.prevBytes = nextPrev
    this.prevInbound = nextPrevIn
    this.prevEncode = nextPrevEncode

    /* ---- Upload budget (task 4, via adaptive.splitBudget): 0.8 × the
       weakest smoothed BWE across connected links, audio reserved first, the
       remainder split evenly across the video senders. A weak peer's SHARE
       shrinks and gets scaleResolutionDownBy on ITS sender — the shared
       camera capture keeps its size, so healthy links never lose picture
       because of one bad one. Probe-up: every PROBE_EVERY_POLLS the caps are
       lifted for PROBE_POLLS polls (≈9 s — the estimator ramps gradually) so
       the transport can probe upward again; probes are skipped while the
       last two polls saw fresh loss. ---- */
    const audioPerPeer = overall === 0 ? AUDIO_SENDER_BITRATE_WEAK : AUDIO_SENDER_BITRATE

    for (const [peerId, s] of sampled) {
      const link = this.links.get(peerId)
      const sender = this.sendersMap.get(peerId)?.video
      if (!link || !sender) continue
      const cap = LINK_CAPS[s.level]
      const base = s.screenLive ? this.screenCaps().maxBitrate : this.resolveProfile().maxBitrate
      // Probe-up window: scheduled every PROBE_EVERY_POLLS and skipped while
      // either of the last two polls saw fresh loss — probing into real loss
      // briefly congests a genuinely weak link for nothing. Screen shares,
      // Lite mode and saveData never probe (probeEligibleFor).
      const sinceProbe = this.pollTick - link.lastProbeTick
      const lossRecentBad = link.lossHist.slice(-2).some((v) => v > PROBE_LOSS_GUARD)
      const probeEligible = probeEligibleFor({
        screenLive: s.screenLive,
        lite: useCallStore.getState().lite,
        saveData: (
          navigator as Navigator & { connection?: { saveData?: boolean } }
        ).connection?.saveData === true,
        level: s.level,
        lastBudget: link.lastBudget,
        baseBitrate: base,
      })
      if (probeEligible && sinceProbe >= PROBE_EVERY_POLLS && !lossRecentBad) {
        link.lastProbeTick = this.pollTick // (re)start the probe window
      }
      const probing =
        probeEligible &&
        !lossRecentBad &&
        link.lastProbeTick > 0 && // probing exists only inside a SCHEDULED window
        this.pollTick - link.lastProbeTick < PROBE_POLLS
      const { target, scale, share } = splitBudget({
        weakestBwe,
        level: s.level,
        baseBitrate: base,
        audioPerPeer,
        connectedPeers: connectedCount,
        screenLive: s.screenLive,
        probing,
        lastBudget: link.lastBudget,
        lastScale: link.lastScale,
        bweEver: link.bweHist.length > 0,
        bweAge: link.lastBweTick > 0 ? this.pollTick - link.lastBweTick : Infinity,
      })
      // Hysteresis: rewrite sender params only on a >10% budget change or a
      // scale change — never per-poll ping-pong.
      if (budgetChanged(link.lastBudget, target, link.lastScale, scale)) {
        link.lastBudget = target
        link.lastCap = cap
        link.lastScale = scale
        try {
          const params = sender.getParameters()
          if (!params.encodings || params.encodings.length === 0) params.encodings = [{}]
          params.encodings[0].maxBitrate = target
          if (scale > 1) params.encodings[0].scaleResolutionDownBy = scale
          else delete (params.encodings[0] as { scaleResolutionDownBy?: number }).scaleResolutionDownBy
          // Talking-head camera: keep frames flowing under pressure and shed
          // resolution; screens keep text sharp instead (applyScreenVideoParams).
          if (!s.screenLive) {
            ;(params as RTCRtpParameters & { degradationPreference?: RTCDegradationPreference }).degradationPreference =
              cap !== null || scale > 1 ? 'maintain-framerate' : 'balanced'
          }
          await sender.setParameters(params)
        } catch {
          /* ignore */
        }
      }
      debugShare = share
    }

    // Ultra-low-bandwidth capture shrink: only when EVERY connected link is
    // weak (a 1:1 call is the old behavior exactly). One bad peer gets a
    // per-sender budget above — the capture everyone encodes stays put.
    if (connectedCount > 0) {
      if (weakCount === connectedCount) void this.shrinkCapture()
      else void this.restoreCapture()
    }

    /* ---- CPU overload ladder (task 2, via adaptive.cpuLadderTick):
       qualityLimitationReason 'cpu' for CPU_STEP_POLLS consecutive polls
       steps down (resolution → fps → audio-only send); recovery climbs one
       step per CPU_RECOVER_POLLS clean polls. Only runs while video is
       actually being sent. ---- */
    const camSending =
      !this.cpuVideoPaused &&
      (useCallStore.getState().self.camOn || (!!this.screenTrack && this.screenTrack.readyState === 'live'))
    const tick = cpuLadderTick(this.cpu, worstReason === 'cpu', camSending)
    this.cpu = tick
    if (tick.changed) void this.applyCpuStep()

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

    // Debug overlay (?debug=1) — 3 s cadence, no extra timers.
    if (this.debugEnabled) {
      useCallStore.getState().setDebug({
        level: overall,
        bweKbps: weakestBwe !== null ? Math.round(weakestBwe / 1000) : 0,
        budgetKbps: Math.round(debugShare / 1000),
        cpuReason: worstReason,
        cpuStep: this.cpu.step,
        encodeMsPerFrame: Math.round(worstEncodeMs * 10) / 10,
        peers: debugPeers,
      })
    }
  }

  /**
   * Apply a CPU-ladder step (task 2). Step 1 = one quality step down in
   * resolution (currentKey() downgrades the profile everywhere), step 2
   * additionally caps capture fps, step 3 = audio-only send. Climbing back
   * out of step 3 re-enables the camera; each transition is one store write.
   */
  private async applyCpuStep() {
    const store = useCallStore.getState()
    if (this.cpu.step >= 3) {
      if (!this.cpuVideoPaused) {
        this.cpuVideoPaused = true
        store.setSelf({ camOn: false })
        this.socket?.emit('state:update', { camOn: false })
        if (this.cameraTrack) this.cameraTrack.enabled = false
        await this.setVideoSendersActive(false)
        toast('CPU overload — switched to audio-only to stay smooth', { duration: 3200 })
      }
      return
    }
    if (this.cpuVideoPaused) {
      this.cpuVideoPaused = false
      store.setSelf({ camOn: true })
      this.socket?.emit('state:update', { camOn: true })
      if (this.cameraTrack) this.cameraTrack.enabled = true
    }
    await this.applyProfile()
    if (this.cpu.step >= 2 && this.cameraTrack?.readyState === 'live') {
      try {
        await this.cameraTrack.applyConstraints({ frameRate: CPU_FPS_CAP })
      } catch {
        /* camera may refuse — the profile cap still helps */
      }
    }
  }

  /* ---------------- chat / lifecycle ---------------- */

  sendChat(text: string, replyTo?: { id: string; name: string; text: string }) {
    const clean = text.trim().slice(0, 500)
    if (!clean) return
    // The quote is a plain-text snapshot: short, self-contained, and safe to
    // keep in a bubble even after the original scrolls out of the 200-cap.
    const rt = replyTo
      ? {
          id: String(replyTo.id || '').slice(0, 16),
          name: String(replyTo.name || 'Guest').slice(0, 24),
          text: String(replyTo.text || '').slice(0, 140),
        }
      : undefined
    this.socket?.emit('chat:message', rt && rt.id && rt.text ? { text: clean, replyTo: rt } : { text: clean })
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
    void this.loadMusic().then((m) => m.detachRemoteMusic())
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
    this.prevInbound.clear()
    this.prevEncode.clear()
    this.wishBy.clear()
    this.lastWish = ''
    this.pollTick = 0
    this.cpu = { step: 0, badTicks: 0, cleanTicks: 0 }
    this.cpuVideoPaused = false
    this.unbindNetwork?.()
    this.unbindNetwork = null
    this.captureShrunk = false
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
