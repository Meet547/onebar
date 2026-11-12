import { createServer } from 'http'
import { Server, type Socket } from 'socket.io'

/**
 * Pico — featherweight signaling service.
 *
 * Only ever touches tiny control payloads (SDP offer/answer, ICE candidates,
 * presence state, chat text). Media NEVER flows through this server: all
 * audio/video is exchanged peer-to-peer over WebRTC, so a whole meeting costs
 * the server a few kilobytes of signaling traffic.
 */

const httpServer = createServer()
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
const CHAT_HISTORY = 50

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

const rooms = new Map<string, Map<string, Peer>>()

const getRoom = (roomId: string) => {
  let room = rooms.get(roomId)
  if (!room) {
    room = new Map()
    rooms.set(roomId, room)
  }
  return room
}

const peerList = (roomId: string): Peer[] => {
  const room = rooms.get(roomId)
  return room ? Array.from(room.values()) : []
}

const safeString = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.slice(0, max) : ''

io.on('connection', (socket: Socket) => {
  let currentRoom: string | null = null
  let peer: Peer | null = null

  const broadcastPresence = (roomId: string) => {
    io.to(roomId).emit('room:peers', { peers: peerList(roomId) })
  }

  socket.on('room:join', (raw: unknown, ack?: (r: unknown) => void) => {
    try {
      const data = (raw ?? {}) as Record<string, unknown>
      const roomId = safeString(data.roomId, 64).trim()
      const name = safeString(data.name, 24).trim() || 'Guest'
      if (!roomId) return

      const room = getRoom(roomId)
      if (room.size >= MAX_PEERS_PER_ROOM && !room.has(socket.id)) {
        ack?.({ ok: false, reason: 'Room is full (8 people max)' })
        return
      }

      // Leave previous room if switching
      if (currentRoom && currentRoom !== roomId) {
        leaveRoom()
      }

      currentRoom = roomId
      peer = { id: socket.id, name, micOn: true, camOn: true, sharing: false }
      room.set(socket.id, peer)
      socket.join(roomId)

      ack?.({ ok: true, self: peer, peers: peerList(roomId) })
      socket.to(roomId).emit('peer:joined', { peer })
      broadcastPresence(roomId)
    } catch {
      ack?.({ ok: false, reason: 'Could not join the room' })
    }
  })

  const leaveRoom = () => {
    if (!currentRoom) return
    const room = rooms.get(currentRoom)
    if (room) {
      room.delete(socket.id)
      if (room.size === 0) rooms.delete(currentRoom)
      else {
        socket.to(currentRoom).emit('peer:left', { peerId: socket.id })
        broadcastPresence(currentRoom)
      }
    }
    socket.leave(currentRoom)
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

  socket.on('disconnect', () => leaveRoom())
  socket.on('error', () => leaveRoom())
})

const PORT = 3003
httpServer.listen(PORT, () => {
  console.log(`Pico signaling server running on port ${PORT}`)
})

process.on('SIGTERM', () => {
  httpServer.close(() => process.exit(0))
})
process.on('SIGINT', () => {
  httpServer.close(() => process.exit(0))
})
