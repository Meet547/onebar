/*
 * Offline unit tests for the pure adaptation logic (src/lib/call/adaptive.ts).
 *
 * No browser, no WebRTC, no deps: the module is compiled to CommonJS and the
 * traces below are replayed through classifyLink / splitBudget /
 * cpuLadderTick / budgetChanged. Run via scripts/run-adaptive-tests.sh.
 *
 * PROVENANCE (read this before trusting a green run): these tests verify
 * that the DECISION LOGIC matches a Chrome-shaped transport model — nothing
 * more. Where the simulator and the engine disagreed, each side was judged
 * on its own merits: two ENGINE bugs the sim exposed were fixed in the
 * engine (probe must lift the LINK_CAP too; app-limited echo must not feed
 * the shared budget), while two simulator mistakes were fixed in the sim
 * (missing prevLevel fallback; single-sample priming). A green run here does
 * NOT substitute for shaped-network field runs — that remains the real test.
 *
 * What the traces check:
 *   1. 3G profile classifies sanely (level 2, not 0).
 *   2. BWE warmup: a low startup estimate never causes an early downgrade.
 *   3. Sudden loss spike: fast drop, slow recovery, right direction.
 *   4. Flapping: oscillation across the BWE threshold is smoothed into a
 *      stable verdict (raw per-sample decisions would flap 0↔2).
 *   5. App-limited vs link-limited: a capped sender's echo estimate must not
 *      re-affirm the cap; a genuinely weak link still downgrades.
 *   6. Probe-up closed loop: estimator ramp model — without probing a
 *      recovered link stays locked low; a 3-poll probe recovers it; a
 *      1-poll probe does NOT (too short); probes are skipped while the last
 *      two polls saw loss; BWE silence expires the budget hold after
 *      HOLD_MAX_POLLS; browsers that never report BWE keep the plain
 *      loss/RTT regime.
 *   7. CPU ladder: escalation every 2 bad polls, one step per 10 clean,
 *      no jumps, resets when video send stops.
 *   8. Budget split: audio reserved first, weak peer scaled, screen exempt,
 *      probe lifts caps, hold honored while fresh.
 *   9. Sender-rewrite hysteresis: no per-poll ping-pong.
 */
