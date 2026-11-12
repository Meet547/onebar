// Direct test of the signaling relay — over the exact path a real browser
// takes: the Caddy gateway on :81, routed by XTransformPort, polling-first
// with websocket upgrade (matching src/lib/call/config.ts + engine.ts).
// Pass --direct to test :3003 straight instead.
import { io } from 'socket.io-client'

const direct = process.argv.includes('--direct')
const url = direct ? 'http://localhost:3003' : 'http://localhost:81/?XTransformPort=3003'
console.log(`[diag] target: ${url}`)

const a = io(url, { path: '/', transports: ['polling', 'websocket'], timeout: 8000 })
const b = io(url, { path: '/', transports: ['polling', 'websocket'], timeout: 8000 })
let upgraded = 0

a.io.on('upgrade', () => { upgraded++; console.log('[diag] A upgraded to websocket') })
b.io.on('upgrade', () => { upgraded++; console.log('[diag] B upgraded to websocket') })

let aId = ''

a.on('connect', () => {
  console.log('A connected', a.id, '(transport:', a.io.engine.transport.name + ')')
  a.emit('room:join', { roomId: 'diag-room', name: 'A' }, (res: { ok: boolean; self?: { id: string }; reason?: string }) => {
    if (!res.ok) { console.log('A join FAILED:', res.reason); process.exit(1) }
    console.log('A join ack:', res.ok, res.self?.id)
    aId = res.self!.id
    a.emit('chat:message', { text: 'hello from A' })
  })
})

b.on('connect', () => {
  console.log('B connected', b.id, '(transport:', b.io.engine.transport.name + ')')
  b.emit('room:join', { roomId: 'diag-room', name: 'B' }, (res: { ok: boolean; reason?: string }) => {
    if (!res.ok) { console.log('B join FAILED:', res.reason); process.exit(1) }
    console.log('B join ack:', res.ok)
  })
})

b.on('chat:message', (m: { from: string; text: string }) => {
  console.log('B received chat:', m.from, JSON.stringify(m.text), 'from==A?', m.from === aId)
  b.emit('chat:message', { text: 'hi A, this is B' })
})

a.on('chat:message', (m: { text: string }) => {
  console.log('A received chat:', JSON.stringify(m.text))
  setTimeout(() => {
    console.log(upgraded > 0 ? '[diag] PASS (websocket upgrade happened)' : '[diag] PASS (polling only — proxy blocked ws upgrade, still works)')
    a.close()
    b.close()
    process.exit(0)
  }, 300)
})

setTimeout(() => {
  console.log('TIMEOUT — relay unreachable over the tested path')
  process.exit(1)
}, 10000)
