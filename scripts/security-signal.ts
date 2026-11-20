import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { io, type Socket } from 'socket.io-client'
const base = process.env.BASE || 'http://127.0.0.1:3111'
const path = process.env.SIGNAL_PATH || '/signal/'
const sockets: Socket[] = []
const room = `security-${randomUUID()}`
let passed = 0
const ok = (name: string, condition: unknown) => { assert(condition, name); passed++; console.log(`ok ${name}`) }
const delay = (ms: number) => new Promise(r => setTimeout(r, ms))
async function connect() {
  const s=io(base,{path,transports:['polling'],reconnection:false,timeout:4000,extraHeaders:{Origin:base}})
  sockets.push(s)
  await new Promise<void>((resolve,reject)=>{s.once('connect',()=>resolve());s.once('connect_error',reject)})
  return s
}
const join = (s: Socket, payload: unknown) => s.timeout(4000).emitWithAck('room:join',payload)
try {
 const a=await connect(), b=await connect(), c=await connect(), u=await connect()
 const token=randomUUID()
 ok('host joins', (await join(a,{roomId:room,name:'Host'})).ok)
 ok('member joins with private reconnect token',(await join(b,{roomId:room,name:'Member',rejoinToken:token})).ok)
 ok('other room joins',(await join(c,{roomId:`other-${room}`,name:'Outsider'})).ok)
 ok('malformed join receives rejection',(await join(u,null)).ok===false)
 const injected: string[]=[]
 for(const event of ['rtc:offer','rtc:answer','rtc:ice']) b.on(event,()=>injected.push(event))
 for(const s of [c,u]) {
  s.emit('rtc:offer',{to:b.id,sdp:'malicious'})
  s.emit('rtc:answer',{to:b.id,sdp:'malicious'})
  s.emit('rtc:ice',{to:b.id,candidate:{candidate:'malicious'}})
 }
 await delay(500)
 ok('cross-room and unjoined signaling blocked',injected.length===0)
 const memberId=b.id
 const reconnecting=new Promise<any>(resolve=>a.once('peer:reconnecting',resolve))
 b.disconnect();assert.equal((await reconnecting).peer.id,memberId,'unexpected socket close should preserve peer during reconnect grace')
 const locked=new Promise<void>(resolve=>a.once('room:locked',()=>resolve()))
 a.emit('host:lock',{locked:true});await locked
 const impersonator=await connect()
 ok('display-name impersonation cannot bypass lock',(await join(impersonator,{roomId:room,name:'Member'})).ok===false)
 const returning=await connect()
 ok('private reconnect token restores locked-room access',(await join(returning,{roomId:room,name:'Member',rejoinToken:token})).ok)
 const kicked=new Promise<void>(resolve=>returning.once('room:kicked',()=>resolve()))
 a.emit('host:remove',{target:returning.id});await kicked
 returning.emit('rtc:offer',{to:a.id,sdp:'malicious'})
 ok('kicked token cannot regain locked-room access',(await join(returning,{roomId:room,name:'Member',rejoinToken:token})).ok===false)
 console.log(`${passed} signaling security assertions passed`)
} finally {for(const s of sockets)s.disconnect()}
