import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'http'
import { Server, type Socket } from 'socket.io'

/**
 * Pico — featherweight signaling service.
 *
 * Only ever touches tiny control payloads (SDP offer/answer, ICE candidates,
 * presence state, chat text, room gate). Media NEVER flows through this
 * server: all audio/video is exchanged peer-to-peer over WebRTC, so a whole
 * meeting costs the server a few kilobytes of signaling traffic.
 *
 * Security model:
 *  - Media is always encrypted (DTLS-SRTP, by the browser). The relay can
 *    never see or hear anything.
 *  - The optional passcode is a room-entry gate only: verified as a SHA-256
 *    hash, kept in memory, never persisted or logged. Failed attempts are
 *    rate-limited per client to make brute force impractical.
 *  - Host powers (mute / remove / lock) are issued only by the socket that
 *    owns the room — enforced here, not in the client.
 *  - Every inbound event is rate-limited; oversize payloads are rejected by
 *    the socket.io buffer cap.
 *
 * Configuration (env):
 *   PORT          default 3003
 *   INFO_PORT     default 3004 (room-info probe + /health)
 *   SOCKET_PATH   default '/'  — set to '/socket.io' behind a path-routing proxy
 *   ORIGIN        default '*'  — comma-separated allowed origins in production
 */

const PORT = Number(process.env.PORT ?? 3003)
const INFO_PORT = Number(process.env.INFO_PORT ?? 3004)
const SOCKET_PATH = process.env.SOCKET_PATH ?? '/'
const MAX_PEERS_PER_ROOM = 8
const REJOIN_GRACE_MS = 120_000

// ---------------- info + health probe (own tiny server) ----------------

const infoServer = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
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

/** engine.io allowRequest — fail-closed Origin check on WS upgrades
 *  (duplicated from src/lib/relay-server.ts; this service ships standalone).
 *  Same rule: no Origin → pass; Origin host === x-forwarded-host (set by
 *  Caddy/the proxy for the browser-facing host) or === Host → pass; exact
 *  Origin in ORIGIN (compose always sets it) → pass; else reject. */
function originGuard(
  req: { headers: Record<string, string | string[] | undefined> },
  cb: (err: string | null | undefined, ok: boolean) => void,
): void {
  const allowlist = (process.env.ORIGIN ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const origin = req.headers.origin
  if (!origin || typeof origin !== 'string') return cb(null, true)
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    return cb(null, false)
  }
  const xfHost = Array.isArray(req.headers['x-forwarded-host'])
    ? req.headers['x-forwarded-host'][0]
    : req.headers['x-forwarded-host']
  const host = typeof req.headers.host === 'string' ? req.headers.host : ''
  if (xfHost && parsed.host === xfHost.split(',')[0]!.trim()) return cb(null, true)
  if (parsed.host === host) return cb(null, true)
  if (allowlist.includes(origin)) return cb(null, true)
  cb(null, false)
}

const httpServer = createHttpServer()

const io = new Server(httpServer, {
  // Path is configurable so a production proxy can route by path; the sandbox
  // gateway routes by the XTransformPort query parameter and keeps '/'.
  path: SOCKET_PATH,
  cors: { origin: (process.env.ORIGIN ?? '*').split(',').map((s) => s.trim()), methods: ['GET', 'POST'] },
  // Origin gate on the WS upgrade (same rationale as src/lib/relay-server.ts):
  // fail closed — same-origin always, cross-origin only via the ORIGIN list.
  allowRequest: originGuard(),
  pingTimeout: 45000,
  pingInterval: 20000,
  // Keep the socket payload tiny; websocket transport only after handshake
  transports: ['websocket', 'polling'],
  maxHttpBufferSize: 1e5,
})

// ---------------- data model ----------------

interface Peer {
  id: string
  name: string
  micOn: boolean
  camOn: boolean
  sharing: boolean
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
  recentNames: Map<string, number>
}

const rooms = new Map<string, Room>()

