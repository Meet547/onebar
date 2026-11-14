/*
 * Offline unit tests for the pure adaptation logic (src/lib/call/adaptive.ts).
 *
 * No browser, no WebRTC, no deps: the module is compiled to CommonJS and the
 * traces below are replayed through classifyLink / splitBudget /
 * cpuLadderTick / budgetChanged. Run via scripts/run-adaptive-tests.sh.
 *
 * What the traces check:
 *   1. 3G profile classifies sanely (level 2, not 0).
 *   2. BWE warmup: a low startup estimate never causes an early downgrade.
 *   3. Sudden loss spike: fast drop, slow recovery, right direction.
 *   4. Flapping: oscillation across the BWE threshold is smoothed into a
 *      stable verdict (raw per-sample decisions would flap 0↔2).
 *   5. App-limited vs link-limited: a capped sender's echo estimate must not
 *      re-affirm the cap; a genuinely weak link still downgrades.
 *   6. Probe-up: closed-loop sim — without probing a recovered link stays
 *      locked low forever; with probing it climbs back within ~15 polls.
 *   7. CPU ladder: escalation every 2 bad polls, one step per 10 clean,
 *      no jumps, resets when video send stops.
 *   8. Budget split: audio reserved first, weak peer scaled, screen exempt,
 *      probe lifts caps.
 *   9. Sender-rewrite hysteresis: no per-poll ping-pong.
 */
const assert = require('node:assert')
const {
  classifyLink,
  splitBudget,
  cpuLadderTick,
  budgetChanged,
  pushSmooth,
  avgSmooth,
  BWE_WARMUP_POLLS,
  PROBE_EVERY_POLLS,
  UPLOAD_BUDGET_SHARE,
} = require(process.env.ADAPTIVE_CJS)

let pass = 0
let fail = 0
function ok(name, cond, extra) {
  if (cond) {
    pass++
    console.log(`  ok  ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}${extra !== undefined ? ` — got ${JSON.stringify(extra)}` : ''}`)
  }
}
function eq(name, got, want) {
  ok(name, got === want, { got, want })
}

/* ---- 1. 3G profile ---- */
{
  // 400 kbit, 150 ms, 3% loss: BWE 300 kbps, rtt 0.18 s, loss 0.03
  const hist = { bwe: [], loss: [], rtt: [] }
  for (let i = 0; i < 5; i++) {
    pushSmooth(hist.bwe, 300_000)
    pushSmooth(hist.loss, 0.03)
    pushSmooth(hist.rtt, 0.18)
  }
  const lvl = classifyLink(avgSmooth(hist.rtt), avgSmooth(hist.loss), avgSmooth(hist.bwe))
  eq('3G profile → level 2 (usable video, not audio-only)', lvl, 2)
}

/* ---- 2. BWE warmup: no early false downgrade ---- */
{
  // Startup estimate sits at ~100 kbps because the encoder hasn't probed yet.
  const lvl = classifyLink(0.04, 0.0, 100_000, { mode: 'ignore-bwe', fallback: 3 })
  eq('warmup with low startup BWE → level 3 (ignored)', lvl, 3)
  // Warmup with REAL bad transport evidence still downgrades.
  const lvl2 = classifyLink(0.6, 0.2, 100_000, { mode: 'ignore-bwe', fallback: 3 })
  eq('warmup with 20% loss → level 0 (evidence still bites)', lvl2, 0)
}

/* ---- 3. Sudden loss spike + recovery ---- */
{
  const hist = { bwe: [], loss: [], rtt: [] }
  const levels = []
  for (let i = 0; i < 12; i++) {
    const loss = i < 4 ? 0.001 : i < 8 ? 0.25 : 0.001 // 4 clean, 4 spiked, 4 clean
    pushSmooth(hist.bwe, 1_000_000)
    pushSmooth(hist.loss, loss)
    pushSmooth(hist.rtt, 0.03)
    levels.push(classifyLink(avgSmooth(hist.rtt), avgSmooth(hist.loss), avgSmooth(hist.bwe)))
  }
  eq('healthy before spike', levels[2], 3)
  eq('spike → level 0', levels[6], 0)
  eq('still down mid-smoothing (no snap recovery)', levels[8], 0)
  eq('recovered after 3 clean samples', levels[11], 3)
  // Direction check: monotone down into the spike, monotone up out of it.
  const down = levels.slice(3, 8)
  ok('downgrade path never goes UP mid-spike', down.every((v, i) => i === 0 || v <= down[i - 1]))
}

