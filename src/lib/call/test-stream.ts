'use client'

/**
 * Synthetic camera+mic used when `?test=1` is present or no capture devices
 * exist. Draws the Pico waveform mark animating on an ink-black canvas —
 * on brand, zero gradients — and adds a soft breathing tone so the voice
 * bars visibly dance. Lets the whole pipeline (preview, tiles, WebRTC
 * encoding, audio metering) be exercised anywhere.
 */
export async function createTestStream(): Promise<MediaStream> {
  const canvas = document.createElement('canvas')
  canvas.width = 640
  canvas.height = 360
  const ctx = canvas.getContext('2d')!

  const BARS = [0.42, 0.62, 1, 0.72, 0.5, 0.34]
  const draw = () => {
    const t = Date.now() / 1000
    // Ink background with a barely-there vignette drawn as flat fills.
    ctx.fillStyle = '#0d0d0f'
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    const n = BARS.length
    const bw = 14
    const gap = 18
    const total = n * bw + (n - 1) * gap
    let x = (canvas.width - total) / 2
    const cy = canvas.height / 2

    for (let i = 0; i < n; i++) {
      const wave = 0.55 + 0.45 * Math.sin(t * 2.4 + i * 0.9)
      const h = BARS[i] * 150 * wave
      const shift = Math.sin(t * 0.7 + i) * 6
      ctx.fillStyle = i === 2 ? '#30d158' : 'rgba(255,255,255,0.92)'
      const bx = x + shift
      const by = cy - h / 2
      const r = bw / 2
      ctx.beginPath()
      ctx.moveTo(bx + r, by)
      ctx.arcTo(bx + bw, by, bx + bw, by + h, r)
      ctx.arcTo(bx + bw, by + h, bx, by + h, r)
      ctx.arcTo(bx, by + h, bx, by, r)
      ctx.arcTo(bx, by, bx + bw, by, r)
      ctx.closePath()
      ctx.fill()
      x += bw + gap
    }

    ctx.fillStyle = 'rgba(255,255,255,0.55)'
    ctx.font = '600 17px Manrope, -apple-system, system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText('Pico test signal', canvas.width / 2, 56)
    ctx.fillStyle = 'rgba(255,255,255,0.3)'
    ctx.font = '500 13px Geist Mono, monospace'
    ctx.fillText(new Date().toLocaleTimeString(), canvas.width / 2, canvas.height - 34)
  }
  draw()
  const timer = window.setInterval(draw, 80)
  const stream = canvas.captureStream(12)

  // A soft tone with a slow tremolo — gives the voice meter something honest to show.
  let audioCtx: AudioContext | null = null
  try {
    audioCtx = new AudioContext()
    // Autoplay policy: contexts created before a gesture start suspended.
    // Resume on the first interaction so the signal (and the voice meter) comes alive.
    const resume = () => void audioCtx?.resume().catch(() => undefined)
    resume()
    document.addEventListener('pointerdown', resume, { once: true })
    document.addEventListener('keydown', resume, { once: true })
    const osc = audioCtx.createOscillator()
    osc.type = 'sine'
    osc.frequency.value = 196
    const gain = audioCtx.createGain()
    const tremolo = audioCtx.createOscillator()
    tremolo.frequency.value = 0.45
    const depth = audioCtx.createGain()
    depth.gain.value = 0.05
    tremolo.connect(depth)
    depth.connect(gain.gain)
    gain.gain.value = 0.12
    const dest = audioCtx.createMediaStreamDestination()
    osc.connect(gain)
    gain.connect(dest)
    osc.start()
    tremolo.start()
    const audioTrack = dest.stream.getAudioTracks()[0]
    if (audioTrack) stream.addTrack(audioTrack)
  } catch {
    /* audio not available — video-only test stream */
  }

  ;(stream as MediaStream & { __stop?: () => void }).__stop = () => {
    window.clearInterval(timer)
    audioCtx?.close().catch(() => undefined)
  }
  return stream
}

/**
 * Synthetic display capture for test mode — a flat, animated "slide" that
 * makes it obvious on the receiving side that screen sharing works.
 */
export async function createTestScreenStream(): Promise<MediaStream> {
  const canvas = document.createElement('canvas')
  canvas.width = 960
  canvas.height = 540
  const ctx = canvas.getContext('2d')!

  const draw = () => {
    const t = Date.now() / 1000
    ctx.fillStyle = '#0d0d0f'
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    // flat slide: heading, body lines, a moving progress bar
    ctx.fillStyle = '#ffffff'
    ctx.font = '700 44px Manrope, -apple-system, system-ui, sans-serif'
    ctx.textAlign = 'left'
    ctx.fillText('Shared screen — Pico', 64, 110)
    ctx.fillStyle = 'rgba(255,255,255,0.35)'
    ctx.font = '500 22px Manrope, sans-serif'
    for (let i = 0; i < 4; i++) {
      ctx.fillRect(64, 170 + i * 44, 460 - i * 60, 14)
    }
    const w = 300 + Math.sin(t * 1.4) * 150
    ctx.fillStyle = '#30d158'
    ctx.fillRect(64, 420, w, 18)
    ctx.fillStyle = 'rgba(255,255,255,0.55)'
    ctx.font = '500 18px Geist Mono, monospace'
    ctx.fillText(new Date().toLocaleTimeString(), 64, 490)
  }
  draw()
  const timer = window.setInterval(draw, 100)
  const stream = canvas.captureStream(10)
  ;(stream as MediaStream & { __stop?: () => void }).__stop = () => {
    window.clearInterval(timer)
  }
  // Small delay so the caller's spinner state is realistic
  await new Promise((r) => setTimeout(r, 150))
  return stream
}
