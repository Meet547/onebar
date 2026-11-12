'use client'

/**
 * Synthetic camera+mic used when `?test=1` is present or no capture devices
 * exist. Renders an animated scene on a canvas and captures it — lets the
 * whole pipeline (preview, tiles, WebRTC encoding) be exercised anywhere.
 */
export async function createTestStream(): Promise<MediaStream> {
  const canvas = document.createElement('canvas')
  canvas.width = 640
  canvas.height = 360
  const ctx = canvas.getContext('2d')!
  let hue = 210
  const draw = () => {
    hue = (hue + 1.2) % 360
    const grad = ctx.createLinearGradient(0, 0, canvas.width, canvas.height)
    grad.addColorStop(0, `hsl(${hue}, 55%, 93%)`)
    grad.addColorStop(1, `hsl(${(hue + 60) % 360}, 50%, 80%)`)
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    const t = Date.now() / 300
    const x = canvas.width / 2 + Math.sin(t) * 140
    const y = canvas.height / 2 + Math.cos(t * 0.8) * 70
    ctx.fillStyle = `hsl(${(hue + 120) % 360}, 45%, 42%)`
    ctx.beginPath()
    ctx.arc(x, y, 26, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = 'rgba(28,28,30,0.85)'
    ctx.font = '600 20px -apple-system, system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText('Pico test stream', canvas.width / 2, 44)
    ctx.fillText(new Date().toLocaleTimeString(), canvas.width / 2, canvas.height - 30)
  }
  draw()
  const timer = window.setInterval(draw, 80)
  const stream = canvas.captureStream(12)

  // Silent audio track keeps audio transceivers realistic without any noise
  let audioCtx: AudioContext | null = null
  try {
    audioCtx = new AudioContext()
    const osc = audioCtx.createOscillator()
    const gain = audioCtx.createGain()
    gain.gain.value = 0
    const dest = audioCtx.createMediaStreamDestination()
    osc.connect(gain)
    gain.connect(dest)
    osc.start()
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