/* ---- 4. Flapping across the BWE threshold ---- */
{
  // Oscillate 118k ↔ 282k around the 120k/280k thresholds. Per-sample this
  // flaps level 0 ↔ 2 (cap 50 kbps ↔ none — visible stutter). The 3-poll
  // smoothing must pin it to the intermediate level 1. Prime the window with
  // three samples first (a single-sample verdict is legitimately raw).
  const hist = { bwe: [], loss: [], rtt: [] }
  for (let i = 0; i < 3; i++) {
    pushSmooth(hist.bwe, 200_000)
    pushSmooth(hist.loss, 0.001)
    pushSmooth(hist.rtt, 0.03)
  }
  const levels = []
  for (let i = 0; i < 12; i++) {
    pushSmooth(hist.bwe, i % 2 === 0 ? 118_000 : 282_000)
    levels.push(classifyLink(avgSmooth(hist.rtt), avgSmooth(hist.loss), avgSmooth(hist.bwe)))
  }
  ok('oscillating BWE → stable level (no flapping)', levels.every((v) => v === levels[0]), levels)
  eq('stable verdict is the intermediate level 1', levels[0], 1)
}

/* ---- 5. App-limited vs link-limited ---- */
{
  // Cap 200 kbps binds the sender (sent ≈ cap) and the estimate ≈ cap:
  // this is OUR cap echoed back — must not re-affirm itself.
  const capped = classifyLink(0.03, 0.001, 210_000, { mode: 'ignore-bwe', fallback: 2 })
  eq('app-limited (sent=cap, bwe≈cap) → stays at previous level', capped, 2)
  // Genuinely weak link: the sender cannot fill the cap (sent ≪ cap), so the
  // engine classifies in NORMAL mode and the estimate is trusted.
  const weak = classifyLink(0.03, 0.001, 100_000)
  eq('link-limited (bwe ≪ cap, normal mode) → downgrades to level 0', weak, 0)
}

/* ---- 6. Probe-up closed-loop sim: the lock-low feedback loop ---- */
{
  // Real link recovered to 400 kbps, but an early episode left the cap at
  // 90 kbps. The observed BWE can never exceed what we're allowed to send.
  // Model the engine faithfully: sent = min(realLink, cap); the link is
  // app-limited when sent ≈ cap AND observed ≈ cap; only link-limited (real)
  // estimates set the shared budget.
  const REAL_LINK = 400_000
  const BASE = 550_000
  const observed = (cap) => Math.min(REAL_LINK, Math.round(cap * 1.05))
  const sent = (cap) => Math.min(REAL_LINK, cap)
  const appLimited = (cap) => sent(cap) >= cap * 0.9 && observed(cap) <= cap * 1.2

  // Without probing: locked low forever (the cap re-affirms itself).
  {
    let cap = 90_000
    let prevLevel = 1 // an earlier weak episode left the call at level 1
    let lastScale = 1
    let locked = true
    for (let i = 0; i < 40; i++) {
      const bwe = appLimited(cap) ? null : observed(cap)
      const lvl = classifyLink(0.03, 0.001, bwe, bwe === null ? { mode: 'ignore-bwe', fallback: prevLevel } : {})
      prevLevel = lvl
      const d = splitBudget({ weakestBwe: appLimited(cap) ? null : observed(cap), level: lvl, baseBitrate: BASE, audioPerPeer: 24_000, connectedPeers: 1, screenLive: false, probing: false, lastBudget: cap, lastScale })
      cap = d.target
      lastScale = d.scale
      if (cap > 200_000) locked = false
    }
    ok('no probe-up → cap locked below 200 kbps forever', locked, cap)
  }
  // With probing every PROBE_EVERY_POLLS: the link climbs back — and once
  // settled, the cap HOLDS between probes instead of ping-ponging.
  {
    let cap = 90_000
    let lastScale = 1
    let prevLevel = 1
    let lastProbe = -PROBE_EVERY_POLLS
    let recovered = false
    const nonProbeCaps = []
    for (let tick = 1; tick <= 30; tick++) {
      const probing = prevLevel <= 2 && tick - lastProbe >= PROBE_EVERY_POLLS
      if (probing) lastProbe = tick
      const bwe = appLimited(cap) && !probing ? null : observed(cap)
      const lvl = classifyLink(0.03, 0.001, bwe, bwe === null ? { mode: 'ignore-bwe', fallback: prevLevel } : {})
      prevLevel = lvl
      const d = splitBudget({ weakestBwe: appLimited(cap) && !probing ? null : observed(cap), level: lvl, baseBitrate: BASE, audioPerPeer: 24_000, connectedPeers: 1, screenLive: false, probing, lastBudget: cap, lastScale })
      cap = d.target
      lastScale = d.scale
      if (cap >= 200_000) recovered = true
      if (!probing && tick > PROBE_EVERY_POLLS + 1) nonProbeCaps.push(cap)
    }
    ok('probe-up → recovered link climbs back above 200 kbps', recovered, cap)
    const stable = nonProbeCaps.every((v) => v === nonProbeCaps[0])
    ok('settled caps hold steady between probes (no ping-pong)', stable, nonProbeCaps)
  }
}

