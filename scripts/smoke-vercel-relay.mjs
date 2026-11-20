#!/usr/bin/env node

const base = new URL(process.argv[2] || process.env.SITE_URL || 'https://onebar-teal.vercel.app')
const room = `smoke-${crypto.randomUUID().slice(0, 12)}`
const firstRejoinToken = `smoke-token-${crypto.randomUUID()}`
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
    if (process.env.DEBUG_RELAY) console.log('recv', packet.event, packet.ackId ?? '')
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
    emit(event, data, acknowledge = false) {
      if (!acknowledge) {
        if (process.env.DEBUG_RELAY) console.log('send', event)
        ws.send(JSON.stringify({ event, data }))
        return Promise.resolve(undefined)
      }
      const ackId = nextAck++
      if (process.env.DEBUG_RELAY) console.log('send', event, ackId)
      const ack = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { acks.delete(ackId); reject(new Error(`Timed out waiting for ${event} ack`)) }, 10_000)
        acks.set(ackId, (value) => { clearTimeout(timer); resolve(value) })
      })
      ws.send(JSON.stringify({ event, data, ackId }))
      return ack
    },
  }
}

let first = client()
const second = client()
try {
  const firstConnected = first.once('connect')
  const secondConnected = second.once('connect')
  await Promise.all([firstConnected, secondConnected])

  const firstJoin = await first.emit('room:join', { roomId: room, name: 'Smoke Alice', rejoinToken: firstRejoinToken }, true)
  if (!firstJoin.ok) throw new Error(`first join failed: ${firstJoin.reason}`)

  const peerJoined = first.once('peer:joined')
  const secondJoin = await second.emit('room:join', { roomId: room, name: 'Smoke Bob' }, true)
  if (!secondJoin.ok || secondJoin.peers?.length !== 2) throw new Error('second join did not see both room peers')
  const joined = await peerJoined
  if (joined.peer.id !== secondJoin.self.id) throw new Error('peer join event did not reach the other client')

  // A brief signaling transport outage must preserve membership and let the
  // same participant resume without telling the other caller they left.
  const reconnecting = second.once('peer:reconnecting')
  first.ws.close()
  const dropped = await reconnecting
  if (dropped.peer?.id !== firstJoin.self.id) throw new Error('disconnect did not enter reconnect grace')
  const duringReconnect = await fetch(new URL(`/api/room-info?room=${encodeURIComponent(room)}`, httpBase), { cache: 'no-store' }).then((r) => r.json())
  if (duringReconnect.count !== 2) throw new Error(`transient disconnect removed room presence: ${JSON.stringify(duringReconnect)}`)
  first = client()
  const firstReconnected = first.once('connect')
  await firstReconnected
  const peerReconnected = second.once('peer:reconnected')
  const resumed = await first.emit('room:join', { roomId: room, name: 'Smoke Alice', rejoinToken: firstRejoinToken }, true)
  if (!resumed.ok) throw new Error(`rejoin failed: ${resumed.reason}`)
  const resumeEvent = await peerReconnected
  if (resumeEvent.oldPeerId !== firstJoin.self.id || resumeEvent.peer.id !== resumed.self.id) throw new Error('rejoin did not replace the stale peer cleanly')

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
  if (relayedOffer.from !== resumed.self.id || relayedOffer.sdp !== 'smoke-sdp') throw new Error('direct RTC signaling was not relayed')

  console.log(`PASS: websocket joins, reconnect grace/rejoin, room presence, chat, room info, and RTC relay (${base.origin})`)
} finally {
  await Promise.allSettled([first.emit('room:leave', undefined, true), second.emit('room:leave', undefined, true)])
  first.ws.close()
  second.ws.close()
}

const cleanupDeadline = Date.now() + 10_000
let cleanedUp = false
while (Date.now() < cleanupDeadline) {
  const response = await fetch(new URL(`/api/room-info?room=${encodeURIComponent(room)}`, httpBase), { cache: 'no-store' })
  const info = await response.json()
  if (response.ok && info.count === 0) { cleanedUp = true; break }
  await new Promise((resolve) => setTimeout(resolve, 300))
}
if (!cleanedUp) throw new Error('room membership was not cleared after both clients disconnected')
console.log('PASS: room membership is cleaned up after disconnect')
