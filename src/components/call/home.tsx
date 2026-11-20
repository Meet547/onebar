'use client'

import { readDisplayName, saveDisplayName } from '@/lib/call/preferences'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ShieldAlert, ArrowRight, Lock, ShieldCheck, SignalHigh, Zap } from 'lucide-react'
import { generateRoomCode } from '@/lib/call/types'
import { BrandMark } from './brand'

const FEATURES = [
  { icon: Zap, label: 'Peer-to-peer media' },
  { icon: SignalHigh, label: 'Runs on one bar' },
  { icon: ShieldCheck, label: 'Encrypted, nothing saved' },
]

export function Home({
  onCreate,
  error,
  notice,
  onDismissError,
}: {
  onCreate: (passcode: string) => void
  error?: boolean
  notice?: string
  onDismissError?: () => void
}) {
  const router = useRouter()
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [passcode, setPasscode] = useState('')
  const [wantPasscode, setWantPasscode] = useState(false)
  const [insecure, setInsecure] = useState(false)
  const [codeError, setCodeError] = useState('')

  useEffect(() => {
    // Cameras and microphones only open on secure origins — tell people early
    // instead of letting them wonder why the preview stays empty.
    const t = window.setTimeout(() => {
      setName(readDisplayName())
      setInsecure(!window.isSecureContext)
    }, 0)
    return () => window.clearTimeout(t)
  }, [])

  const start = () => {
    const clean = name.trim() || 'Guest'
    saveDisplayName(clean)
    onCreate(passcode.trim())
  }

  const joinByCode = () => {
    const clean = code.trim().toLowerCase().replace(/[^a-z0-9-]/g, '')
    if (clean.length < 4) {
      setCodeError('Enter at least 4 letters or numbers to join.')
      return
    }
    setCodeError('')
    router.push(`/?room=${encodeURIComponent(clean)}`)
  }

  return (
    <div className="pico-home flex min-h-[100dvh] flex-col px-4 py-5 sm:px-6 sm:py-8">
      <main className="mx-auto flex w-full max-w-[480px] flex-1 flex-col justify-center">
        <section className="pico-home-card p-5 sm:p-8">
        {/* Brand */}
        <div className="pico-rise mb-7 text-center sm:mb-8">
          <div className="mb-5 flex justify-center sm:mb-6">
            <BrandMark size={68} />
          </div>
          <h1 className="text-[34px] font-extrabold leading-[1.04] tracking-[-0.045em] text-[#0d0d0f] sm:text-[38px]">
            Calls that weigh
            <br />
            nothing.
          </h1>
          <p className="mx-auto mt-3 max-w-[330px] text-[15px] leading-[1.6] text-[#62626a]">
            Private video calls built to keep working when your signal drops to one bar.
          </p>
        </div>

        {/* Actions */}
        <div className="pico-rise space-y-3" style={{ animationDelay: '80ms' }}>
          {insecure && (
            <div
              role="alert"
              className="pico-pop mb-1 flex items-start gap-2.5 rounded-md bg-[#ff9500]/[0.08] px-4 py-3"
            >
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-[#ff9500]" strokeWidth={2.4} />
              <p className="text-[13px] font-semibold leading-snug text-[#b26a00]">
                This page is not on HTTPS — cameras and microphones are blocked
                here. Open Pico over HTTPS to make calls.
              </p>
            </div>
          )}
          {error && (
            <div
              role="alert"
              className="pico-pop mb-1 flex items-center justify-between gap-3 rounded-md bg-[#d62f25]/[0.07] px-4 py-3"
            >
              <p className="text-[13px] font-semibold leading-snug text-[#c52d25]">
                Could not start the call. Check your connection and try again.
              </p>
              <button
                onClick={onDismissError}
                aria-label="Dismiss error"
                className="press shrink-0 text-[12px] font-bold uppercase tracking-wide text-[#c52d25]/70"
              >
                Dismiss
              </button>
            </div>
          )}
          {notice && (
            <div
              role="alert"
              className="pico-pop mb-1 flex items-center justify-between gap-3 rounded-md bg-[#d62f25]/[0.07] px-4 py-3"
            >
              <p className="text-[13px] font-semibold leading-snug text-[#c52d25]">{notice}</p>
              <button
                onClick={onDismissError}
                aria-label="Dismiss notice"
                className="press shrink-0 text-[12px] font-bold uppercase tracking-wide text-[#c52d25]/70"
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

          {/* Optional passcode */}
          {wantPasscode ? (
            <div className="pico-pop">
              <div className="flex gap-2">
                <input
                  value={passcode}
                  onChange={(e) => setPasscode(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && start()}
                  placeholder="Passcode (optional)"
                  aria-label="Room passcode"
                  maxLength={24}
                  autoComplete="new-password"
                  className="ios-field min-w-0 flex-1"
                />
                <button
                  onClick={() => {
                    setWantPasscode(false)
                    setPasscode('')
                  }}
                  aria-label="Remove passcode"
                  className="press flex h-12 w-12 shrink-0 items-center justify-center rounded-md bg-[#f5f5f7] text-[#62626a] active:scale-90"
                >
                  <Lock className="h-4 w-4" strokeWidth={2.2} />
                </button>
              </div>
              <p className="mt-1.5 px-1 text-[12px] font-medium leading-relaxed text-[#62626a]">
                Only people with the passcode can join. Leave empty for an open room.
              </p>
            </div>
          ) : (
            <button
              onClick={() => setWantPasscode(true)}
              className="press mx-auto flex items-center gap-1.5 text-[13px] font-semibold text-[#62626a]"
            >
              <Lock className="h-3.5 w-3.5" strokeWidth={2.4} />
              Add a passcode
            </button>
          )}

          <button onClick={start} className="ios-pill w-full">
            Start a call
          </button>

          <div className="flex items-center gap-3 py-1.5">
              <span className="h-px flex-1 bg-black/[0.10]" />
            <span className="text-[12px] font-semibold uppercase tracking-[0.08em] text-[#62626a]">
              or join with a code
            </span>
            <span className="h-px flex-1 bg-black/[0.10]" />
          </div>

          <div>
            <label htmlFor="meeting-code" className="mb-1.5 block px-1 text-[12px] font-bold uppercase tracking-[0.08em] text-[#62626a]">
              Meeting code
            </label>
          <div className="flex gap-2">
            <input
              id="meeting-code"
              value={code}
              onChange={(e) => {
                setCode(e.target.value)
                if (codeError) setCodeError('')
              }}
              onKeyDown={(e) => e.key === 'Enter' && joinByCode()}
              placeholder="abc-def-ghi"
              aria-describedby="meeting-code-hint"
              aria-invalid={Boolean(codeError)}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className="ios-field min-w-0 flex-1 font-mono text-[15px] lowercase"
            />
            <button
              onClick={joinByCode}
              aria-label="Join call"
              className="flex h-12 shrink-0 items-center justify-center gap-1.5 rounded-md bg-[#0d0d0f] px-3 text-white transition-all duration-[130ms] ease-[cubic-bezier(0.22,1,0.36,1)] hover:bg-[#26262b] active:scale-90"
            >
              <ArrowRight className="h-5 w-5" strokeWidth={2.4} />
              <span className="text-[13px] font-bold">Join</span>
            </button>
          </div>
            <p id="meeting-code-hint" aria-live="polite" className={`mt-1.5 px-1 text-[12px] font-medium ${codeError ? 'text-[#c52d25]' : 'text-[#62626a]'}`}>
              {codeError || 'Enter the code shared by your host.'}
            </p>
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
              className="flex items-center gap-1.5 rounded-md bg-[#f5f5f7] px-3.5 py-2"
            >
              <f.icon className="h-3.5 w-3.5 text-[#0d0d0f]" strokeWidth={2.4} />
              <span className="text-[12px] font-semibold text-[#3c3c43]">{f.label}</span>
            </div>
          ))}
        </div>
        </section>
      </main>

      <footer className="mx-auto pb-2 pt-5 text-center sm:pt-6">
        <p className="text-[12px] font-medium text-[#62626a]">
          No accounts · No downloads · Encrypted media
          <br />
          Up to 10 people per call
        </p>
      </footer>
    </div>
  )
}
