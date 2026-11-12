'use client'

import { useEffect, useRef } from 'react'
import { subscribeLevel } from '@/lib/call/audio-levels'

/**
 * The Pico mark — an ink tile with a live waveform. The bars sway on a slow
 * loop (pausable via `animate={false}` for tiny sizes).
 */
export function BrandMark({
  size = 72,
  animate = true,
  radius,
}: {
  size?: number
  animate?: boolean
  radius?: number
}) {
  const bars = [0.42, 0.66, 1, 0.7, 0.44]
  return (
    <div
      className="flex items-center justify-center gap-[8%] bg-[#0d0d0f]"
      style={{
        width: size,
        height: size,
        borderRadius: radius ?? size * 0.29,
        boxShadow: '0 1px 2px rgba(0,0,0,0.12)',
      }}
      aria-label="Pico"
      role="img"
    >
      {bars.map((h, i) => (
        <span
          key={i}
          className={animate ? 'pico-wave-bar' : ''}
          style={{
            width: Math.max(3, size * 0.062),
            height: `${h * 46}%`,
            borderRadius: 999,
            background: i === 2 ? '#30d158' : 'rgba(255,255,255,0.94)',
            animationDelay: animate ? `${i * 110}ms` : undefined,
          }}
        />
      ))}
    </div>
  )
}

/**
 * Three tiny bars that dance with a peer's real voice level.
 * Updates the DOM directly — React never re-renders for audio.
 */
export function VoiceBars({ peerId, muted }: { peerId: string; muted?: boolean }) {
  const ref = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const setAll = (v: number) => {
      const bars = ref.current?.children
      if (!bars) return
      for (let i = 0; i < bars.length; i++) {
        ;(bars[i] as HTMLElement).style.transform = `scaleY(${v})`
      }
    }
    if (muted) {
      setAll(0.25)
      return
    }
    return subscribeLevel(peerId, (level) => {
      const bars = ref.current?.children
      if (!bars) return
      const v = Math.min(1, level * 1.5)
      // Inner bar reacts strongest, like a mini equalizer.
      const shape = [0.55 + v * 0.45, 0.45 + v * 0.55, 0.55 + v * 0.45]
      for (let i = 0; i < bars.length; i++) {
        ;(bars[i] as HTMLElement).style.transform = `scaleY(${shape[i].toFixed(3)})`
      }
    })
  }, [peerId, muted])

  return (
    <span ref={ref} className="flex h-3 items-center gap-[2px]" aria-hidden>
      <span className="voice-bar" />
      <span className="voice-bar" />
      <span className="voice-bar" />
    </span>
  )
}

/**
 * Imperatively toggles `.speaking-ring` on the returned element while the
 * peer is talking. Zero re-renders.
 */
export function useSpeakingRing(peerId: string, active: boolean) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el || !active) {
      el?.classList.remove('speaking-ring', 'speaking-ring-soft')
      return
    }
    return subscribeLevel(peerId, (level) => {
      ref.current?.classList.toggle('speaking-ring', level > 0.14)
    })
  }, [peerId, active])
  return ref
}

/** Soft variant for round control buttons. */
export function useSpeakingRingSoft(peerId: string, active: boolean) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el || !active) {
      el?.classList.remove('speaking-ring-soft', 'speaking-ring')
      return
    }
    return subscribeLevel(peerId, (level) => {
      ref.current?.classList.toggle('speaking-ring-soft', level > 0.14)
    })
  }, [peerId, active])
  return ref
}
