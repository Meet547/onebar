import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'http'
import { Server as IoServer, type Socket } from 'socket.io'
import { versionMismatch } from './version'
import { resolvePicoVersion } from './server-version'

/** Server build identity, answered to the client's version:hello handshake
 *  (see the engine's connect handler). Resolved like the build-time header —
 *  env, .pico-version build stamp, git hash, package.json fallback. */
const SERVER_VERSION = resolvePicoVersion()

/**
 * Pico — embedded in-process signaling relay.
 *
 * The relay is compiled INTO the Next.js server (via instrumentation.ts) so
 * a standalone production build is fully self-contained: no second process,
 * no spawn, no bun, no separate node_modules tree. Media never touches this
 * code — WebRTC carries it peer-to-peer; only kilobyte-sized control events
 * (SDP, ICE, presence, chat text) flow through here.
 *
 * Why in-process: the previous design spawned `mini-services/signaling` as a
 * child process. That works in the sandbox dev flow, but a production
 * standalone bundle has no source tree and no relay node_modules — the spawn
 * silently fails and every join dead-ends in "Could not reach the call
 * relay". Embedding removes the entire class of failure.
 *
 * Topology:
 *   - The Next.js rewrites proxy /signal/* → 127.0.0.1:RELAY_PORT and
 *     /info* → 127.0.0.1:RELAY_INFO_PORT, so the browser only ever talks to
 *     the app origin. The relay binds loopback only — it is not directly
 *     reachable from outside.
 *   - Docker production stack (docker-compose.yml) runs the relay as its own
 *     supervised container instead. Set PICO_EMBEDDED_RELAY=0 on the app to
 *     switch this module off there.
 *   - In sandbox dev the platform bootstrap may still run the standalone
 *     mini-service relay; if its port is already serving a healthy relay we
 *     ADOPT it instead of fighting over the port, and the keeper (see
 *     ensure-relay.ts) takes over with an in-process instance only if the
 *     adopted one ever dies.
 *
 * Security model (identical to the standalone service):
 *  - Media is always encrypted (DTLS-SRTP, by the browser).
 *  - The optional passcode is a room-entry gate only: SHA-256 hash, kept in
 *    memory, never persisted or logged; attempts are rate-limited per client.
 *  - Host powers are issued only by the socket that owns the room — enforced
 *    here, not in the client.
 *  - Every inbound event is rate-limited; oversize payloads are rejected by
 *    the socket.io buffer cap.
 */

export const RELAY_HOST = process.env.RELAY_HOST ?? '127.0.0.1'
export const RELAY_PORT = Number(process.env.RELAY_PORT ?? 3003)
export const RELAY_INFO_PORT = Number(process.env.RELAY_INFO_PORT ?? 3004)
const SOCKET_PATH = process.env.SOCKET_PATH ?? '/'
const MAX_PEERS_PER_ROOM = 10
const REJOIN_GRACE_MS = 120_000
const DISCONNECT_GRACE_MS = 30_000

// ---------------- data model ----------------

interface Peer {
  id: string
  name: string
  micOn: boolean
  camOn: boolean
  sharing: boolean
  reconnecting?: boolean
}

interface ChatMessage {
  id: string
  from: string
  name: string
  text: string
  ts: number
  system?: boolean
  /** Plain-text quote snapshot when the message is a reply. */
  replyTo?: { id: string; name: string; text: string }
}

interface MusicSession {
  peerId: string
  title: string
  streamId: string
  playing: boolean
  position: number
  duration: number
}

interface Room {
  peers: Map<string, Peer>
  hostId: string | null
  locked: boolean
  passwordHash: string
  music: MusicSession | null
  /** Names seen recently — lets reconnects back into a locked room. */
  recentTokens: Map<string, number>
}

const rooms = new Map<string, Room>()
const peerRejoinTokens = new Map<string, string>()

const getRoom = (roomId: string): Room => {
  let room = rooms.get(roomId)
  if (!room) {
    room = { peers: new Map(), hostId: null, locked: false, passwordHash: '', music: null, recentTokens: new Map() }
    rooms.set(roomId, room)
  }
  return room
}

