// Direct test of the signaling relay: two clients join a room, one chats.
import { io } from 'socket.io-client'

const url = 'http://localhost:3003'

const a = io(url, { path: '/', transports: ['websocket'] })
const b = io(url, { path: '/', transports: ['websocket'] })

let aId = ''

a.on('connect', () => {
  console.log('A connected', a.id)
  a.emit('room:join', { roomId: 'diag-room', name: 'A' }, (res: { ok: boolean; self?: { id: string } }) => {
    console.log('A join ack:', res.ok, res.self?.id)
    aId = res.self!.id
    a.emit('chat:message', { text: 'hello from A' })
  })
})

b.on('connect', () => {
  b.emit('room:join', { roomId: 'diag-room', name: 'B' }, (res: { ok: boolean }) => {
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
    a.close()
    b.close()
    process.exit(0)
  }, 300)
})

setTimeout(() => {
  console.log('TIMEOUT — relay broken')
  process.exit(1)
}, 6000)
