'use client'

/**
 * Listen-together audio pipeline.
 *
 * Sharing side: a private <audio> element is routed through the Web Audio
 * graph — element → source → MediaStreamDestination (feeds WebRTC at full
 * level) + a separate monitor gain (feeds local speakers, adjustable without
 * touching what others hear). Audio-only at Opus ~96 kbps: a few percent of
 * one core and a fraction of the cost of video.
 *
 * Receiving side: one hidden <audio> element plays the peer's music stream
 * while the tile <video> keeps carrying their mic/camera.
 */

export interface MusicHandle {
  /** Audio stream to publish over WebRTC. */
  stream: MediaStream
  title: string
  /** Seconds; 0 means live/infinite. */
  duration: number
  getPosition(): number
  isPlaying(): boolean
  play(): Promise<void>
  pause(): void
  seek(t: number): void
  setMonitorVolume(v: number): void
  /** Fires whenever playback state changes — engine broadcasts meta then. */
  onMeta(cb: () => void): void
  /** Stop everything and release resources. */
  stop(): void
}

/* ------------------------------------------------------------------ */
/* Sharer: local file -> element -> WebAudio -> capture stream         */
/* ------------------------------------------------------------------ */

export function createFileMusicHandle(file: File): MusicHandle {
  const url = URL.createObjectURL(file)
  const el = document.createElement('audio')
  el.src = url
  el.preload = 'auto'
  el.volume = 1 // stays fixed — the monitor gain below is the local volume

  const ctx = new AudioContext()
  const source = ctx.createMediaElementSource(el)
  const dest = ctx.createMediaStreamDestination()
  const monitor = ctx.createGain()
  source.connect(dest) // full level into WebRTC
  source.connect(monitor)
  monitor.connect(ctx.destination)
  void ctx.resume().catch(() => undefined)

  const metaCbs = new Set<() => void>()
  const fireMeta = () => metaCbs.forEach((cb) => cb())
  el.addEventListener('play', fireMeta)
  el.addEventListener('pause', fireMeta)
  el.addEventListener('seeked', fireMeta)
  el.addEventListener('loadedmetadata', fireMeta)
  el.addEventListener('ended', fireMeta)

  return {
    stream: dest.stream,
    title: file.name.replace(/\.[^.]+$/, '').slice(0, 80) || 'Music',
    getPosition: () => el.currentTime,
    isPlaying: () => !el.paused && !el.ended,
    play: () => {
      void ctx.resume().catch(() => undefined)
      return el.play().then(() => undefined)
    },
    pause: () => el.pause(),
    seek: (t) => {
      el.currentTime = t
    },
    setMonitorVolume: (v) => {
      monitor.gain.value = Math.max(0, Math.min(1, v))
    },
    onMeta: (cb) => {
      metaCbs.add(cb)
      return () => metaCbs.delete(cb)
    },
    get duration() {
      return Number.isFinite(el.duration) ? el.duration : 0
    },
    stop: () => {
      try {
        el.pause()
        el.src = ''
        el.load()
      } catch {
        /* ignore */
      }
      try {
        source.disconnect()
        monitor.disconnect()
      } catch {
        /* ignore */
      }
      void ctx.close().catch(() => undefined)
      URL.revokeObjectURL(url)
    },
  }
}

/* ------------------------------------------------------------------ */
/* Test handle — a tiny scheduled melody, for E2E and demo mode        */
/* ------------------------------------------------------------------ */

export function createTestMusicHandle(): MusicHandle {
  const ctx = new AudioContext()
  const dest = ctx.createMediaStreamDestination()
  const monitor = ctx.createGain()
  monitor.gain.value = 0.9
  const bus = ctx.createGain()
  bus.gain.value = 0.5
  bus.connect(dest) // into WebRTC
  bus.connect(monitor)
  monitor.connect(ctx.destination) // local preview
  void ctx.resume().catch(() => undefined)

  // Pentatonic arpeggio with a soft pulse — clearly "music", cheap to render.
  const SCALE = [261.63, 293.66, 329.63, 392.0, 440.0, 523.25]
  let step = 0
  let nextTime = ctx.currentTime + 0.1
  let base = 0

  const schedule = () => {
    while (nextTime < ctx.currentTime + 1.2) {
      const f = SCALE[(step * 3 + Math.floor(step / 6)) % SCALE.length]
      const osc = ctx.createOscillator()
      const g = ctx.createGain()
      osc.type = step % 4 === 0 ? 'triangle' : 'sine'
      osc.frequency.value = f
      const t = nextTime
      g.gain.setValueAtTime(0, t)
      g.gain.linearRampToValueAtTime(step % 8 === 0 ? 0.5 : 0.32, t + 0.02)
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.42)
      osc.connect(g)
      g.connect(bus)
      osc.start(t)
      osc.stop(t + 0.45)
      nextTime += 0.24
      step++
    }
  }
  schedule()
  const timer = window.setInterval(schedule, 300)

  const startedAt = ctx.currentTime
  let pausedOffset = 0
  let pauseTime: number | null = null
  const metaCbs = new Set<() => void>()

  return {
    stream: dest.stream,
    title: 'Pico demo tune',
    duration: 0,
    getPosition: () => pauseTime !== null ? pausedOffset : ctx.currentTime - startedAt,
    isPlaying: () => pauseTime === null,
    play: () => {
      if (pauseTime !== null) {
        pausedOffset += ctx.currentTime - pauseTime
        pauseTime = null
        nextTime = Math.max(nextTime, ctx.currentTime + 0.1)
      }
      void ctx.resume().catch(() => undefined)
      return Promise.resolve()
    },
    pause: () => {
      if (pauseTime === null) {
        pauseTime = ctx.currentTime
        void ctx.suspend().catch(() => undefined)
      }
    },
    seek: () => {
      /* live stream — no seeking */
    },
    setMonitorVolume: (v) => {
      monitor.gain.value = Math.max(0, Math.min(1, v))
    },
    onMeta: (cb) => {
      metaCbs.add(cb)
      return () => metaCbs.delete(cb)
    },
    stop: () => {
      window.clearInterval(timer)
      try {
        bus.disconnect()
        monitor.disconnect()
        dest.disconnect()
      } catch {
        /* ignore */
      }
      void ctx.close().catch(() => undefined)
    },
  }
}

/* ------------------------------------------------------------------ */
/* Receiver: one hidden audio element for the peer's music stream      */
/* ------------------------------------------------------------------ */

let remoteEl: HTMLAudioElement | null = null

export function attachRemoteMusic(stream: MediaStream): Promise<boolean> {
  if (!remoteEl) {
    remoteEl = document.createElement('audio')
    remoteEl.autoplay = true
    remoteEl.setAttribute('aria-hidden', 'true')
    remoteEl.style.display = 'none'
    document.body.appendChild(remoteEl)
  }
  if (remoteEl.srcObject !== stream) {
    remoteEl.srcObject = stream
  }
  return remoteEl
    .play()
    .then(() => true)
    .catch(() => {
      // Autoplay blocked — retry on the next interaction.
      const retry = () => void remoteEl?.play().catch(() => undefined)
      document.addEventListener('pointerdown', retry, { once: true })
      return false
    })
}

export function detachRemoteMusic() {
  if (remoteEl) {
    remoteEl.srcObject = null
    remoteEl.pause()
  }
}

export function setRemoteMusicVolume(v: number) {
  if (remoteEl) remoteEl.volume = Math.max(0, Math.min(1, v))
}