const peerList = (roomId: string): Peer[] => {
  const room = rooms.get(roomId)
  return room ? Array.from(room.peers.values()) : []
}

/** First remaining peer in join order — the map preserves insertion order. */
const nextHost = (room: Room): string | null => {
  for (const id of room.peers.keys()) return id
  return null
}

const safeString = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.slice(0, max) : ''

// ---------------- rate limiting (per socket, fixed window) ----------------

/**
 * Fixed-window limiter. Bucket keys are per-socket and freed on disconnect,
 * so memory stays bounded by live connections. Over-limit events are simply
 * dropped — signaling is idempotent and the client retries what matters.
 */
const buckets = new Map<string, { count: number; resetAt: number }>()

function allow(key: string, max: number, windowMs: number): boolean {
  const now = Date.now()
  const b = buckets.get(key)
  if (!b || now >= b.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs })
    return true
  }
  if (b.count >= max) return false
  b.count++
  return true
}

// Failed passcode attempts per client — small budgets, short cooldowns.
const joinFails = new Map<string, { count: number; blockedUntil: number }>()

const clientKey = (socket: Socket): string => {
  const xff = socket.handshake.headers['x-forwarded-for']
  const ip = (Array.isArray(xff) ? xff[0] : xff) ?? socket.handshake.address ?? '?'
  return String(ip).split(',')[0].trim()
}

function passcodeGateOpen(socket: Socket): boolean {
  const key = clientKey(socket)
  const rec = joinFails.get(key)
  if (rec && Date.now() < rec.blockedUntil) return false
  return true
}

function notePasscodeFail(socket: Socket): void {
  const key = clientKey(socket)
  const rec = joinFails.get(key) ?? { count: 0, blockedUntil: 0 }
  rec.count++
  if (rec.count >= 10) {
    // Ten misses in a row buys a 60-second cooldown — enough to kill brute
    // force, harmless for a human who mistyped.
    rec.blockedUntil = Date.now() + 60_000
    rec.count = 0
  }
  joinFails.set(key, rec)
  // Prune stale entries so the map cannot grow forever
  if (joinFails.size > 1000) {
    const now = Date.now()
    for (const [k, v] of joinFails) {
      if (now > v.blockedUntil) joinFails.delete(k)
    }
  }
}

// ---------------- room-info + health probe (own tiny http server) --------

function createInfoServer(): ReturnType<typeof createHttpServer> {
  const info = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    })
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname === '/health') {
      res.end(JSON.stringify({ ok: true, uptime: Math.round(process.uptime()), rooms: rooms.size }))
      return
    }
    const roomId = (url.searchParams.get('room') ?? '').slice(0, 64)
    const room = rooms.get(roomId)
    res.end(
      JSON.stringify({
        exists: !!room,
        locked: !!room?.locked,
        hasPassword: !!room?.passwordHash,
        count: room?.peers.size ?? 0,
      }),
    )
  })
  info.on('error', (err) => console.error('[relay] info server error:', err.message))
  return info
}

/** engine.io allowRequest — fail-closed Origin check on WS upgrades.
 *  - no Origin header (native clients, probes): allowed
 *  - Origin host === x-forwarded-host (the browser-facing host as seen
 *    through the Next rewrite / a reverse proxy) or === Host header
 *    (direct same-origin): allowed
 *  - exact Origin listed in ORIGIN, or equal to NEXT_PUBLIC_SITE_URL's
 *    origin: allowed
 *  - everything else: rejected
 *  Verified live: the Next rewrite forwards Origin intact and sets
 *  x-forwarded-host to the front-door host while `host` is the upstream
 *  relay address — without the x-forwarded-host comparison every
 *  browser handshake would be rejected through the proxy. */
