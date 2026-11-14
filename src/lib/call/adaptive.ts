/**
 * Pure adaptation logic — no DOM, no WebRTC objects, no React.
 *
 * Everything here is deterministic and unit-testable offline: replay recorded
 * getStats() traces through classifyLink / splitBudget / cpuLadderTick to
 * verify level decisions, budget splits and the CPU ladder without a browser.
 * The engine feeds live samples in; this module decides.
 */
import { LINK_CAPS, type NetworkLevel } from './types'

/* ---- smoothing ---- */
/** Transport signals are averaged over the last N polls (3 s apart) — the
 *  anti-flap window. */
export const SMOOTH_WINDOW = 3

/* ---- BWE classification (primary signal) ---- */
/** availableOutgoingBitrate (bps) → level thresholds. Smoothed loss/RTT are
 *  secondary triggers that can only ever WORSEN the verdict, never upgrade. */
export const BWE_LEVEL0_BPS = 120_000 // below → level 0 (50 kbps video floor + 16 kbps audio)
export const BWE_LEVEL1_BPS = 280_000 // below → level 1 (110 kbps cap)
export const BWE_LEVEL2_BPS = 600_000 // below → level 2 (profile default)

/* ---- anti-lock-low guards ----
 * availableOutgoingBitrate starts near zero and only grows when the sender is
 * ALLOWED to probe. Trust it too early — or while the cap binds the sender —
 * and the estimate never rises again: cap → low estimate → lower cap. */
/** Ignore BWE entirely for the first polls of a call (≈12 s). */
export const BWE_WARMUP_POLLS = 4
/** The sender is app-limited when it sends ≥ this fraction of its own cap. */
export const APP_LIMITED_FACTOR = 0.9
/** Probe-up cadence: every N polls (≈30 s) the budget is lifted so the
 *  transport can probe upward and the estimate can recover. */
export const PROBE_EVERY_POLLS = 10
/** Probe DURATION: 3 polls ≈ 9 s. Chrome's bandwidth estimator ramps up
 *  gradually — a single 3 s window often ends before the estimate has moved
 *  at all, so a useful probe spans several polls. */
export const PROBE_POLLS = 3
/** Skip a probe-up when EITHER of the last two loss samples exceeded this —
 *  probing into fresh loss briefly congests a link that is genuinely weak. */
export const PROBE_LOSS_GUARD = 0.02
/** Budget-hold expiry: holding the last budget is valid only while the
 *  estimate stream is alive (fresh echo samples). Once no BWE sample has
 *  arrived for N polls, the held budget is stale → fall back to a
 *  conservative weak-link cap (LINK_CAPS[1]). */
export const HOLD_MAX_POLLS = 5

/* ---- mesh upload budget ---- */
/** Budget = share × the weakest smoothed BWE (headroom for ICE/RTCP). */
export const UPLOAD_BUDGET_SHARE = 0.8
/** Per-peer video floor when the shared budget runs dry (bps). */
export const BUDGET_VIDEO_FLOOR = 25_000
/** A weak peer's sender scales resolution down below these budgets:
 *  <80 kbps → ÷4, <150 kbps → ÷2 (capture stays shared, only THEIR stream
 *  shrinks — one bad link never degrades the picture everyone else gets). */
export const BUDGET_SCALE4_BPS = 80_000
export const BUDGET_SCALE2_BPS = 150_000
/** Sender params are rewritten only on a >10% budget change or scale change. */
export const BUDGET_REWRITE_FACTOR = 0.1

/* ---- CPU ladder ---- */
/** One step per 2 consecutive 'cpu'-limited polls; one step back per 10
 *  consecutive clean polls. Step 1 = resolution down, 2 = +fps cap, 3 = audio
 * -only send. */
export const CPU_STEP_POLLS = 2
export const CPU_RECOVER_POLLS = 10
/** Capture fps ceiling once the CPU ladder reaches step 2. */
export const CPU_FPS_CAP = 12

/** Push a sample into a fixed-size smoothing window. */
export function pushSmooth(hist: number[], v: number, max: number = SMOOTH_WINDOW) {
  hist.push(v)
  if (hist.length > max) hist.shift()
}

