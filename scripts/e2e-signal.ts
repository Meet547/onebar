/** Real two-peer signaling e2e through the Next rewrite (the actual browser
 *  path: same-origin http://127.0.0.1:3111 → /signal/ → embedded relay).
 *  Verifies the full relay surface: version handshake, join/ack + presence,
 *  rtc offer/answer/ice relay, state/chat broadcast, host controls,
 *  leave + host promotion + peer:left. Exits non-zero on any failure. */
import { io, type Socket } from 'socket.io-client'

const BASE = process.env.BASE || 'http://127.0.0.1:3111'
const ROOM = `e2e-${Math.random().toString(36).slice(2, 8)}-relay`

let pass = 0
const fails: string[] = []
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`  ok  ${name}`) } else { fails.push(name); console.log(`FAIL  ${name} ${extra}`) }
}
function wait<T>(ms = 4000): Promise<T> {
  return new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('timeout')), ms); (res as (v: T) => void) = ((v: T) => { clearTimeout(t); res(v) }) })
}
function onceEvent<T = any>(sock: Socket, ev: string, ms = 4000): Promise<T> {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout waiting "${ev}"`)), ms)
    sock.once(ev, (d: T) => { clearTimeout(t); res(d) })
  })
}
const join = (roomId: string, name: string): Promise<{ ok: boolean; reason?: string; peers?: any[]; hostId?: string }> =>
  new Promise((res) => { /* ack-based join */ })

async function connect(name: string): Promise<Socket> {
  return new Promise((res, rej) => {
    const s = io(BASE, {
      path: '/signal/',
      transports: ['polling', 'websocket'],
      extraHeaders: { Origin: BASE }, // the browser is same-origin through the rewrite
      reconnection: false,
      timeout: 6000,
    })
    s.on('connect', () => res(s))
    s.on('connect_error', (e) => rej(new Error(`${name} connect_error: ${e.message}`)))
  })
}

async function main() {
  const A = await connect('A')
  const B = await connect('B')
  console.log(`  ids  A=${A.id} B=${B.id} tA=${A.io.engine.transport} tB=${B.io.engine.transport}`)
  ok('two clients connected through /signal/ rewrite', A.connected && B.connected)

  // version handshake both sides
  const health = await (await fetch(`${BASE}/api/health`)).json() as { version: string }
  const vcA = await new Promise<any>((res) => A.once('version:current', res).emit('version:hello', { client: health.version }))
  ok('version:hello → version:current (clientMatches)', typeof vcA?.server === 'string' && vcA.clientMatches === true, JSON.stringify(vcA))

  // A joins first → becomes host
  const ackA = await new Promise<any>((res) => A.emit('room:join', { roomId: ROOM, name: 'Alice' }, res))
  ok('A join ack ok:true, host=self', ackA?.ok === true && ackA?.hostId === A.id && ackA?.peers?.length === 1, JSON.stringify(ackA))

  // B joins → A sees peer:joined, both see room:peers with 2 peers
  const pjP = onceEvent(A, 'peer:joined')
  const ackB = await new Promise<any>((res) => B.emit('room:join', { roomId: ROOM, name: 'Bob' }, res))
  ok('B join ack ok:true, peers=2', ackB?.ok === true && ackB?.peers?.length === 2, JSON.stringify(ackB))
  const pj = await pjP
  ok('A received peer:joined(B)', pj?.peer?.id === B.id && pj?.peer?.name === 'Bob', JSON.stringify(pj))

  // rtc:offer A → B
  const sdpOffer = 'v=0\r\no=- e2e-offer 1 IN IP4 127.0.0.1\r\ns=-\r\n'
  const offP = onceEvent(B, 'rtc:offer')
  A.emit('rtc:offer', { to: B.id, sdp: sdpOffer })
  const off = await offP
  ok('rtc:offer relayed A→B with from=A', off?.from === A.id && off?.sdp === sdpOffer)

  // rtc:answer B → A
  const sdpAnswer = 'v=0\r\no=- e2e-answer 1 IN IP4 127.0.0.1\r\ns=-\r\n'
  const ansP = onceEvent(A, 'rtc:answer')
  B.emit('rtc:answer', { to: A.id, sdp: sdpAnswer })
  const ans = await ansP
  ok('rtc:answer relayed B→A with from=B', ans?.from === B.id && ans?.sdp === sdpAnswer)

  // rtc:ice both directions
  const candB = { candidate: 'candidate:1 1 udp 2130706431 127.0.0.1 50000 typ host', sdpMid: '0' }
  const iceP = onceEvent(B, 'rtc:ice')
  A.emit('rtc:ice', { to: B.id, candidate: candB })
  const ice = await iceP
  ok('rtc:ice relayed A→B (candidate intact)', ice?.from === A.id && ice?.candidate?.candidate === candB.candidate)

  // state broadcast
  const stP = onceEvent(B, 'peer:state')
  A.emit('state:update', { micOn: false, camOn: true, sharing: false })
  const st = await stP
  ok('state:update broadcast to room (micOn=false)', st?.peerId === A.id && st?.micOn === false)

  // chat relay
  const chP = onceEvent(B, 'chat:message')
  const sentP = onceEvent(A, 'chat:sent')
  A.emit('chat:message', { text: 'hello relay' })
  const ch = await chP
  ok('chat:message relayed', ch?.text === 'hello relay' && (ch?.peerId === A.id || ch?.from === A.id), JSON.stringify(ch))
  const sent = await sentP
  ok('chat:sent acknowledged', typeof sent?.id === 'string' && sent.id === ch?.id)
  const typingP = onceEvent(B, 'chat:typing')
  A.emit('chat:typing', { typing: true })
  const typing = await typingP
  ok('chat:typing relayed with peer identity', typing?.peerId === A.id && typing?.name === 'Alice' && typing?.typing === true)
  const stoppedTypingP = onceEvent(B, 'chat:typing')
  A.emit('chat:typing', { typing: false })
  const stoppedTyping = await stoppedTypingP
  ok('chat:typing stopped', stoppedTyping?.peerId === A.id && stoppedTyping?.typing === false)

  // host controls: A mutes B, locks room
  const fmP = onceEvent(B, 'host:force-mute')
  A.emit('host:mute', { target: B.id })
  await fmP
  ok('host:mute → B got host:force-mute', true)

  const lkP = onceEvent(B, 'room:locked')
  A.emit('host:lock', { locked: true })
  const lk = await lkP
  ok('host:lock broadcast (locked=true)', lk?.locked === true)

  // locked room rejects a third peer
  const C = await connect('C')
  const ackC = await new Promise<any>((res) => C.emit('room:join', { roomId: ROOM, name: 'Eve' }, res))
  ok('locked room rejects C', ackC?.ok === false, JSON.stringify(ackC))
  C.disconnect()

  // B leaves → A sees peer:left and room:peers size 1
  // (capture the id BEFORE disconnect: socket.io-client clears socket.id)
  const bid = B.id
  const plP = onceEvent(A, 'peer:left')
  B.disconnect()
  const pl = await plP
  ok(`A received peer:left(B) (B.id=${bid})`, pl?.peerId === bid, JSON.stringify(pl))

  A.disconnect()
  console.log(`\n== ${pass} passed, ${fails.length} failed ==`)
  process.exit(fails.length === 0 ? 0 : 1)
}

main().catch((e) => { console.error('E2E ERROR:', e.message); process.exit(1) })