function originGuard(): (
  req: IncomingMessage,
  cb: (err: string | null | undefined, ok: boolean) => void,
) => void {
  const allowlist = (process.env.ORIGIN ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const siteOrigin = (() => {
    const v = process.env.NEXT_PUBLIC_SITE_URL
    if (!v) return null
    try {
      return new URL(v).origin
    } catch {
      return null
    }
  })()
  return (req, cb) => {
    const origin = req.headers.origin
    if (!origin) return cb(null, true)
    let parsed: URL
    try {
      parsed = new URL(origin)
    } catch {
      return cb(null, false)
    }
    const xfHost = Array.isArray(req.headers['x-forwarded-host'])
      ? req.headers['x-forwarded-host'][0]
      : req.headers['x-forwarded-host']
    const host = req.headers.host ?? ''
    if (xfHost && parsed.host === xfHost.split(',')[0]!.trim()) return cb(null, true)
    if (parsed.host === host) return cb(null, true)
    if (allowlist.includes(origin)) return cb(null, true)
    if (siteOrigin && parsed.origin === siteOrigin) return cb(null, true)
    cb(null, false)
  }
}

// ---------------- wire the socket.io relay onto an http server ------------

function attachRelay(httpServer: ReturnType<typeof createHttpServer>): IoServer {
  const io = new IoServer(httpServer, {
    // Path is configurable so a production proxy can route by path; the app's
    // rewrites strip the /signal prefix, so the relay keeps '/' by default.
    path: SOCKET_PATH,
    cors: { origin: (process.env.ORIGIN ?? '*').split(',').map((s) => s.trim()), methods: ['GET', 'POST'] },
    // Origin gate on the WS upgrade itself (engine.io allowRequest) — CORS
    // headers alone do not stop a cross-origin WebSocket, because browsers do
    // not enforce CORS on upgrades. FAILS CLOSED: no Origin header (native /
    // same-host clients) and exact same-origin always pass; any other origin
    // must be listed in ORIGIN (comma-separated). Default = same-origin only,
    // so a page on another domain cannot open signaling sockets here.
    allowRequest: originGuard(),
    pingTimeout: 45000,
    pingInterval: 20000,
    // Keep the socket payload tiny; websocket transport only after handshake
    transports: ['websocket', 'polling'],
    maxHttpBufferSize: 1e5,
  })

  io.on('connection', (socket: Socket) => {
    let currentRoom: string | null = null
    let peer: Peer | null = null

    const broadcastPresence = (roomId: string) => {
      const room = rooms.get(roomId)
      io.to(roomId).emit('room:peers', { peers: peerList(roomId), hostId: room?.hostId ?? null })
    }

    const promoteHostIfNeeded = (roomId: string) => {
      const room = rooms.get(roomId)
      if (!room || room.peers.size === 0) return
      if (room.hostId && room.peers.has(room.hostId)) return
      const hostId = nextHost(room)
      room.hostId = hostId
      if (hostId) io.to(roomId).emit('host:changed', { hostId })
    }

    // Version handshake (engine sends it on every connect): echo the server
    // build so the client can one-shot reload when a deploy moved under it.
    socket.on('version:hello', (raw: unknown) => {
      const client = safeString((raw as { client?: unknown } | null)?.client, 80) || null
      socket.emit('version:current', {
        server: SERVER_VERSION,
        clientMatches: !versionMismatch(client, SERVER_VERSION),
      })
    })

    socket.on('room:join', (raw: unknown, ack?: (r: unknown) => void) => {
      try {
        const data = (raw ?? {}) as Record<string, unknown>
        const roomId = safeString(data.roomId, 64).trim()
        const name = safeString(data.name, 24).trim() || 'Guest'
        const passwordHash = safeString(data.passwordHash, 64)
      const rejoinToken = safeString(data.rejoinToken, 64)
      if (!allow(`${socket.id}:join`, 20, 10_000)) {
        ack?.({ ok: false, reason: 'Too many join attempts — try again shortly' })
        return
      }
        if (!roomId) { ack?.({ ok: false, reason: 'Invalid room code' }); return }
        // Room ids are join keys — restrict the charset to keep URLs clean.
        if (!/^[a-z0-9-]{4,64}$/.test(roomId)) {
          ack?.({ ok: false, reason: 'Invalid room code' })
          return
        }

        if (!passcodeGateOpen(socket)) {
          ack?.({ ok: false, reason: 'Too many attempts — wait a minute and try again' })
          return
        }

        const room = getRoom(roomId)
        const isFreshRoom = room.peers.size === 0 && !room.passwordHash

        // First joiner defines the room's passcode (optional) — after that the
        // gate only compares SHA-256 hashes in memory.
        if (isFreshRoom && passwordHash) room.passwordHash = passwordHash

        // Passcode gate
        if (room.passwordHash && passwordHash !== room.passwordHash) {
          notePasscodeFail(socket)
          ack?.({ ok: false, reason: 'Wrong passcode' })
          return
        }
        // Host lock: nobody new gets in. People who were just in the call
        // (reconnects within the grace window) still make it back.
        if (
          room.locked &&
          !room.peers.has(socket.id) &&
          !(rejoinToken && room.recentTokens.has(rejoinToken) && Date.now() - room.recentTokens.get(rejoinToken)! < REJOIN_GRACE_MS)
        ) {
          ack?.({ ok: false, reason: 'The host locked this call' })
          return
        }

        const previousPeer = rejoinToken
          ? Array.from(room.peers.values()).find((existing) => existing.id !== socket.id && peerRejoinTokens.get(existing.id) === rejoinToken)
          : undefined
        if (room.peers.size - (previousPeer ? 1 : 0) >= MAX_PEERS_PER_ROOM && !room.peers.has(socket.id)) {
          ack?.({ ok: false, reason: `Room is full (${MAX_PEERS_PER_ROOM} people max)` })
          return
        }

        // Leave previous room if switching
        if (currentRoom && currentRoom !== roomId) {
          leaveRoom()
        }

        currentRoom = roomId
      socket.data.rejoinToken = rejoinToken
        if (previousPeer) {
          room.peers.delete(previousPeer.id)
          peerRejoinTokens.delete(previousPeer.id)
          room.recentTokens.delete(rejoinToken)
          if (room.hostId === previousPeer.id) room.hostId = socket.id
          if (room.music?.peerId === previousPeer.id) room.music.peerId = socket.id
        }
        peer = { id: socket.id, name: previousPeer?.name ?? name, micOn: previousPeer?.micOn ?? true, camOn: previousPeer?.camOn ?? true, sharing: previousPeer?.sharing ?? false }
        if (rejoinToken) peerRejoinTokens.set(socket.id, rejoinToken)
        room.peers.set(socket.id, peer)
        if (!room.hostId) room.hostId = socket.id
        socket.join(roomId)

        ack?.({
          ok: true,
          self: peer,
          peers: peerList(roomId),
          hostId: room.hostId,
          locked: room.locked,
          hasPassword: !!room.passwordHash,
          music: room.music
            ? {
                peerId: room.music.peerId,
                title: room.music.title,
                playing: room.music.playing,
                position: room.music.position,
                duration: room.music.duration,
                streamId: room.music.streamId,
              }
            : null,
        })
        if (previousPeer) socket.to(roomId).emit('peer:reconnected', { oldPeerId: previousPeer.id, peer })
        else socket.to(roomId).emit('peer:joined', { peer })
        broadcastPresence(roomId)
      } catch {
        ack?.({ ok: false, reason: 'Could not join the room' })
      }
    })

    const leaveRoom = () => {
      if (!currentRoom) return
      const roomId = currentRoom
      // A removed peer must not re-enter the reconnect grace window
      const wasKicked = socket.data.kicked === true
      socket.data.kicked = false
      const room = rooms.get(roomId)
      if (wasKicked) {
        socket.leave(roomId)
        currentRoom = null
        peer = null
        return
      }
      if (room) {
        room.peers.delete(socket.id)
        peerRejoinTokens.delete(socket.id)
        if (socket.data.rejoinToken) {
          room.recentTokens.set(socket.data.rejoinToken, Date.now())
          if (room.recentTokens.size > 100) {
            const now = Date.now()
            for (const [n, ts] of room.recentTokens) {
              if (now - ts > REJOIN_GRACE_MS) room.recentTokens.delete(n)
            }
          }
        }
        if (room.peers.size === 0) {
          rooms.delete(roomId)
        } else {
          socket.to(roomId).emit('peer:left', { peerId: socket.id })
          if (room.music?.peerId === socket.id) {
            room.music = null
            io.to(roomId).emit('music:state', { action: 'stop', peerId: socket.id })
          }
          promoteHostIfNeeded(roomId)
          broadcastPresence(roomId)
        }
      }
      socket.leave(roomId)
      currentRoom = null
      peer = null
    }

    socket.on('room:leave', () => leaveRoom())

    socket.on('state:update', (raw: unknown) => {
      if (!currentRoom || !peer || !rooms.get(currentRoom)?.peers.has(socket.id)) return
      if (!allow(`${socket.id}:state`, 60, 10_000)) return
      const data = (raw ?? {}) as Record<string, unknown>
      if (typeof data.micOn === 'boolean') peer.micOn = data.micOn
      if (typeof data.camOn === 'boolean') peer.camOn = data.camOn
      if (typeof data.sharing === 'boolean') peer.sharing = data.sharing
      socket.to(currentRoom).emit('peer:state', {
        peerId: peer.id,
        micOn: peer.micOn,
        camOn: peer.camOn,
        sharing: peer.sharing,
      })
    })

    // ---- Host controls ----

    const isHost = () => {
      const room = currentRoom ? rooms.get(currentRoom) : null
      return !!room && room.hostId === socket.id
    }

    socket.on('host:mute', (raw: unknown) => {
      if (!currentRoom || !isHost()) return
      if (!allow(`${socket.id}:host`, 30, 10_000)) return
      const target = safeString((raw as Record<string, unknown>)?.target, 40)
      const room = rooms.get(currentRoom)!
      if (target && target !== socket.id && room.peers.has(target)) {
        io.to(target).emit('host:force-mute')
      }
    })

    socket.on('host:mute-all', () => {
      if (!currentRoom || !isHost()) return
      if (!allow(`${socket.id}:host`, 30, 10_000)) return
      const room = rooms.get(currentRoom)!
      for (const id of room.peers.keys()) {
        if (id !== socket.id) io.to(id).emit('host:force-mute')
      }
    })

    socket.on('host:remove', (raw: unknown) => {
      if (!currentRoom || !isHost()) return
      if (!allow(`${socket.id}:host`, 30, 10_000)) return
      const target = safeString((raw as Record<string, unknown>)?.target, 40)
      const room = rooms.get(currentRoom)!
      if (!target || target === socket.id || !room.peers.has(target)) return
      io.to(target).emit('room:kicked')
      const targetSocket = io.sockets.sockets.get(target)
      if (targetSocket) {
        targetSocket.leave(currentRoom)
        targetSocket.data.kicked = true
      }
      const kickedPeer = room.peers.get(target)
      if (targetSocket?.data.rejoinToken) room.recentTokens.delete(targetSocket.data.rejoinToken)
      room.peers.delete(target)
      peerRejoinTokens.delete(target)
      if (room.music?.peerId === target) {
        room.music = null
        io.to(currentRoom).emit('music:state', { action: 'stop', peerId: target })
      }
      socket.to(currentRoom).emit('peer:left', { peerId: target })
      broadcastPresence(currentRoom)
    })

    socket.on('host:lock', (raw: unknown) => {
      if (!currentRoom || !isHost()) return
      if (!allow(`${socket.id}:host`, 30, 10_000)) return
      const locked = (raw as Record<string, unknown>)?.locked === true
      const room = rooms.get(currentRoom)!
      room.locked = locked
      io.to(currentRoom).emit('room:locked', { locked })
    })

    // ---- Listen together (control metadata only — audio is P2P) ----

    socket.on('music:state', (raw: unknown) => {
      if (!currentRoom || !rooms.get(currentRoom)?.peers.has(socket.id)) return
      if (!allow(`${socket.id}:music`, 40, 10_000)) return
      const room = rooms.get(currentRoom)
      if (!room) return
      const data = (raw ?? {}) as Record<string, unknown>
      const action = safeString(data.action, 8)

      if (action === 'start') {
        if (room.music && room.music.peerId !== socket.id) {
          socket.emit('music:busy')
          return
        }
        room.music = {
          peerId: socket.id,
          title: safeString(data.title, 80) || 'Music',
          streamId: safeString(data.streamId, 64),
          playing: data.playing === true,
          position: typeof data.position === 'number' ? data.position : 0,
          duration: typeof data.duration === 'number' ? data.duration : 0,
        }
      } else if (room.music?.peerId === socket.id) {
        // Only the current sharer may update or stop the session — this is a
        // multi-user room, so actions are scoped to their owner.
        if (action === 'stop') {
          room.music = null
        } else if (action === 'meta') {
          room.music.playing = data.playing === true
          room.music.position = typeof data.position === 'number' ? data.position : 0
          room.music.duration = typeof data.duration === 'number' ? data.duration : room.music.duration
          room.music.title = safeString(data.title, 80) || room.music.title
        }
      } else if (action !== 'start') {
        return // not the sharer — do not relay spoofed stop/meta events
      }

      // Relay to everyone else (the sender keeps its own state)
      socket.to(currentRoom).emit('music:state', {
        peerId: socket.id,
        action,
        streamId: safeString(data.streamId, 64),
        title: safeString(data.title, 80),
        playing: data.playing === true,
        position: typeof data.position === 'number' ? data.position : 0,
        duration: typeof data.duration === 'number' ? data.duration : 0,
      })
    })

    // ---- WebRTC signaling relay (peer-to-peer setup only) ----

    socket.on('rtc:offer', (raw: unknown) => {
      if (!allow(`${socket.id}:rtc`, 240, 10_000)) return
      const data = (raw ?? {}) as Record<string, unknown>
      const to = safeString(data.to, 40)
      const sdp = safeString(data.sdp, 20000)
      if (currentRoom && rooms.get(currentRoom)?.peers.has(socket.id) && to !== socket.id && rooms.get(currentRoom)?.peers.has(to) && sdp) io.to(to).emit('rtc:offer', { from: socket.id, sdp })
    })

    socket.on('rtc:answer', (raw: unknown) => {
      if (!allow(`${socket.id}:rtc`, 240, 10_000)) return
      const data = (raw ?? {}) as Record<string, unknown>
      const to = safeString(data.to, 40)
      const sdp = safeString(data.sdp, 20000)
      if (currentRoom && rooms.get(currentRoom)?.peers.has(socket.id) && to !== socket.id && rooms.get(currentRoom)?.peers.has(to) && sdp) io.to(to).emit('rtc:answer', { from: socket.id, sdp })
    })

    socket.on('rtc:ice', (raw: unknown) => {
      if (!allow(`${socket.id}:rtc`, 240, 10_000)) return
      const data = (raw ?? {}) as Record<string, unknown>
      const to = safeString(data.to, 40)
      if (currentRoom && rooms.get(currentRoom)?.peers.has(socket.id) && to !== socket.id && rooms.get(currentRoom)?.peers.has(to)) socket.to(to).emit('rtc:ice', { from: socket.id, candidate: data.candidate })
    })

    // ---- Receive-side video interest (tile visibility / speaker shedding) ----
    // A client announces WHICH peers it wants video from (visible tiles,
    // active speaker, spotlight). Senders react by pausing encodings toward
    // peers who are not watched — sender-side CPU and mesh upload drop with
    // zero renegotiation. Payload is a small id list, re-sanitized here.
    socket.on('video:wish', (raw: unknown) => {
      if (!currentRoom || !peer || !rooms.get(currentRoom)?.peers.has(socket.id)) return
      if (!allow(`${socket.id}:chat`, 25, 10_000)) return
      const data = (raw ?? {}) as Record<string, unknown>
      const list = Array.isArray(data.targets) ? data.targets : []
      const targets = list
        .map((t) => safeString(t, 40))
        .filter(Boolean)
        .slice(0, 16)
      socket.to(currentRoom).emit('video:wish', { from: socket.id, targets })
    })

    // ---- Chat (kilobytes of text, relayed) ----

    socket.on('chat:message', (raw: unknown) => {
      if (!currentRoom || !peer || !rooms.get(currentRoom)?.peers.has(socket.id)) return
      if (!allow(`${socket.id}:chat`, 25, 10_000)) return
      const data = (raw ?? {}) as Record<string, unknown>
      const text = safeString(data.text, 500).trim()
      if (!text) return
      // Reply quotes are an optional plain-text snapshot, re-sanitized here so
      // no client can smuggle oversized/typed payloads through the room.
      let replyTo: ChatMessage['replyTo']
      const rt = data.replyTo as Record<string, unknown> | undefined
      if (rt && typeof rt === 'object') {
        const rid = safeString(rt.id, 16)
        const rtext = safeString(rt.text, 140).trim()
        if (rid && rtext) replyTo = { id: rid, name: safeString(rt.name, 24) || 'Guest', text: rtext }
      }
      const msg: ChatMessage = {
        id: Math.random().toString(36).slice(2, 11),
        from: peer.id,
        name: peer.name,
        text,
        ts: Date.now(),
        ...(replyTo ? { replyTo } : {}),
      }
      io.to(currentRoom).emit('chat:message', msg)
      socket.emit('chat:sent', { id: msg.id })
    })

    socket.on('chat:typing', (raw: unknown) => {
      if (!currentRoom || !peer || !rooms.get(currentRoom)?.peers.has(socket.id)) return
      if (!allow(`${socket.id}:chat-typing`, 8, 5_000)) return
      const data = (raw ?? {}) as Record<string, unknown>
      socket.to(currentRoom).emit('chat:typing', {
        peerId: socket.id,
        name: peer.name,
        typing: data.typing === true,
      })
    })

    socket.on('disconnect', () => {
      if (socket.data.kicked) leaveRoom()
      if (currentRoom && peer && !socket.data.kicked) {
        const roomId = currentRoom
        const room = rooms.get(roomId)
        const current = room?.peers.get(socket.id)
        if (current) current.reconnecting = true
        if (room && socket.data.rejoinToken) room.recentTokens.set(socket.data.rejoinToken, Date.now())
        socket.to(roomId).emit('peer:reconnecting', { peer: current ?? peer, graceMs: DISCONNECT_GRACE_MS })
        setTimeout(() => {
          const room = rooms.get(roomId)
          const old = room?.peers.get(socket.id)
          if (!room || !old?.reconnecting) return
          room.peers.delete(socket.id)
          peerRejoinTokens.delete(socket.id)
          if (room.music?.peerId === socket.id) {
            room.music = null
            io.to(roomId).emit('music:state', { action: 'stop', peerId: socket.id })
          }
          if (room.peers.size === 0) rooms.delete(roomId)
          else {
            socket.to(roomId).emit('peer:left', { peerId: socket.id })
            promoteHostIfNeeded(roomId)
            broadcastPresence(roomId)
          }
        }, DISCONNECT_GRACE_MS).unref?.()
      }
      for (const key of buckets.keys()) {
        if (key.startsWith(socket.id + ':')) buckets.delete(key)
      }
    })
    socket.on('error', () => leaveRoom())
  })

  return io
}

// ---------------- lifecycle: probe / adopt / bind ----------------

export interface EmbeddedRelay {
  /** True when this process owns the listening sockets. */
  owned: boolean
  /** True when a healthy relay was already listening and was adopted. */
  adopted: boolean
  close(): void
}

type RelayGlobal = typeof globalThis & {
  __picoEmbeddedRelay?: EmbeddedRelay & { starting?: Promise<EmbeddedRelay> }
}
const g = globalThis as RelayGlobal

/**
 * Real engine.io handshake probe — not just a TCP connect. A half-dead
 * process that holds the port but no longer speaks socket.io must count as
 * DOWN, otherwise the keeper would trust a zombie and never take over.
 * Resolves true only for `200` + an engine.io open packet (`0…`).
 */
export function probeRelay(timeoutMs = 1_000, port = RELAY_PORT): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const done = (ok: boolean) => {
      if (settled) return
      settled = true
      resolve(ok)
    }
    fetch(`http://${RELAY_HOST}:${port}/?EIO=4&transport=polling`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { connection: 'close' },
    })
      .then(async (res) => {
        if (res.status !== 200) return done(false)
        const body = await res.text().catch(() => '')
        // engine.io v4 open packet: "0{...}"
        done(body.startsWith('0'))
      })
      .catch(() => done(false))
  })
}

