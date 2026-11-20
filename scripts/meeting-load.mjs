import { chromium } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'
const base = process.env.BASE || 'http://127.0.0.1:3111'
const count = Number(process.env.PARTICIPANTS || 10)
const canvasMode = process.env.MEDIA_MODE === 'canvas'
const seconds = Number(process.env.DURATION_SECONDS || 120)
const brave = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'
const executablePath = process.env.CHROMIUM_PATH || (existsSync(brave) ? brave : undefined)
const serverPid = Number(process.env.SERVER_PID || execFileSync('lsof', ['-t', `-iTCP:${new URL(base).port || 80}`, '-sTCP:LISTEN'], {encoding:'utf8'}).trim().split('\n')[0])
const browser = await chromium.launch({ executablePath, headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--mute-audio', '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] })
const report = { base, count, seconds, mediaMode:canvasMode?'canvas':'chromium-fake-device', started: new Date().toISOString(), errors: [], samples: [], stages: [] }
const cdp = await browser.newBrowserCDPSession()
const rootPid = (await cdp.send('SystemInfo.getProcessInfo')).processInfo.find(p=>p.type==='browser').id
const pages = []
const room = `load-${Date.now()}`
function processes() {
 const all = execFileSync('ps', ['-axo','pid=,ppid=,%cpu=,rss=,comm='], {encoding:'utf8'}).trim().split('\n').map(line => {
  const m = line.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/)
  return m && {pid:+m[1],ppid:+m[2],cpu:+m[3],rssMiB:+m[4]/1024,command:m[5]}
 }).filter(Boolean)
 const ids=new Set([rootPid]);let size=0
 while(size!==ids.size){size=ids.size;for(const p of all)if(ids.has(p.ppid))ids.add(p.pid)}
 return all.filter(p=>ids.has(p.pid)||p.pid===serverPid)
}
async function snapshot() {
 const clients = await Promise.all(pages.map(p=>p.evaluate(async()=>{
  const e=window.__pico?.engine
  if(!e) return {missing:true}
  const links=await Promise.all([...e.pcs.values()].map(async pc=>{
   const stats=[...(await pc.getStats()).values()]
   return {state:pc.connectionState, inbound:stats.filter(s=>s.type==='inbound-rtp').map(s=>({kind:s.kind,bytes:s.bytesReceived,frames:s.framesDecoded,packetsLost:s.packetsLost,jitter:s.jitter})),outbound:stats.filter(s=>s.type==='outbound-rtp').map(s=>({kind:s.kind,bytes:s.bytesSent,frames:s.framesEncoded,encodeTime:s.totalEncodeTime,limitation:s.qualityLimitationReason}))}
  }))
  return {visibility:document.visibilityState,interest:e.lastWish,cpu:e.cpu,links, videos:[...document.querySelectorAll('video')].map(v=>({width:v.videoWidth,height:v.videoHeight,paused:v.paused})),tracks:e.localStream?.getTracks().map(t=>({kind:t.kind,state:t.readyState}))}
 })))
 return {at:new Date().toISOString(),processes:processes(),clients}
}
try {
 report.baseline=processes()
 for(let i=0;i<count;i++) {
  const context=await browser.newContext({viewport:{width:1280,height:800}})
  const page=await context.newPage();pages.push(page)
  page.on('pageerror',e=>report.errors.push({client:i,type:'pageerror',message:e.message}))
  page.on('console',m=>{if(m.type()==='error')report.errors.push({client:i,type:'console',message:m.text()})})
  page.on('response',r=>{if(r.status()>=400)report.errors.push({client:i,type:'http',status:r.status(),url:r.url()})})
  await page.goto(`${base}/?room=${room}${canvasMode ? '&test=1' : ''}&debug=1`, {waitUntil: 'domcontentloaded', timeout: 60000})
  await page.getByLabel('Your name',{exact:true}).fill(`Load ${i+1}`)
  await page.getByRole('button',{name:'Join call',exact:true}).click()
  await page.getByRole('button',{name:'Leave call',exact:true}).waitFor({timeout:30000})
  console.log(`Joined ${i+1}/${count}`)
 }
 await Promise.all(pages.map(p=>p.bringToFront()))
 await Promise.all(pages.map(p=>p.waitForFunction(n=>window.__pico?.engine.pcs.size===n-1,count,{timeout:45000})))
 for(let t=0;t<seconds;t+=10) {
  await new Promise(r=>setTimeout(r,10000))
  const s=await snapshot();report.samples.push(s)
  console.log(JSON.stringify({elapsed:t+10,connected:s.clients.map(c=>c.links?.filter(l=>l.state==='connected').length),decodedVideo:s.clients.map(c=>c.links?.filter(l=>l.inbound.some(s=>s.kind==='video'&&s.frames>0)).length),cpu:s.processes.reduce((a,p)=>a+p.cpu,0),rssMiB:s.processes.reduce((a,p)=>a+p.rssMiB,0)}))
 }
 await pages[0].screenshot({path:'test-results/meeting-10.png'})
 const last=report.samples.at(-1)
 report.mediaFailures=[]
 for(const [client,c] of last.clients.entries()) {
  for(const [peer,l] of c.links.entries()) if(!l.inbound.some(s=>s.kind==='video'&&s.frames>0)) report.mediaFailures.push({client,peer})
 }
 for(const c of last.clients) {
  assert.equal(c.links.length,count-1)
  for(const l of c.links){assert.equal(l.state,'connected');assert(l.inbound.some(s=>s.kind==='video'&&s.frames>0),'video must decode');assert(l.inbound.some(s=>s.kind==='audio'&&s.bytes>0),'audio must arrive')}
 }
 if(report.samples.length > 1) {
  const first=report.samples[0]
  last.clients.forEach((c,i)=>c.links.forEach((l,j)=>{
   const before=first.clients[i].links[j].inbound.find(s=>s.kind==='video')?.frames || 0
   const after=l.inbound.find(s=>s.kind==='video')?.frames || 0
   assert(after>before,`video froze for client ${i}, peer ${j}`)
  }))
 }
 report.stages.push('all participants receiving audio and advancing decoded video')
 await pages[0].screenshot({path:'test-results/meeting-10.png'})
 const extra=await browser.newPage()
 await extra.goto(`${base}/?room=${room}${canvasMode ? '&test=1' : ''}`, {waitUntil: 'domcontentloaded'})
 await extra.getByRole('button',{name:'Join call',exact:true}).click()
 await extra.getByText(`Room is full (${count} people max)`,{exact:false}).waitFor({timeout:20000})
 await extra.close();report.stages.push('overflow participant rejected')
 await pages.at(-1).getByRole('button',{name:'Leave call',exact:true}).click()
 await pages[0].waitForFunction(n=>window.__pico.engine.pcs.size===n-2,count,{timeout:15000})
 report.stages.push('leave removes peer')
 assert.equal(report.errors.length,0,JSON.stringify(report.errors))
 report.passed=true
} catch(e) {report.failure=String(e);console.error(e);process.exitCode=1}
finally {
 await browser.close()
 mkdirSync('test-results',{recursive:true})
 writeFileSync('test-results/meeting-load.json',JSON.stringify(report,null,2))
 console.log('Report: test-results/meeting-load.json')
}
