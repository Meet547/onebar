'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowRight, Video, WifiHigh, Zap, ShieldCheck } from 'lucide-react'
import { generateRoomCode } from '@/lib/call/types'

const FEATURES = [
  { icon: Zap, label: 'Peer-to-peer, no servers' },
  { icon: WifiHigh, label: 'Runs on 90 kbps' },
  { icon: ShieldCheck, label: 'Nothing recorded' },
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
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-6 py-12">
        {/* Brand */}
        <div className="pico-slide-up mb-10 text-center">
          <div className="mx-auto mb-5 flex h-[72px] w-[72px] items-center justify-center rounded-[22px] bg-[#1c1c1e] shadow-[0_10px_30px_rgba(0,0,0,0.18)]">
            <Video className="h-8 w-8 text-white" strokeWidth={2.2} />
          </div>
          <h1 className="text-[34px] font-bold tracking-tight text-[#1c1c1e]">Pico</h1>
          <p className="mt-1.5 text-[15px] leading-relaxed text-[#86868b]">
            Video calls that sip, not gulp.
            <br />
            Featherlight on your data, battery and CPU.
          </p>
        </div>

        {/* Actions */}
        <div className="pico-slide-up space-y-3" style={{ animationDelay: '60ms' }}>
          {error && (
            <div
              role="alert"
              className="mb-1 flex items-center justify-between gap-2 rounded-2xl bg-[#ff3b30]/[0.08] px-4 py-3"
            >
              <p className="text-[13px] font-medium text-[#ff3b30]">
                Could not start the call. Please check your connection and try again.
              </p>
              <button
                onClick={onDismissError}
                aria-label="Dismiss error"
                className="shrink-0 text-[13px] font-semibold text-[#ff3b30]/70"
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
            placeholder="Your name"
            maxLength={24}
            className="h-12 w-full rounded-2xl border border-black/[0.06] bg-[#f2f2f7] px-4 text-[15px] text-[#1c1c1e] outline-none transition-colors placeholder:text-[#aeaeb2] focus:border-black/[0.16] focus:bg-white"
          />
          <button
            onClick={start}
            className="ios-pill w-full bg-[#34c759] text-white shadow-[0_6px_20px_rgba(52,199,89,0.35)]"
          >
            Start a new call
          </button>

          <div className="flex items-center gap-3 py-1">
            <span className="h-px flex-1 bg-[#e5e5ea]" />
            <span className="text-[12px] font-medium text-[#aeaeb2]">or join with a code</span>
            <span className="h-px flex-1 bg-[#e5e5ea]" />
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
              className="h-12 min-w-0 flex-1 rounded-2xl border border-black/[0.06] bg-[#f2f2f7] px-4 font-mono text-[15px] lowercase text-[#1c1c1e] outline-none transition-colors placeholder:text-[#aeaeb2] focus:border-black/[0.16] focus:bg-white"
            />
            <button
              onClick={joinByCode}
              disabled={code.trim().length < 4}
              aria-label="Join call with code"
              className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-[#1c1c1e] text-white transition-all active:scale-90 disabled:bg-[#e5e5ea] disabled:text-[#aeaeb2]"
            >
              <ArrowRight className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* Feature strip */}
        <div className="pico-slide-up mt-10 flex justify-center gap-2" style={{ animationDelay: '120ms' }}>
          {FEATURES.map((f) => (
            <div
              key={f.label}
              className="flex items-center gap-1.5 rounded-full border border-black/[0.05] bg-white px-3 py-1.5 shadow-[0_1px_3px_rgba(0,0,0,0.04)]"
            >
              <f.icon className="h-3.5 w-3.5 text-[#34c759]" />
              <span className="text-[11px] font-medium text-[#86868b]">{f.label}</span>
            </div>
          ))}
        </div>
      </main>

      <footer className="pb-6 text-center">
        <p className="text-[11px] text-[#aeaeb2]">
          No accounts · No downloads · Streams go device-to-device
          <br />
          Up to 8 people per call
        </p>
      </footer>
    </div>
  )
}