async function bindEmbedded(): Promise<EmbeddedRelay> {
  const httpServer = createHttpServer()
  const io = attachRelay(httpServer)
  const infoServer = createInfoServer()

  const close = () => {
    try {
      io.close()
    } catch { /* already closed */ }
    try {
      httpServer.close()
    } catch { /* already closed */ }
    try {
      infoServer.close()
    } catch { /* already closed */ }
  }

  // Bind both listeners; ANY bind failure falls back to adoption so we never
  // end up owning zero sockets while believing we own both.
  const bind = (server: ReturnType<typeof createHttpServer>, port: number, name: string) =>
    new Promise<boolean>((resolve) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.off('error', onError)
        console.error(`[relay] ${name} bind failed on :${port} —`, err.message)
        resolve(false)
      }
      server.once('error', onError)
      server.listen(port, RELAY_HOST, () => {
        server.off('error', onError)
        resolve(true)
      })
    })

  const [mainOk, infoOk] = await Promise.all([
    bind(httpServer, RELAY_PORT, 'relay'),
    bind(infoServer, RELAY_INFO_PORT, 'info'),
  ])

  if (!mainOk) {
    close()
    // Someone else holds the port. If it is a healthy relay, adopt it.
    if (await probeRelay(1_500)) {
      console.log('[relay] adopted existing healthy relay')
      return { owned: false, adopted: true, close: () => {} }
    }
    throw new Error(`relay port ${RELAY_PORT} unavailable and no healthy relay to adopt`)
  }

  console.log(
    `[relay] embedded signaling up on ${RELAY_HOST}:${RELAY_PORT}` +
      (infoOk ? ` (info :${RELAY_INFO_PORT})` : ' (info port unavailable)') +
      ` (path ${SOCKET_PATH})`,
  )
  return { owned: true, adopted: false, close }
}