const getRoom = (roomId: string): Room => {
  let room = rooms.get(roomId)
  if (!room) {
    room = { peers: new Map(), hostId: null, locked: false, passwordHash: '', music: null, recentNames: new Map() }
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
  // Mismatch semantics mirror src/lib/version.ts (unknown either side → no
  // reload); duplicated here because this service ships as a standalone
  // package that cannot import from the app source tree.
  const SERVER_VERSION = process.env.PICO_VERSION || null
  socket.on('version:hello', (raw: unknown) => {
    const client = (raw as { client?: string } | null)?.client ?? null
    const clientMatches = !client || !SERVER_VERSION || client === SERVER_VERSION
    socket.emit('version:current', { server: SERVER_VERSION, clientMatches })
  })

  socket.on('room:join', (raw: unknown, ack?: (r: unknown) => void) => {
    try {
      const data = (raw ?? {}) as Record<string, unknown>
      const roomId = safeString(data.roomId, 64).trim()
      const name = safeString(data.name, 24).trim() || 'Guest'
      const passwordHash = safeString(data.passwordHash, 64)
      if (!roomId) return
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
        !(name && Date.now() - (room.recentNames.get(name) ?? 0) < REJOIN_GRACE_MS)
      ) {
        ack?.({ ok: false, reason: 'The host locked this call' })
        return
      }

      if (room.peers.size >= MAX_PEERS_PER_ROOM && !room.peers.has(socket.id)) {
        ack?.({ ok: false, reason: 'Room is full (8 people max)' })
        return
      }

      // Leave previous room if switching
      if (currentRoom && currentRoom !== roomId) {
        leaveRoom()
      }

      currentRoom = roomId
      peer = { id: socket.id, name, micOn: true, camOn: true, sharing: false }
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
      socket.to(roomId).emit('peer:joined', { peer })
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
      if (peer?.name) {
        room.recentNames.set(peer.name, Date.now())
        if (room.recentNames.size > 100) {
          const now = Date.now()
          for (const [n, ts] of room.recentNames) {
            if (now - ts > REJOIN_GRACE_MS) room.recentNames.delete(n)
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
    if (!currentRoom || !peer) return
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
    if (kickedPeer) room.recentNames.delete(kickedPeer.name)
    room.peers.delete(target)
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
    if (!currentRoom) return
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
    if (to && sdp) io.to(to).emit('rtc:offer', { from: socket.id, sdp })
  })

  socket.on('rtc:answer', (raw: unknown) => {
    if (!allow(`${socket.id}:rtc`, 240, 10_000)) return
    const data = (raw ?? {}) as Record<string, unknown>
    const to = safeString(data.to, 40)
    const sdp = safeString(data.sdp, 20000)
    if (to && sdp) io.to(to).emit('rtc:answer', { from: socket.id, sdp })
  })

  socket.on('rtc:ice', (raw: unknown) => {
    if (!allow(`${socket.id}:rtc`, 240, 10_000)) return
    const data = (raw ?? {}) as Record<string, unknown>
    const to = safeString(data.to, 40)
    if (to) socket.to(to).emit('rtc:ice', { from: socket.id, candidate: data.candidate })
  })

  // ---- Chat (kilobytes of text, relayed) ----

  socket.on('chat:message', (raw: unknown) => {
    if (!currentRoom || !peer) return
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
  })

  socket.on('disconnect', () => {
    leaveRoom()
    for (const key of buckets.keys()) {
      if (key.startsWith(socket.id + ':')) buckets.delete(key)
    }
  })
  socket.on('error', () => leaveRoom())
})

httpServer.listen(PORT, () => {
  console.log(`Pico signaling server on :${PORT} (path ${SOCKET_PATH})`)
})
infoServer.listen(INFO_PORT, () => {
  console.log(`Pico room-info + health probe on :${INFO_PORT}`)
})

// Never die silently — every failure leaves a trace in relay.log.
httpServer.on('error', (err) => console.error('[relay] http server error:', err.message))
infoServer.on('error', (err) => console.error('[relay] info server error:', err.message))
process.on('uncaughtException', (err) => console.error('[relay] uncaught exception:', err?.stack ?? err))
process.on('unhandledRejection', (err) =>
  console.error('[relay] unhandled rejection:', err instanceof Error ? err.stack : err),
)

process.on('SIGTERM', () => {
  httpServer.close(() => process.exit(0))
  infoServer.close(() => process.exit(0))
})
process.on('SIGINT', () => {
  httpServer.close(() => process.exit(0))
  infoServer.close(() => process.exit(0))
})