/** Average of a smoothing window; null when no sample has arrived yet. */
export function avgSmooth(hist: number[] | undefined): number | null {
  if (!hist || hist.length === 0) return null
  let s = 0
  for (const v of hist) s += v
  return s / hist.length
}

/**
 * Why BWE is being ignored (if it is):
 *  - 'warmup': first polls of a call — the estimate is a startup artifact.
 *  - 'app-limited': the cap binds the sender, so the estimate mirrors our own
 *    cap and re-affirms it forever.
 * In both modes loss/RTT still apply (they are measured, not probed), but the
 * verdict can never rise above `fallback` (warmup: 3, app-limited: the
 * previous level — an already-capped link must not slide on missing data).
 */
export type ClassifyMode = 'normal' | 'ignore-bwe'

export function classifyLink(
  rttAvg: number | null,
  lossAvg: number | null,
  bweAvg: number | null,
  opts: { mode?: ClassifyMode; fallback?: NetworkLevel | null } = {},
): NetworkLevel {
  const lossRttLevel = (): NetworkLevel => {
    const rtt = rttAvg ?? 0.4
    const loss = lossAvg ?? 0.05
    if (rtt > 0.5 || loss > 0.08) return 0
    if (rtt > 0.3 || loss > 0.05) return 1
    if (rtt > 0.15 || loss > 0.02) return 2
    return 3
  }
  if (opts.mode === 'ignore-bwe') {
    const fallback = opts.fallback ?? 3
    return Math.min(lossRttLevel(), fallback) as NetworkLevel
  }
  if (bweAvg !== null) {
    let level: NetworkLevel =
      bweAvg < BWE_LEVEL0_BPS ? 0 : bweAvg < BWE_LEVEL1_BPS ? 1 : bweAvg < BWE_LEVEL2_BPS ? 2 : 3
    if (rttAvg !== null || lossAvg !== null) {
      const rtt = rttAvg ?? 0.4
      const loss = lossAvg ?? 0.05
      if (rtt > 0.5 || loss > 0.08) level = Math.min(level, 0) as NetworkLevel
      else if (rtt > 0.3 || loss > 0.05) level = Math.min(level, 1) as NetworkLevel
      else if (rtt > 0.15 || loss > 0.02) level = Math.min(level, 2) as NetworkLevel
    }
    return level
  }
  return lossRttLevel()
}

export interface BudgetInput {
  /** Weakest smoothed outgoing BWE across connected links (bps); null = unknown. */
  weakestBwe: number | null
  /** This link's classified level (drives the loss/RTT LINK_CAPS). */
  level: NetworkLevel
  /** Sender's base bitrate before caps — camera profile or screen preset. */
  baseBitrate: number
  /** Audio reserved per peer (bps) — audio first, video splits the rest. */
  audioPerPeer: number
  /** Connected peers sharing the uplink. */
  connectedPeers: number
  /** Screen shares are exempt from the shared budget (own preset caps). */
  screenLive: boolean
  /** Probe-up poll: the budget is lifted so the transport can probe upward. */
  probing: boolean
  /** Last applied target/scale — with no honest estimate available (all
   *  links app-limited) the decision HOLDS here instead of jumping to base
   *  (which would ping-pong against the honest budget computed one poll
   *  later). Only a probe poll lifts the hold. */
  lastBudget?: number
  lastScale?: number
  /** True once this link has EVER reported a BWE sample — distinguishes
   *  browsers without transport-cc (no budget regime at all) from browsers
   *  whose estimate stream went silent. */
  bweEver?: boolean
  /** Polls since the link's last BWE sample (0 = fresh). Holds are valid
   *  only while this is ≤ HOLD_MAX_POLLS. */
  bweAge?: number
}

export interface BudgetDecision {
  /** maxBitrate to apply to this sender. */
  target: number
  /** scaleResolutionDownBy for THIS sender (weak peer only). */
  scale: number
  /** True when the shared budget constrained the decision. */
  budgeted: boolean
  /** The per-sender share the budget yields (debug overlay), 0 when unbudgeted. */
  share: number
}