/**
 * Start (or adopt) the relay exactly once per process. Safe to call from
 * both instrumentation boot and the keeper: concurrent callers share one
 * startup promise, and repeated calls return the live handle.
 */
export async function startEmbeddedRelay(): Promise<EmbeddedRelay | null> {
  if (process.env.PICO_EMBEDDED_RELAY === '0') return null
  const existing = g.__picoEmbeddedRelay
  if (existing) {
    if (existing.starting) return existing.starting
    return existing
  }
  const starting = (async () => {
    // A relay may already be listening (sandbox dev mini-service, previous
    // process). Never fight over the port — probe first, adopt if healthy.
    if (await probeRelay(600)) {
      console.log('[relay] healthy relay already listening — adopting')
      const handle: EmbeddedRelay & { starting?: Promise<EmbeddedRelay> } = {
        owned: false,
        adopted: true,
        close: () => {},
      }
      g.__picoEmbeddedRelay = handle
      return handle
    }
    const handle = await bindEmbedded()
    g.__picoEmbeddedRelay = handle
    return handle
  })()
  const wrapper: NonNullable<RelayGlobal['__picoEmbeddedRelay']> = {
    starting,
    // Placeholder fields replaced when the promise settles; the `starting`
    // field above is what late callers actually read.
    owned: false,
    adopted: false,
    close: () => {},
  }
  g.__picoEmbeddedRelay = wrapper
  try {
    return await starting
  } catch (err) {
    g.__picoEmbeddedRelay = undefined
    console.error('[relay] failed to start embedded relay:', err instanceof Error ? err.message : err)
    return null
  }
}

/**
 * Drop the singleton so a later startEmbeddedRelay() binds fresh sockets.
 * Used by the keeper when an adopted relay died and nothing healthy remains.
 * Never closes sockets this process owns — the keeper calls close() itself.
 */
export function resetEmbeddedRelay(): void {
  g.__picoEmbeddedRelay = undefined
}

/** Test/keeper hook: close owned sockets and clear the singleton. */
export async function closeEmbeddedRelay(): Promise<void> {
  const handle = g.__picoEmbeddedRelay
  g.__picoEmbeddedRelay = undefined
  if (handle && handle.owned) handle.close()
}
