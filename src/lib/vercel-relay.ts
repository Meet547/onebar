import { createClient, type RedisClientType } from 'redis'
import type { WebSocket } from '@vercel/functions'
import { resolvePicoVersion } from './server-version'
import { versionMismatch } from './version'

type Peer = { id: string; name: string; micOn: boolean; camOn: boolean; sharing: boolean }
type Music = { peerId: string; title: string; streamId: string; playing: boolean; position: number; duration: number }
type Room = {
  peers: Record<string, Peer>
  hostId: string | null
  locked: boolean
  passwordHash: string
  music: Music | null
  recentTokens: Record<string, number>
}
type Client = { ws: WebSocket; id: string; roomId: string | null; data: { rejoinToken?: string; kicked?: boolean } }
type WireEvent = { roomId?: string; targetId?: string; exceptId?: string; event: string; data?: unknown }

const ROOM_TTL_SECONDS = 180
const MAX_PEERS = 10
const REJOIN_GRACE_MS = 120_000
const VERSION = resolvePicoVersion()
const clients = new Map<string, Client>()
const limits = new Map<string, { count: number; until: number }>()
const joinFails = new Map<string, { count: number; blockedUntil: number }>()

const blankRoom = (): Room => ({ peers: {}, hostId: null, locked: false, passwordHash: '', music: null, recentTokens: {} })
const safe = (value: unknown, max: number) => typeof value === 'string' ? value.slice(0, max) : ''
const listPeers = (room: Room) => Object.values(room.peers)

function allowed(key: string, max: number, windowMs: number): boolean {
  const now = Date.now()
  const value = limits.get(key)
  if (!value || now >= value.until) { limits.set(key, { count: 1, until: now + windowMs }); return true }
  if (value.count >= max) return false
  value.count++
  return true
}

let redisPromise: Promise<{ commands: RedisClientType; subscriber: RedisClientType }> | undefined
function redisClients() {
  if (!process.env.REDIS_URL) throw new Error('REDIS_URL is not configured')
  if (!redisPromise) {
    redisPromise = (async () => {
      const commands = createClient({ url: process.env.REDIS_URL })
      const subscriber = commands.duplicate()
      commands.on('error', (error) => console.error('[vercel-relay] redis command error', error.message))
      subscriber.on('error', (error) => console.error('[vercel-relay] redis subscriber error', error.message))
      await Promise.all([commands.connect(), subscriber.connect()])
      await subscriber.subscribe('pico:relay:events', (message) => {
        try {
          const event = JSON.parse(message) as WireEvent
          for (const client of clients.values()) {
            if (event.targetId ? client.id === event.targetId : event.roomId && client.roomId === event.roomId && client.id !== event.exceptId) {
              send(client, event.event, event.data)
            }
          }
        } catch (error) {
          console.error('[vercel-relay] malformed redis event', error)
        }
      })
      return { commands, subscriber }
    })()
  }
  return redisPromise
}

async function publish(event: WireEvent) {
  const { commands } = await redisClients()
  await commands.publish('pico:relay:events', JSON.stringify(event))
}

async function mutateRoom<T>(roomId: string, mutate: (room: Room) => T | Promise<T>, removeWhenEmpty = false): Promise<T> {
  const { commands } = await redisClients()
  const key = `pico:relay:room:${roomId}`
  const lock = `${key}:lock`
  const token = crypto.randomUUID()
  const deadline = Date.now() + 8_000
  while (!(await commands.set(lock, token, { NX: true, PX: 10_000 }))) {
    if (Date.now() > deadline) throw new Error('room state busy')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  try {
    const value = await commands.get(key)
    const room = value ? JSON.parse(value) as Room : blankRoom()
    const result = await mutate(room)
    if (removeWhenEmpty && Object.keys(room.peers).length === 0) await commands.del(key)
    else await commands.set(key, JSON.stringify(room), { EX: ROOM_TTL_SECONDS })
    return result
  } finally {
    await commands.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      { keys: [lock], arguments: [token] },
    )
  }
}

async function readRoom(roomId: string): Promise<Room | null> {
  const { commands } = await redisClients()
  const value = await commands.get(`pico:relay:room:${roomId}`)
  return value ? JSON.parse(value) as Room : null
}

function send(client: Client, event: string, data?: unknown, ackId?: number) {
  if (client.ws.readyState !== 1) return
  client.ws.send(JSON.stringify({ event, data, ...(ackId === undefined ? {} : { ackId }) }))
}

