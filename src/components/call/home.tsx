'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowRight, ShieldCheck, SignalHigh, Zap } from 'lucide-react'
import { generateRoomCode } from '@/lib/call/types'
import { BrandMark } from './brand'

const FEATURES = [
  { icon: Zap, label: 'Peer-to-peer · no servers' },
  { icon: SignalHigh, label: 'Runs on one bar' },
  { icon: ShieldCheck, label: 'Encrypted, nothing saved' },
]

export function Home({
  onCreate,
  error,
  onDismissError,
}: {
  onCreate: () => void
  error?: boolean
  onDismissError?: () => void
}) {
  const router = useRouter()
  const [name, setName] = useState('')
  const [code, setCode] = useState('')

  useEffect(() => {
    const t = window.setTimeout(() => setName(window.localStorage.getItem('pico-name') ?? ''), 0)
    return () => window.clearTimeout(t)
  }, [])

  const start = () => {
    const clean = name.trim() || 'Guest'
    window.localStorage.setItem('pico-name', clean)
    onCreate()
  }

  const joinByCode = () => {
    const clean = code.trim().toLowerCase().replace(/[^a-z0-9-]/g, '')
    if (clean.length < 4) return
    router.push(`/?room=${encodeURIComponent(clean)}`)
  }

  return (
    <div className="flex min-h-[100dvh] flex-col bg-white">
      <main className="mx-auto flex w-full max-w-[400px] flex-1 flex-col justify-center px-6 py-12">
        {/* Brand */}
        <div className="pico-rise mb-10 text-center">
          <div className="mb-6 flex justify-center">
            <BrandMark size={76} />
          </div>
          <h1 className="text-[32px] font-extrabold leading-tight tracking-[-0.03em] text-[#0d0d0f]">
            Calls that weigh
            <br />
            nothing.
          </h1>
          <p className="mx-auto mt-3 max-w-[300px] text-[15px] leading-relaxed text-[#7c7c82]">
            Peer-to-peer video calling, tuned to run on a single bar of signal.
          </p>
        </div>

        {/* Actions */}
        <div className="pico-rise space-y-3" style={{ animationDelay: '80ms' }}>
          {error && (
            <div
              role="alert"
              className="pico-pop mb-1 flex items-center justify-between gap-3 rounded-2xl bg-[#ff3b30]/[0.07] px-4 py-3"
            >
              <p className="text-[13px] font-semibold leading-snug text-[#ff3b30]">
                Could not start the call. Check your connection and try again.
              </p>
              <button
                onClick={onDismissError}
                aria-label="Dismiss error"
                className="press shrink-0 text-[12px] font-bold uppercase tracking-wide text-[#ff3b30]/70"
              >
                Dismiss
              </button>
            </div>
          )}
          <label htmlFor="home-name" className="sr-only">
            Your name
          </label>
          <input
            id="home-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && start()}
            placeholder="Your name"
            maxLength={24}
            className="ios-field"
          />
          <button onClick={start} className="ios-pill w-full">
            Start a call
          </button>

          <div className="flex items-center gap-3 py-1.5">
            <span className="h-px flex-1 bg-[#e8e8ed]" />
            <span className="text-[12px] font-semibold uppercase tracking-[0.08em] text-[#a9a9b0]">
              or join with a code
            </span>
            <span className="h-px flex-1 bg-[#e8e8ed]" />
          </div>

          <div className="flex gap-2">
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && joinByCode()}
              placeholder="abc-def-ghi"
              aria-label="Meeting code"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className="ios-field min-w-0 flex-1 font-mono text-[15px] lowercase"
            />
            <button
              onClick={joinByCode}
              disabled={code.trim().length < 4}
              aria-label="Join call with code"
              className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-[#0d0d0f] text-white transition-all duration-[130ms] ease-[cubic-bezier(0.34,1.35,0.64,1)] hover:bg-[#26262b] active:scale-90 disabled:bg-[#e8e8ed] disabled:text-[#a9a9b0]"
            >
              <ArrowRight className="h-5 w-5" strokeWidth={2.4} />
            </button>
          </div>
        </div>

        {/* Feature strip */}
        <div
          className="pico-rise mt-10 flex flex-wrap justify-center gap-2"
          style={{ animationDelay: '160ms' }}
        >
          {FEATURES.map((f) => (
            <div
              key={f.label}
              className="flex items-center gap-1.5 rounded-full bg-[#f5f5f7] px-3.5 py-2"
            >
              <f.icon className="h-3.5 w-3.5 text-[#0d0d0f]" strokeWidth={2.4} />
              <span className="text-[12px] font-semibold text-[#3c3c43]">{f.label}</span>
            </div>
          ))}
        </div>
      </main>

      <footer className="pb-8 text-center">
        <p className="text-[12px] font-medium text-[#a9a9b0]">
          No accounts · No downloads · Streams go device-to-device
          <br />
          Up to 8 people per call
        </p>
      </footer>
    </div>
  )
}
