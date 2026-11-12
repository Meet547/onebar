'use client'

import { io, type Socket } from 'socket.io-client'
import { useCallStore, setStream as putStream } from './store'
import { createTestStream } from './test-stream'
import {
  LINK_CAPS,
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
}

interface LinkInfo {
  lastCap: number | null
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Add Opus DTX + low bitrate cap to SDP — near-zero cost for silence. */
function mungeOpus(sdp: string): string {
  const lines = sdp.split('\r\n')
  const opusPTs = new Set<string>()
  for (const line of lines) {
    const m = line.match(/^a=rtpmap:(\d+) opus\/48000/i)
    if (m) opusPTs.add(m[1])
  }
  const out = lines.map((line) => {
    const m = line.match(/^a=fmtp:(\d+)(.*)$/)
    if (m && opusPTs.has(m[1])) {
      let params = m[2] ?? ''
      if (!/usedtx/i.test(params)) params += ';usedtx=1'
      if (!/maxaveragebitrate/i.test(params)) params += ';maxaveragebitrate=24000'
      return `a=fmtp:${m[1]}${params}`
    }
    return line
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
  private sendersMap = new Map<string, { audio?: RTCRtpSender; video?: RTCRtpSender }>()
  private pendingIce = new Map<string, RTCIceCandidateInit[]>()
  private links = new Map<string, LinkInfo>()
  private statsTimer: number | null = null
  private makingOffer = new Map<string, boolean>()
  private ignoreOffer = new Map<string, boolean>()
  private preset: QualityPreset = 'balanced'
  private adaptiveProfile: Exclude<QualityPreset, 'auto'> = 'balanced'
  private badCount = 0
  private goodCount = 0
  private started = false
  private testMode = false
  private mediaMode: MediaMode = 'full'
  private prevBytes = new Map<string, number>()

  async start(opts: StartOptions): Promise<{ mode: MediaMode }> {
    if (this.started) await this.leave(true)
    this.started = true
    this.roomId = opts.roomId
    this.preset = opts.preset
    this.adaptiveProfile = opts.preset === 'auto' ? 'balanced' : opts.preset
    this.testMode = !!opts.testMode

    const store = useCallStore.getState()
    store.setSelf({ name: opts.name })
    store.setPreset(opts.preset)
    store.setEffectiveLabel(this.effectiveLabel())

    // ---- Signaling ----
    const socket = io('/?XTransformPort=3003', {
      path: '/',
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 4000,
      timeout: 8000,
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

    // ---- Room ----
    // The ack races a timeout so a dead signaling server can never hang the UI.
    await new Promise<void>((resolve) => {
      let settled = false
      const finish = () => {
        if (!settled) {
          settled = true
          resolve()
        }
      }
      const guard = window.setTimeout(finish, 12000)
      socket.emit(
        'room:join',
        { roomId: this.roomId, name: opts.name },
        (res: { ok: boolean; self?: { id: string }; peers?: Array<{ id: string; name: string; micOn: boolean; camOn: boolean; sharing: boolean }>; reason?: string }) => {
          window.clearTimeout(guard)
          if (!res?.ok) {
            useCallStore.getState().addChat({
              id: 'sys-' + Date.now(),
              from: 'system',
              name: 'System',
              text: res?.reason ?? 'Could not join the room',
              ts: Date.now(),
              system: true,
            })
          }
          this.myId = res?.self?.id ?? socket.id!
          useCallStore.getState().setSelf({ id: this.myId })
          if (res?.peers) this.reconcilePeers(res.peers)
          finish()
        },
      )
    })

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

    socket.on('rtc:offer', async ({ from, sdp }: { from: string; sdp: string }) => {
      try {
        const pc = this.pcs.get(from)
        if (!pc) return
        const polite = this.myId < from
        const offerCollision = this.makingOffer.get(from) || pc.signalingState !== 'stable'
        this.ignoreOffer.set(from, !polite && offerCollision)
        if (this.ignoreOffer.get(from)) return
        await pc.setRemoteDescription({ type: 'offer', sdp: mungeOpus(sdp) })
        await this.flushIce(from)
        const answer = await pc.createAnswer()
        answer.sdp = mungeOpus(answer.sdp ?? '')
        await pc.setLocalDescription(answer)
        this.socket?.emit('rtc:answer', { to: from, sdp: pc.localDescription!.sdp })
      } catch {
        /* negotiation raced — next round will fix it */
      }
    })

    socket.on('rtc:answer', async ({ from, sdp }: { from: string; sdp: string }) => {
      try {
        const pc = this.pcs.get(from)
        if (!pc || pc.signalingState !== 'have-local-offer') return
        await pc.setRemoteDescription({ type: 'answer', sdp: mungeOpus(sdp) })
        await this.flushIce(from)
      } catch {
        /* ignore */
      }
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
      iceServers: ICE_SERVERS,
      iceCandidatePoolSize: 4,
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
    })
    this.pcs.set(peerId, pc)
    this.links.set(peerId, { lastCap: null })
    this.makingOffer.set(peerId, false)
    this.ignoreOffer.set(peerId, false)

    // Local media into this connection
    const senders: { audio?: RTCRtpSender; video?: RTCRtpSender } = {}
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
    } else {
      const at = pc.addTransceiver('audio', { direction: 'recvonly' })
      const vt = pc.addTransceiver('video', { direction: 'recvonly' })
      senders.audio = at.sender
      senders.video = vt.sender
    }
    this.sendersMap.set(peerId, senders)

    pc.onicecandidate = (e) => {
      if (e.candidate) this.socket?.emit('rtc:ice', { to: peerId, candidate: e.candidate.toJSON() })
    }

    pc.ontrack = (e) => {
      const stream = e.streams[0]
      if (!stream) return
      putStream(peerId, stream)
      useCallStore.getState().bumpPeerStream(peerId, true)
    }

    pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer.set(peerId, true)
        const offer = await pc.createOffer()
        await pc.setLocalDescription({ type: 'offer', sdp: mungeOpus(offer.sdp ?? '') })
        const desc = pc.localDescription
        if (desc) this.socket?.emit('rtc:offer', { to: peerId, sdp: desc.sdp })
      } catch {
        /* ignore */
      } finally {
        this.makingOffer.set(peerId, false)
      }
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
    putStream(peerId, null)
    useCallStore.getState().bumpPeerStream(peerId, false)
    useCallStore.getState().removePeer(peerId)
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

  async toggleShare(): Promise<boolean> {
    const sharing = !useCallStore.getState().self.sharing
    if (sharing) {
      try {
        const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
        const track = display.getVideoTracks()[0]
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
        return true
      } catch {
        return false
      }
    } else {
      await this.stopShare()
      return false
    }
  }

  private async stopShare() {
    this.screenTrack?.stop()
    this.screenTrack = null
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
          if (r.type === 'outbound-rtp' && r.kind === 'video' && typeof r.bytesSent === 'number') {
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
      { roomId: this.roomId, name: useCallStore.getState().self.name },
      (res: { ok: boolean; self?: { id: string }; peers?: Array<{ id: string; name: string; micOn: boolean; camOn: boolean; sharing: boolean }> }) => {
        // The server hands out a fresh socket id after a reconnect — adopt it,
        // otherwise our own messages and presence updates stop matching.
        if (res?.ok) {
          if (res.self?.id && res.self.id !== this.myId) {
            this.myId = res.self.id
            useCallStore.getState().setSelf({ id: res.self.id })
          }
          if (res.peers) this.reconcilePeers(res.peers)
        }
      },
    )
  }

  async leave(silent = false) {
    if (this.statsTimer !== null) {
      window.clearInterval(this.statsTimer)
      this.statsTimer = null
    }
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