function clientIp(request: Request): string {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
}

async function leave(client: Client) {
  const roomId = client.roomId
  if (!roomId) return
  const wasKicked = client.data.kicked === true
  client.data.kicked = false
  client.roomId = null
  if (wasKicked) return
  const result = await mutateRoom(roomId, (room) => {
    delete room.peers[client.id]
    if (client.data.rejoinToken) room.recentTokens[client.data.rejoinToken] = Date.now()
    for (const [token, time] of Object.entries(room.recentTokens)) if (Date.now() - time > REJOIN_GRACE_MS) delete room.recentTokens[token]
    if (room.music?.peerId === client.id) room.music = null
    if (room.hostId === client.id) room.hostId = Object.keys(room.peers)[0] ?? null
    return { peers: listPeers(room), hostId: room.hostId, musicStopped: !room.music }
  }, true)
  await publish({ roomId, event: 'peer:left', data: { peerId: client.id } })
  if (result.musicStopped) await publish({ roomId, event: 'music:state', data: { action: 'stop', peerId: client.id } })
  if (result.hostId) await publish({ roomId, event: 'host:changed', data: { hostId: result.hostId } })
  await publish({ roomId, event: 'room:peers', data: { peers: result.peers, hostId: result.hostId } })
}

async function onEvent(client: Client, message: { event?: unknown; data?: unknown; ackId?: unknown }, ip: string) {
  const event = safe(message.event, 40)
  const raw = message.data
  const data = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const ackId = typeof message.ackId === 'number' ? message.ackId : undefined
  const ack = (value: unknown) => { if (ackId !== undefined) send(client, 'ack', value, ackId) }

  if (event === 'version:hello') {
    const version = safe(data.client, 80) || null
    send(client, 'version:current', { server: VERSION, clientMatches: !versionMismatch(version, VERSION) })
    return
  }

  if (event === 'room:join') {
    const roomId = safe(data.roomId, 64).trim()
    const name = safe(data.name, 24).trim() || 'Guest'
    const passwordHash = safe(data.passwordHash, 64)
    const rejoinToken = safe(data.rejoinToken, 64)
    if (!allowed(`${client.id}:join`, 20, 10_000)) { ack({ ok: false, reason: 'Too many join attempts — try again shortly' }); return }
    if (!/^[a-z0-9-]{4,64}$/.test(roomId)) { ack({ ok: false, reason: 'Invalid room code' }); return }
    const failures = joinFails.get(ip)
    if (failures && Date.now() < failures.blockedUntil) { ack({ ok: false, reason: 'Too many attempts — wait a minute and try again' }); return }
    if (client.roomId && client.roomId !== roomId) await leave(client)
    const outcome = await mutateRoom(roomId, (room) => {
      const fresh = Object.keys(room.peers).length === 0 && !room.passwordHash
      if (fresh && passwordHash) room.passwordHash = passwordHash
      if (room.passwordHash && passwordHash !== room.passwordHash) return { ok: false as const, reason: 'Wrong passcode' }
      const recent = rejoinToken && room.recentTokens[rejoinToken] && Date.now() - room.recentTokens[rejoinToken] < REJOIN_GRACE_MS
      if (room.locked && !room.peers[client.id] && !recent) return { ok: false as const, reason: 'The host locked this call' }
      if (Object.keys(room.peers).length >= MAX_PEERS && !room.peers[client.id]) return { ok: false as const, reason: `Room is full (${MAX_PEERS} people max)` }
      const peer: Peer = { id: client.id, name, micOn: true, camOn: true, sharing: false }
      room.peers[client.id] = peer
      if (!room.hostId) room.hostId = client.id
      if (rejoinToken) delete room.recentTokens[rejoinToken]
      return { ok: true as const, peer, peers: listPeers(room), hostId: room.hostId, locked: room.locked, hasPassword: !!room.passwordHash, music: room.music }
    })
    if (!outcome.ok) {
      if (outcome.reason === 'Wrong passcode') {
        const rec = joinFails.get(ip) ?? { count: 0, blockedUntil: 0 }
        rec.count++
        if (rec.count >= 10) { rec.count = 0; rec.blockedUntil = Date.now() + 60_000 }
        joinFails.set(ip, rec)
      }
      ack(outcome); return
    }
    client.roomId = roomId
    client.data.rejoinToken = rejoinToken
    ack({ ok: true, self: outcome.peer, peers: outcome.peers, hostId: outcome.hostId, locked: outcome.locked, hasPassword: outcome.hasPassword, music: outcome.music })
    await publish({ roomId, exceptId: client.id, event: 'peer:joined', data: { peer: outcome.peer } })
    await publish({ roomId, event: 'room:peers', data: { peers: outcome.peers, hostId: outcome.hostId } })
    return
  }

  const roomId = client.roomId
  if (event === 'room:leave') { await leave(client); ack({ ok: true }); return }
  if (!roomId) return
  if (event === 'state:update') {
    if (!allowed(`${client.id}:state`, 60, 10_000)) return
    const peer = await mutateRoom(roomId, (room) => {
      const p = room.peers[client.id]
      if (!p) return null
      if (typeof data.micOn === 'boolean') p.micOn = data.micOn
      if (typeof data.camOn === 'boolean') p.camOn = data.camOn
      if (typeof data.sharing === 'boolean') p.sharing = data.sharing
      return p
    })
    if (peer) await publish({ roomId, exceptId: client.id, event: 'peer:state', data: { peerId: client.id, micOn: peer.micOn, camOn: peer.camOn, sharing: peer.sharing } })
    return
  }

  if (event.startsWith('host:')) {
    if (!allowed(`${client.id}:host`, 30, 10_000)) return
    const result = await mutateRoom(roomId, (room) => {
      if (room.hostId !== client.id || !room.peers[client.id]) return null
      if (event === 'host:lock') {
        room.locked = data.locked === true
        return { kind: 'lock' as const, locked: room.locked }
      }
      const target = safe(data.target, 40)
      if (!target || target === client.id || !room.peers[target]) return null
      if (event === 'host:mute') return { kind: 'mute' as const, target }
      if (event === 'host:mute-all') return { kind: 'mute-all' as const, peers: Object.keys(room.peers).filter((id) => id !== client.id) }
      if (event === 'host:remove') {
        delete room.peers[target]
        if (room.music?.peerId === target) room.music = null
        return { kind: 'remove' as const, target, peers: listPeers(room), hostId: room.hostId }
      }
      return null
    })
    if (!result) return
    if (result.kind === 'lock') await publish({ roomId, event: 'room:locked', data: { locked: result.locked } })
    if (result.kind === 'mute') await publish({ targetId: result.target, event: 'host:force-mute' })
    if (result.kind === 'mute-all') await Promise.all(result.peers.map((id) => publish({ targetId: id, event: 'host:force-mute' })))
    if (result.kind === 'remove') {
      const target = clients.get(result.target)
      if (target) { target.data.kicked = true; target.roomId = null; send(target, 'room:kicked') }
      await publish({ roomId, exceptId: result.target, event: 'peer:left', data: { peerId: result.target } })
      await publish({ roomId, event: 'room:peers', data: { peers: result.peers, hostId: result.hostId } })
    }
    return
  }

  if (event === 'music:state') {
    if (!allowed(`${client.id}:music`, 40, 10_000)) return
    const result = await mutateRoom(roomId, (room) => {
      if (!room.peers[client.id]) return null
      const action = safe(data.action, 8)
      if (action === 'start') {
        if (room.music && room.music.peerId !== client.id) return { busy: true as const }
        room.music = { peerId: client.id, title: safe(data.title, 80) || 'Music', streamId: safe(data.streamId, 64), playing: data.playing === true, position: typeof data.position === 'number' ? data.position : 0, duration: typeof data.duration === 'number' ? data.duration : 0 }
      } else if (room.music?.peerId === client.id) {
        if (action === 'stop') room.music = null
        else if (action === 'meta') room.music = { ...room.music, playing: data.playing === true, position: typeof data.position === 'number' ? data.position : 0, duration: typeof data.duration === 'number' ? data.duration : room.music.duration, title: safe(data.title, 80) || room.music.title }
      } else return null
      return { busy: false as const, action, peerId: client.id, streamId: safe(data.streamId, 64), title: safe(data.title, 80), playing: data.playing === true, position: typeof data.position === 'number' ? data.position : 0, duration: typeof data.duration === 'number' ? data.duration : 0 }
    })
    if (result?.busy) send(client, 'music:busy')
    else if (result) await publish({ roomId, exceptId: client.id, event: 'music:state', data: result })
    return
  }

  if (event === 'rtc:offer' || event === 'rtc:answer' || event === 'rtc:ice') {
    if (!allowed(`${client.id}:rtc`, 240, 10_000)) return
    const target = safe(data.to, 40)
    const valid = await mutateRoom(roomId, (room) => !!room.peers[client.id] && !!room.peers[target] && target !== client.id)
    if (!valid) return
    const payload = event === 'rtc:ice' ? { from: client.id, candidate: data.candidate } : { from: client.id, sdp: safe(data.sdp, 20_000) }
    await publish({ targetId: target, event, data: payload })
    return
  }

  if (event === 'video:wish') {
    if (!allowed(`${client.id}:chat`, 25, 10_000)) return
    const joined = await mutateRoom(roomId, (room) => !!room.peers[client.id])
    if (!joined) return
    const targets = (Array.isArray(data.targets) ? data.targets : []).map((id) => safe(id, 40)).filter(Boolean).slice(0, 16)
    await publish({ roomId, exceptId: client.id, event, data: { from: client.id, targets } })
    return
  }

  if (event === 'chat:message') {
    if (!allowed(`${client.id}:chat`, 25, 10_000)) return
    const text = safe(data.text, 500).trim()
    if (!text) return
    const sender = await mutateRoom(roomId, (room) => room.peers[client.id] ?? null)
    if (!sender) return
    const messageId = Math.random().toString(36).slice(2, 11)
    let replyTo: { id: string; name: string; text: string } | undefined
    const quote = data.replyTo as Record<string, unknown> | undefined
    if (quote && safe(quote.id, 16) && safe(quote.text, 140).trim()) replyTo = { id: safe(quote.id, 16), name: safe(quote.name, 24) || 'Guest', text: safe(quote.text, 140).trim() }
    await publish({ roomId, event, data: { id: messageId, from: client.id, name: sender.name, text, ts: Date.now(), ...(replyTo ? { replyTo } : {}) } })
    send(client, 'chat:sent', { id: messageId })
    return
  }

  if (event === 'chat:typing') {
    if (!allowed(`${client.id}:chat-typing`, 8, 5_000)) return
    const sender = await mutateRoom(roomId, (room) => room.peers[client.id] ?? null)
    if (sender) await publish({ roomId, exceptId: client.id, event, data: { peerId: client.id, name: sender.name, typing: data.typing === true } })
  }
}

