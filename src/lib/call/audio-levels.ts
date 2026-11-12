'use client'

/**
 * Audio-level engine — one shared AudioContext taps every live mic
 * (local + remote) through an AnalyserNode and publishes a smoothed
 * 0..1 loudness per peer at ~16 Hz.
 *
 * Consumers subscribe per peer and update the DOM imperatively
 * (voice bars, speaking rings), so no React state ever re-renders
 * because of audio. Cost: a few KB of float math per tick.
 */

export type LevelListener = (level: number) => void

interface Source {
  analyser: AnalyserNode
  data: Uint8Array<ArrayBuffer>
  /** Smoothed loudness 0..1 — fast attack, slow decay. */
  level: number
}

const sources = new Map<string, Source>()
const listeners = new Map<string, Set<LevelListener>>()
let ctx: AudioContext | null = null
let silentOut: GainNode | null = null
let timer: number | null = null

// Browsers may suspend the context when the tab is backgrounded — wake it up
// as soon as the user returns so the meters never stay dead.
if (typeof document !== 'undefined') {
  const wake = () => {
    if (ctx && ctx.state === 'suspended') void ctx.resume().catch(() => undefined)
  }
  document.addEventListener('visibilitychange', wake)
  document.addEventListener('pointerdown', wake)
}

const TICK_MS = 60
/** Speech RMS rarely tops ~0.3 — lift it into a visible range. */
const GAIN = 3.4

function ensureContext(): AudioContext | null {
  if (typeof window === 'undefined') return null
  try {
    if (!ctx) {
      ctx = new AudioContext()
      // Shared mute sink: keeps the graph pulled (Chrome requires it for
      // remote WebRTC streams) without echoing anything to the speakers.
      silentOut = ctx.createGain()
      silentOut.gain.value = 0
      silentOut.connect(ctx.destination)
    }
    if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined)
    return ctx
  } catch {
    return null
  }
}

function tick() {
  if (sources.size === 0) return
  for (const [peerId, src] of sources) {
    let next = 0
    try {
      src.analyser.getByteTimeDomainData(src.data)
      let sum = 0
      for (let i = 0; i < src.data.length; i += 2) {
        const v = (src.data[i] - 128) / 128
        sum += v * v
      }
      const rms = Math.sqrt(sum / (src.data.length / 2))
      next = Math.min(1, rms * GAIN)
    } catch {
      next = 0
    }
    // Attack instantly, decay smoothly — reads like a real VU meter.
    src.level = next > src.level ? next : src.level * 0.82 + next * 0.18
    if (src.level < 0.001) src.level = 0
    const subs = listeners.get(peerId)
    if (subs) for (const fn of subs) fn(src.level)
  }
}

function start() {
  if (timer === null) timer = window.setInterval(tick, TICK_MS)
}

function stopIfIdle() {
  if (timer !== null && sources.size === 0) {
    window.clearInterval(timer)
    timer = null
  }
}

/** Attach (or detach with null) the live audio of a peer. */
export function trackAudio(peerId: string, stream: MediaStream | null) {
  const existing = sources.get(peerId)
  if (existing) {
    try {
      existing.analyser.disconnect()
    } catch {
      /* ignore */
    }
    sources.delete(peerId)
  }
  if (!stream || stream.getAudioTracks().length === 0) {
    stopIfIdle()
    dispatch(peerId, 0)
    return
  }
  const audioCtx = ensureContext()
  if (!audioCtx) return
  try {
    const analyser = audioCtx.createAnalyser()
    analyser.fftSize = 512
    analyser.smoothingTimeConstant = 0.4
    const node = audioCtx.createMediaStreamSource(stream)
    node.connect(analyser)
    if (silentOut) analyser.connect(silentOut)
    sources.set(peerId, {
      analyser,
      data: new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount)),
      level: 0,
    })
    start()
  } catch {
    /* stream not analyzable (e.g. cross-origin) */
  }
}

/** Remove every tracked source (on leave). */
export function clearAllAudio() {
  for (const [, src] of sources) {
    try {
      src.analyser.disconnect()
    } catch {
      /* ignore */
    }
  }
  sources.clear()
  stopIfIdle()
}

function dispatch(peerId: string, level: number) {
  const subs = listeners.get(peerId)
  if (subs) for (const fn of subs) fn(level)
}

/** Subscribe to a peer's loudness. Returns an unsubscribe function. */
export function subscribeLevel(peerId: string, fn: LevelListener): () => void {
  let subs = listeners.get(peerId)
  if (!subs) {
    subs = new Set()
    listeners.set(peerId, subs)
  }
  subs.add(fn)
  return () => {
    subs!.delete(fn)
    if (subs!.size === 0) listeners.delete(peerId)
  }
}