/* ---- 7. CPU ladder ---- */
{
  let s = { step: 0, badTicks: 0, cleanTicks: 0 }
  const step = (limited, cam = true) => {
    const t = cpuLadderTick(s, limited, cam)
    s = t
    return t
  }
  let t = step(true)
  eq('1 bad poll → hold', t.step, 0)
  t = step(true)
  eq('2 bad polls → step 1 (resolution)', t.step, 1)
  t = step(true)
  eq('3rd bad poll → hold', t.step, 1)
  t = step(true)
  eq('4 bad polls → step 2 (+fps cap)', t.step, 2)
  step(true)
  t = step(true)
  eq('6 bad polls → step 3 (audio-only)', t.step, 3)
  // recovery: one step per 10 clean polls, no jumps
  for (let i = 0; i < 9; i++) t = step(false)
  eq('9 clean polls → hold at 3', s.step, 3)
  t = step(false)
  eq('10 clean polls → step 2', s.step, 2)
  for (let i = 0; i < 10; i++) step(false)
  eq('20 clean polls → step 1', s.step, 1)
  // interrupted recovery resets the clean streak
  step(true)
  step(true)
  eq('interrupted recovery → step 2', s.step, 2)
  for (let i = 0; i < 5; i++) step(false)
  step(true)
  eq('5 clean then 1 bad → clean streak reset (hold)', s.step, 2)
  eq('bad streak reset too', s.badTicks, 1)
  // camera off → ticks reset, no movement
  step(false, false)
  eq('video not sending → clean ticks reset', s.cleanTicks, 0)
}

/* ---- 8. Budget split ---- */
{
  // 3 peers, BWE 300 kbps: audio (3×24k) reserved first, rest split evenly.
  const d = splitBudget({ weakestBwe: 300_000, level: 3, baseBitrate: 200_000, audioPerPeer: 24_000, connectedPeers: 3, screenLive: false, probing: false })
  eq('budget: share = (300k×0.8 − 3×24k)/3 = 56k', d.target, 56_000)
  eq('budget: tiny share → ÷4 scale on THAT sender only', d.scale, 4)
  ok('budget: decision is budgeted', d.budgeted)
  // Healthy single peer: never budgeted below its profile.
  const d2 = splitBudget({ weakestBwe: 1_000_000, level: 3, baseBitrate: 550_000, audioPerPeer: 24_000, connectedPeers: 1, screenLive: false, probing: false })
  eq('budget: fat link → profile bitrate untouched', d2.target, 550_000)
  eq('budget: fat link → no resolution scaling', d2.scale, 1)
  // Probe-up poll lifts EVERY cap (budget + LINK_CAP) to the base.
  const d3 = splitBudget({ weakestBwe: 120_000, level: 1, baseBitrate: 200_000, audioPerPeer: 24_000, connectedPeers: 1, screenLive: false, probing: true })
  eq('budget: probe poll → cap lifted to full base', d3.target, 200_000)
  eq('budget: probe poll → no scaling', d3.scale, 1)
  // Screen shares are exempt from the shared budget.
  const d4 = splitBudget({ weakestBwe: 120_000, level: 1, baseBitrate: 220_000, audioPerPeer: 24_000, connectedPeers: 1, screenLive: true, probing: false })
  eq('budget: screen exempt → min(LINK_CAPS, preset)', d4.target, 110_000)
  // Share floor.
  const d5 = splitBudget({ weakestBwe: 80_000, level: 3, baseBitrate: 200_000, audioPerPeer: 24_000, connectedPeers: 4, screenLive: false, probing: false })
  ok('budget: per-peer floor 25 kbps enforced', d5.target >= 25_000, d5.target)
}

/* ---- 9. Sender-rewrite hysteresis ---- */
{
  eq('hysteresis: first write', budgetChanged(0, 56_000, 1, 4), true)
  eq('hysteresis: <10% change skipped', budgetChanged(56_000, 58_000, 4, 4), false)
  eq('hysteresis: >10% change applied', budgetChanged(56_000, 70_000, 4, 4), true)
  eq('hysteresis: scale change always applied', budgetChanged(56_000, 57_000, 4, 2), true)
}

/* ---- warmup constant sanity ---- */
ok('warmup covers ≥10 s of a 3 s poll', BWE_WARMUP_POLLS * 3 >= 10)
ok('probe cadence is 30 s (10 polls)', PROBE_EVERY_POLLS === 10)
ok('budget keeps 20% headroom', UPLOAD_BUDGET_SHARE === 0.8)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