export function handleVercelSocket(ws: WebSocket, request: Request) {
  const client: Client = { ws, id: crypto.randomUUID(), roomId: null, data: {} }
  const ip = clientIp(request)
  clients.set(client.id, client)
  void redisClients().catch((error) => {
    console.error('[vercel-relay] Redis connection failed', error instanceof Error ? error.message : error)
    ws.close(1011, 'Signaling storage unavailable')
  })
  send(client, 'connect', { id: client.id })
  ws.on('message', (raw) => {
    const text = Array.isArray(raw) ? Buffer.concat(raw).toString() : Buffer.isBuffer(raw) ? raw.toString() : Buffer.from(raw).toString()
    if (text.length > 100_000) { ws.close(1009, 'Message too large'); return }
    void (async () => {
      try {
        const message = JSON.parse(text)
        await onEvent(client, message, ip)
      } catch (error) {
        console.error('[vercel-relay] event failed', error instanceof Error ? error.message : error)
      }
    })()
  })
  const heartbeat = setInterval(() => {
    if (client.roomId) {
      void redisClients().then(({ commands }) => commands.expire(`pico:relay:room:${client.roomId}`, ROOM_TTL_SECONDS))
        .catch((error) => console.error('[vercel-relay] room lease refresh failed', error instanceof Error ? error.message : error))
    }
  }, 60_000)
  heartbeat.unref?.()
  const close = () => {
    clearInterval(heartbeat)
    clients.delete(client.id)
    for (const key of limits.keys()) if (key.startsWith(`${client.id}:`)) limits.delete(key)
    void leave(client).catch((error) => console.error('[vercel-relay] disconnect cleanup failed', error))
  }
  ws.on('close', close)
  ws.on('error', close)
}

export async function roomInfo(roomId: string) {
  if (!roomId || roomId.length > 64) return { exists: false, locked: false, hasPassword: false, count: 0 }
  const room = await readRoom(roomId)
  return { exists: !!room, locked: !!room?.locked, hasPassword: !!room?.passwordHash, count: Object.keys(room?.peers ?? {}).length }
}