export function splitBudget(i: BudgetInput): BudgetDecision {
  // Probe-up: lift EVERY cap for the probe window (budget AND the level's
  // LINK_CAP — the level may itself be pinned by the app-limited guard) so
  // the transport can probe to the profile bitrate and the estimate can
  // recover. If the link is genuinely bad, loss/RTT re-cap it immediately.
  if (i.probing) return { target: i.baseBitrate, scale: 1, budgeted: false, share: 0 }
  if (i.screenLive) return { target: LINK_CAPS[i.level] !== null ? Math.min(LINK_CAPS[i.level] as number, i.baseBitrate) : i.baseBitrate, scale: 1, budgeted: false, share: 0 }
  const cap = LINK_CAPS[i.level]
  const base = cap !== null ? Math.min(cap, i.baseBitrate) : i.baseBitrate
  // No honest estimate this poll (every connected link is app-limited): hold
  // the last decision. Lifting to base here would ping-pong against the
  // honest budget computed one poll later — the oscillation the offline
  // tests caught. Only the periodic probe breaks the hold. The hold itself
  // expires (HOLD_MAX_POLLS): a stale budget with no fresh estimate behind
  // it falls back to a conservative weak-link cap. Browsers that never
  // report BWE at all (e.g. Firefox) never enter the budget regime — their
  // LINK_CAPS come from the loss/RTT classification alone.
  if (i.weakestBwe === null && (i.lastBudget ?? 0) > 0 && i.bweEver === true) {
    if ((i.bweAge ?? Infinity) > HOLD_MAX_POLLS) {
      const conservative = LINK_CAPS[1]
      const target = conservative !== null ? Math.min(conservative, i.baseBitrate) : i.baseBitrate
      return { target, scale: i.lastScale ?? 1, budgeted: false, share: target }
    }
    return { target: i.lastBudget as number, scale: i.lastScale ?? 1, budgeted: false, share: i.lastBudget as number }
  }
  if (i.weakestBwe === null) {
    return { target: base, scale: 1, budgeted: false, share: 0 }
  }
  const budget = i.weakestBwe * UPLOAD_BUDGET_SHARE
  const peers = Math.max(1, i.connectedPeers)
  const share = Math.max(BUDGET_VIDEO_FLOOR, (budget - i.audioPerPeer * peers) / peers)
  if (base <= share) return { target: base, scale: 1, budgeted: false, share }
  const target = Math.max(BUDGET_VIDEO_FLOOR, share)
  const scale = target < BUDGET_SCALE4_BPS ? 4 : target < BUDGET_SCALE2_BPS ? 2 : 1
  return { target, scale, budgeted: true, share }
}

/** Sender-rewrite hysteresis: skip unless first write, a scale change, or a
 *  >10% budget change — never per-poll ping-pong. */
export function budgetChanged(lastBudget: number, target: number, lastScale: number, scale: number): boolean {
  if (lastBudget === 0) return true
  if (scale !== lastScale) return true
  return Math.abs(target - lastBudget) > Math.max(target, lastBudget) * BUDGET_REWRITE_FACTOR
}

export interface CpuLadderState {
  /** 0 ok → 1 resolution down → 2 +fps cap → 3 audio-only send. */
  step: number
  badTicks: number
  cleanTicks: number
}

export function cpuLadderTick(
  state: CpuLadderState,
  cpuLimited: boolean,
  camSending = true,
): CpuLadderState & { changed: boolean; escalated: boolean } {
  if (!camSending) {
    return { ...state, badTicks: 0, cleanTicks: 0, changed: false, escalated: false }
  }
  if (cpuLimited) {
    const badTicks = state.badTicks + 1
    if (badTicks >= CPU_STEP_POLLS && badTicks % CPU_STEP_POLLS === 0 && state.step < 3) {
      return { step: state.step + 1, badTicks, cleanTicks: 0, changed: true, escalated: true }
    }
    return { ...state, badTicks, cleanTicks: 0, changed: false, escalated: false }
  }
  const cleanTicks = state.cleanTicks + 1
  if (cleanTicks >= CPU_RECOVER_POLLS && state.step > 0) {
    return { step: state.step - 1, badTicks: 0, cleanTicks: 0, changed: true, escalated: false }
  }
  return { ...state, badTicks: 0, cleanTicks, changed: false, escalated: false }
}
