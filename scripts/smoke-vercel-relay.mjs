#!/usr/bin/env node

const base = new URL(process.argv[2] || process.env.SITE_URL || 'https://onebar-teal.vercel.app')
const room = `smoke-${crypto.randomUUID().slice(0, 12)}`
const httpBase = new URL(base)
httpBase.protocol = base.protocol === 'https:' ? 'https:' : 'http:'

function client() {
  const url = new URL('/api/signal', base)
  url.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:'
  const ws = new WebSocket(url)
  const listeners = new Map()
  const acks = new Map()
  let nextAck = 1
  ws.addEventListener('message', (event) => {
    const packet = JSON.parse(String(event.data))
    if (packet.event === 'ack') {
      const resolve = acks.get(packet.ackId)
      acks.delete(packet.ackId)
      resolve?.(packet.data)
      return
    }
    for (const listener of listeners.get(packet.event) ?? []) listener(packet.data)
  })
  return {
    ws,
    on(event, listener) {
      const entries = listeners.get(event) ?? new Set()
      entries.add(listener)
      listeners.set(event, entries)
    },
    once(event, timeoutMs = 10_000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), timeoutMs)
        const listener = (data) => {
          clearTimeout(timer)
          listeners.get(event)?.delete(listener)
          resolve(data)
        }
        this.on(event, listener)
      })
    },
    emit(event, data) {
      const ackId = nextAck++
      const ack = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { acks.delete(ackId); reject(new Error(`Timed out waiting for ${event} ack`)) }, 10_000)
        acks.set(ackId, (value) => { clearTimeout(timer); resolve(value) })
      })
      ws.send(JSON.stringify({ event, data, ackId }))
      return ack
    },
  }
}

const first = client()
const second = client()
try {
  const firstConnected = first.once('connect')
  const secondConnected = second.once('connect')
  await Promise.all([firstConnected, secondConnected])

  const firstJoin = await first.emit('room:join', { roomId: room, name: 'Smoke Alice' })
  if (!firstJoin.ok) throw new Error(`first join failed: ${firstJoin.reason}`)

  const peerJoined = second.once('peer:joined')
  const secondJoin = await second.emit('room:join', { roomId: room, name: 'Smoke Bob' })
  if (!secondJoin.ok || secondJoin.peers?.length !== 2) throw new Error('second join did not see both room peers')
  const joined = await peerJoined
  if (joined.peer.id !== secondJoin.self.id) throw new Error('peer join event did not reach the other client')

  const chat = second.once('chat:message')
  await first.emit('chat:message', { text: 'cross-client signaling smoke' })
  const message = await chat
  if (message.text !== 'cross-client signaling smoke') throw new Error('chat event payload was not relayed')

  const infoResponse = await fetch(new URL(`/api/room-info?room=${encodeURIComponent(room)}`, httpBase), { cache: 'no-store' })
  const info = await infoResponse.json()
  if (!infoResponse.ok || info.count !== 2) throw new Error(`room info is wrong: ${JSON.stringify(info)}`)

  const offer = second.once('rtc:offer')
  await first.emit('rtc:offer', { to: secondJoin.self.id, sdp: 'smoke-sdp' })
  const relayedOffer = await offer
  if (relayedOffer.from !== firstJoin.self.id || relayedOffer.sdp !== 'smoke-sdp') throw new Error('direct RTC signaling was not relayed')

  console.log(`PASS: websocket joins, room presence, chat, room info, and RTC relay (${base.origin})`)
} finally {
  first.ws.close()
  second.ws.close()
}