const {
  classifyLink,
  splitBudget,
  cpuLadderTick,
  budgetChanged,
  pushSmooth,
  avgSmooth,
  BWE_WARMUP_POLLS,
  PROBE_EVERY_POLLS,
  PROBE_POLLS,
  PROBE_LOSS_GUARD,
  HOLD_MAX_POLLS,
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
  // 90 kbps. Chrome's estimator is modeled honestly: it RAMPS gradually
  // toward what it is allowed to send (50%/poll), and when the cap binds it
  // collapses to the cap-echo immediately. Samples arrive fresh every poll
  // unless `silence` says the estimate stream died.
  const REAL_LINK = 400_000
  const BASE = 550_000
  const RAMP = 0.5
  const audio = 24_000

  const makeSim = () => ({
    cap: 90_000, // lastBudget
    scale: 1,
    prevLevel: 1, // an earlier weak episode left the call at level 1
    est: 90_000, // last observed estimate (echo while the cap binds)
    lastProbe: 0, // engine: lastProbeTick starts 0 → first probe at tick 10
    lastBweTick: 0,
    lossHist: [0.001, 0.001], // healthy transport (loss is measured, not probed)
    silence: false,
    probingPrev: false, // probe window active during the PREVIOUS poll
  })

  // One poll, mirroring the engine's per-poll order: transport responds to
  // last poll's window → classify → schedule the probe → budget decision.
  const poll = (s, tick, probesEnabled, windowLen = PROBE_POLLS) => {
    // 1) transport: the sender was allowed `allowed` during the last poll
    const allowed = s.probingPrev ? BASE : s.cap
    const targetEst = Math.min(REAL_LINK, allowed)
    if (allowed > s.est) s.est = Math.round(s.est + (targetEst - s.est) * RAMP)
    else s.est = Math.min(REAL_LINK, Math.round(allowed * 1.05))
    const bweSample = s.silence ? null : s.est
    if (bweSample !== null) s.lastBweTick = tick
    const sent = Math.min(REAL_LINK, allowed)

    // 2) classification (mirror engine: freshness gate + app-limited guard)
    const appLimited =
      !s.silence && s.cap > 0 && bweSample !== null && sent >= s.cap * 0.9 && bweSample <= s.cap * 1.2
    const lvl = classifyLink(0.03, 0.001, bweSample, {
      mode: appLimited ? 'ignore-bwe' : 'normal',
      fallback: appLimited ? s.prevLevel : null,
    })
    s.prevLevel = lvl

    // 3) probe scheduling (mirror engine; bytes land next poll)
    const lossRecentBad = s.lossHist.slice(-2).some((v) => v > PROBE_LOSS_GUARD)
    const eligible = lvl <= 2 || (s.cap > 0 && s.cap < BASE)
    let probing = false
    if (probesEnabled && eligible && !lossRecentBad) {
      if (tick - s.lastProbe >= PROBE_EVERY_POLLS) s.lastProbe = tick
      probing = s.lastProbe > 0 && tick - s.lastProbe < windowLen // only a SCHEDULED window
    }
    s.probingPrev = probing

    // 4) budget decision
    const bweForBudget = appLimited ? null : bweSample
    const d = splitBudget({
      weakestBwe: bweForBudget,
      level: lvl,
      baseBitrate: BASE,
      audioPerPeer: audio,
      connectedPeers: 1,
      screenLive: false,
      probing,
      lastBudget: s.cap,
      lastScale: s.scale,
      bweEver: s.lastBweTick > 0,
      bweAge: s.lastBweTick > 0 ? tick - s.lastBweTick : Infinity,
    })
    s.cap = d.target
    s.scale = d.scale
    return { probing, lvl, cap: s.cap }
  }

  // 6a. No probe at all → locked low forever.
  {
    const s = makeSim()
    let locked = true
    for (let tick = 1; tick <= 40; tick++) {
      poll(s, tick, false)
      if (s.cap > 200_000) locked = false
    }
    ok('no probe-up → cap locked below 200 kbps forever', locked, s.cap)
  }
  // 6b. Full-length probe (PROBE_POLLS polls) → recovered, and the ramp
  //     means recovery takes at least one full window.
  {
    const s = makeSim()
    let recoveredAt = -1
    const nonProbeCaps = []
    for (let tick = 1; tick <= 40; tick++) {
      const r = poll(s, tick, true)
      if (s.cap >= 200_000 && recoveredAt < 0) recoveredAt = tick
      if (!r.probing && tick > 15) nonProbeCaps.push(s.cap)
    }
    ok('probe-up (3-poll window) → recovered above 200 kbps', recoveredAt > 0, { recoveredAt, cap: s.cap })
    ok('recovery takes a full probe window (estimator ramps)', recoveredAt >= PROBE_EVERY_POLLS, recoveredAt)
    // Convergence is asymptotic (each window's estimate lands a little
    // higher) — the ping-pong signature is a DOWN-jump, not a climb.
    ok(
      'settled caps never drop sharply between probes (no ping-pong)',
      nonProbeCaps.every((v, i) => i === 0 || v >= nonProbeCaps[i - 1] * 0.95),
      nonProbeCaps,
    )
  }
  // 6c. One-poll probe (the old behavior) → does NOT recover: the estimator
  //     never ramps far enough in a single 3 s window. Judge the SETTLED
  //     cap (between probe polls), not the transient probe lift itself.
  {
    const s = makeSim()
    const settled = []
    for (let tick = 1; tick <= 60; tick++) {
      const r = poll(s, tick, true, 1)
      if (!r.probing) settled.push(s.cap)
    }
    ok('1-poll probe too short → still locked low', settled.every((v) => v < 200_000), settled.slice(-6))
  }
  // 6d. Loss guard: no probe is scheduled while the last two polls saw loss.
  {
    const s = makeSim()
    s.lossHist = [0.25, 0.25]
    let probed = 0
    for (let tick = 1; tick <= 24; tick++) { // ends before the next probe window would start at 25
      if (tick === 15) s.lossHist = [0.001, 0.001] // loss clears
      const r = poll(s, tick, true)
      if (r.probing) probed++
    }
    ok('probes resume only after recent loss clears', probed === PROBE_POLLS, probed)
    const s2 = makeSim()
    s2.lossHist = [0.25, 0.25]
    let probed2 = 0
    for (let tick = 1; tick <= 25; tick++) {
      const r = poll(s2, tick, true) // loss never clears
      if (r.probing) probed2++
    }
    eq('sustained loss → zero probes', probed2, 0)
  }
  // 6e. BWE silence: hold stands while samples were fresh, expires after
  //     HOLD_MAX_POLLS to the conservative weak-link cap.
  {
    const s = makeSim()
    for (let tick = 1; tick <= 40; tick++) poll(s, tick, true)
    const heldCap = s.cap
    s.silence = true // estimate stream dies right here
    let expired = false
    for (let tick = 41; tick <= 40 + HOLD_MAX_POLLS + 3; tick++) {
      poll(s, tick, true)
      if (s.cap <= 110_000) expired = true
    }
    ok('silence → hold expires to the conservative cap (LINK_CAPS[1])', expired && s.cap <= 110_000, { heldCap, cap: s.cap })
    // probes still fire through silence and re-open the regime
    s.silence = false
    for (let tick = 54; tick <= 70; tick++) poll(s, tick, true)
    ok('probes continue after silence → cap re-climbs', s.cap > 150_000, s.cap)
  }
  // 6f. Browsers that never report BWE: no budget regime, no hold expiry —
  //     the loss/RTT LINK_CAPS rule alone.
  {
    const d = splitBudget({
      weakestBwe: null,
      level: 3,
      baseBitrate: 550_000,
      audioPerPeer: audio,
      connectedPeers: 1,
      screenLive: false,
      probing: false,
      lastBudget: 550_000,
      lastScale: 1,
      bweEver: false,
      bweAge: Infinity,
    })
    eq('no BWE ever → plain profile cap (no conservative downgrade)', d.target, 550_000)
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
