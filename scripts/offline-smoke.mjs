import { chromium } from '@playwright/test'
import { existsSync, writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'
const base=process.env.BASE || 'http://127.0.0.1:3111'
const brave='/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH || (existsSync(brave)?brave:undefined),headless:true,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required']})
const report={checks:[]}
try {
 const context=await browser.newContext()
 const page=await context.newPage()
 await page.goto(base,{waitUntil:'domcontentloaded'})
 await page.evaluate(async()=>{await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready})
 await page.reload({waitUntil:'domcontentloaded'})
 const first='cache-first-room',second='cache-second-room',third='cache-offline-room'
 for(const room of [first,second]) {
  await page.goto(`${base}/?room=${room}&test=1`,{waitUntil:'domcontentloaded'})
  await page.getByText(room,{exact:true}).waitFor()
 }
 const keys=await page.evaluate(async()=>{
  const names=await caches.keys();const result=[]
  for(const name of names)for(const req of await (await caches.open(name)).keys())result.push(req.url)
  return result
 })
 assert(keys.every(k=>!k.includes('room=')&&!/\/api\/|\/signal|\/info\?/.test(k)),JSON.stringify(keys))
 report.checks.push('cache keys exclude room codes and live APIs')
 await context.setOffline(true)
 await page.goto(`${base}/?room=${third}&test=1`,{waitUntil:'domcontentloaded'})
 await page.getByText(third,{exact:true}).waitFor()
 assert(await page.evaluate(async()=>{try {await fetch('/api/health');return false}catch{return true}}),'API is never served from offline cache')
 report.checks.push('offline shell preserves current invite URL and APIs remain network-only')
 await context.setOffline(false)
 const worker=context.serviceWorkers()[0]
 await worker.evaluate(()=>{Cache.prototype.put=async()=>{throw new DOMException('Full','QuotaExceededError')}})
 const response=await page.reload({waitUntil:'domcontentloaded'})
 assert.equal(response.status(),200)
 await page.getByRole('button',{name:'Join call',exact:true}).waitFor()
 report.checks.push('quota failure preserves working network navigation')
 await worker.evaluate(()=>{Object.defineProperty(caches,'open',{value:async()=>{throw new DOMException('Blocked','SecurityError')}})})
 const online=await page.reload({waitUntil:'domcontentloaded'})
 assert.equal(online.status(),200)
 await page.getByRole('button',{name:'Join call',exact:true}).waitFor()
 report.checks.push('unavailable CacheStorage falls back to the network')
 report.passed=true
} catch(e){report.failure=String(e);process.exitCode=1;console.error(e)}
finally{await browser.close();writeFileSync('test-results/offline-smoke.json',JSON.stringify(report,null,2));console.log(report)}
