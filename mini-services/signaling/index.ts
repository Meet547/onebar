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
 * Security model: media is always encrypted (DTLS-SRTP, by the browser).
 * The optional passcode is a room-entry gate only — checked as a hash, kept
 * in memory, never persisted. Host powers (mute / remove / lock) are issued
 * only by the socket that owns the room.
 */

// Socket.io owns every path on `httpServer` (path: '/' is required by the
// Caddy gateway), so the room-info probe gets its own tiny server.
const infoServer = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  })
  const url = new URL(req.url ?? '/', 'http://x')
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

const httpServer = createHttpServer()

const io = new Server(httpServer, {
  // DO NOT change the path, it is used by Caddy to forward the request to the correct port
  path: '/',
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 45000,
  pingInterval: 20000,
  // Keep the socket payload tiny; websocket transport only after handshake
  transports: ['websocket', 'polling'],
  maxHttpBufferSize: 1e5,
})

const MAX_PEERS_PER_ROOM = 8
const REJOIN_GRACE_MS = 120_000

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

  socket.on('room:join', (raw: unknown, ack?: (r: unknown) => void) => {
    try {
      const data = (raw ?? {}) as Record<string, unknown>
      const roomId = safeString(data.roomId, 64).trim()
      const name = safeString(data.name, 24).trim() || 'Guest'
      const passwordHash = safeString(data.passwordHash, 64)
      if (!roomId) return

      const room = getRoom(roomId)
      const isFreshRoom = room.peers.size === 0 && !room.passwordHash

      // First joiner defines the room's passcode (optional) — after that the
      // gate only compares hashes in memory.
      if (isFreshRoom && passwordHash) room.passwordHash = passwordHash

      // Passcode gate — hash compared in memory, nothing stored or logged.
      if (room.passwordHash && passwordHash !== room.passwordHash) {
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
    const target = safeString((raw as Record<string, unknown>)?.target, 40)
    const room = rooms.get(currentRoom)!
    if (target && target !== socket.id && room.peers.has(target)) {
      io.to(target).emit('host:force-mute')
    }
  })

  socket.on('host:mute-all', () => {
    if (!currentRoom || !isHost()) return
    const room = rooms.get(currentRoom)!
    for (const id of room.peers.keys()) {
      if (id !== socket.id) io.to(id).emit('host:force-mute')
    }
  })

  socket.on('host:remove', (raw: unknown) => {
    if (!currentRoom || !isHost()) return
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
    const locked = (raw as Record<string, unknown>)?.locked === true
    const room = rooms.get(currentRoom)!
    room.locked = locked
    io.to(currentRoom).emit('room:locked', { locked })
  })

  // ---- Listen together (control metadata only — audio is P2P) ----

  socket.on('music:state', (raw: unknown) => {
    if (!currentRoom) return
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
      if (action === 'stop') {
        room.music = null
      } else if (action === 'meta') {
        room.music.playing = data.playing === true
        room.music.position = typeof data.position === 'number' ? data.position : 0
        room.music.duration = typeof data.duration === 'number' ? data.duration : room.music.duration
        room.music.title = safeString(data.title, 80) || room.music.title
      }
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
    const data = (raw ?? {}) as Record<string, unknown>
    const to = safeString(data.to, 40)
    const sdp = safeString(data.sdp, 20000)
    if (to && sdp) io.to(to).emit('rtc:offer', { from: socket.id, sdp })
  })

  socket.on('rtc:answer', (raw: unknown) => {
    const data = (raw ?? {}) as Record<string, unknown>
    const to = safeString(data.to, 40)
    const sdp = safeString(data.sdp, 20000)
    if (to && sdp) io.to(to).emit('rtc:answer', { from: socket.id, sdp })
  })

  socket.on('rtc:ice', (raw: unknown) => {
    const data = (raw ?? {}) as Record<string, unknown>
    const to = safeString(data.to, 40)
    if (to) socket.to(to).emit('rtc:ice', { from: socket.id, candidate: data.candidate })
  })

  // ---- Chat (kilobytes of text, relayed) ----

  socket.on('chat:message', (raw: unknown) => {
    if (!currentRoom || !peer) return
    const data = (raw ?? {}) as Record<string, unknown>
    const text = safeString(data.text, 500).trim()
    if (!text) return
    const msg: ChatMessage = {
      id: Math.random().toString(36).slice(2, 11),
      from: peer.id,
      name: peer.name,
      text,
      ts: Date.now(),
    }
    io.to(currentRoom).emit('chat:message', msg)
  })

  socket.on('disconnect', () => {
    leaveRoom()
  })
  socket.on('error', () => leaveRoom())
})

const PORT = 3003
const INFO_PORT = 3004
httpServer.listen(PORT, () => {
  console.log(`Pico signaling server running on port ${PORT}`)
})
infoServer.listen(INFO_PORT, () => {
  console.log(`Pico room-info probe running on port ${INFO_PORT}`)
})

process.on('SIGTERM', () => {
  httpServer.close(() => process.exit(0))
})
process.on('SIGINT', () => {
  httpServer.close(() => process.exit(0))
})
