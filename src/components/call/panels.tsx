'use client'

import { useEffect, useRef, useState } from 'react'
import {
  ArrowUp,
  CameraOff,
  Check,
  Copy,
  Link2,
  MicOff,
  MonitorUp,
  Users,
  X,
} from 'lucide-react'
import { useCallStore } from '@/lib/call/store'
import { getEngine } from '@/lib/call/engine'
import { type QualityPreset } from '@/lib/call/types'
import { NetworkBars, LEVEL_LABEL } from './network-bars'

/* ------------------------------------------------------------------ */
/* Shared sheet shell                                                   */
/* ------------------------------------------------------------------ */

function Sheet({
  title,
  onClose,
  children,
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
}) {
  return (
    <aside
      className="pico-slide-up fixed inset-x-0 bottom-0 z-40 flex h-[68vh] flex-col rounded-t-3xl border border-black/[0.06] bg-white/95 shadow-[0_-8px_40px_rgba(0,0,0,0.12)] backdrop-blur-xl sm:inset-y-0 sm:left-auto sm:right-4 sm:top-4 sm:bottom-24 sm:h-auto sm:w-[360px] sm:rounded-3xl"
      role="dialog"
      aria-label={title}
    >
      <header className="flex items-center justify-between border-b border-black/[0.05] px-5 py-3.5">
        <h2 className="text-[15px] font-semibold text-[#1c1c1e]">{title}</h2>
        <button
          onClick={onClose}
          aria-label={`Close ${title}`}
          className="flex h-7 w-7 items-center justify-center rounded-full bg-[#f2f2f7] text-[#86868b] transition-colors hover:bg-[#e5e5ea]"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </header>
      {children}
    </aside>
  )
}

/* ------------------------------------------------------------------ */
/* Chat                                                                 */
/* ------------------------------------------------------------------ */

export function ChatPanel({ onClose }: { onClose: () => void }) {
  const chat = useCallStore((s) => s.chat)
  const selfId = useCallStore((s) => s.self.id)
  const [draft, setDraft] = useState('')
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [chat.length])

  const send = () => {
    const text = draft.trim()
    if (!text) return
    getEngine().sendChat(text)
    setDraft('')
  }

  return (
    <Sheet title="Chat" onClose={onClose}>
      <div ref={listRef} className="ios-scroll flex-1 space-y-2.5 overflow-y-auto px-4 py-4">
        {chat.length === 0 && (
          <p className="mt-10 text-center text-[13px] text-[#aeaeb2]">Messages appear here</p>
        )}
        {chat.map((m) =>
          m.system ? (
            <p key={m.id} className="text-center text-[11px] font-medium text-[#aeaeb2]">
              {m.text}
            </p>
          ) : m.from === selfId ? (
            <div key={m.id} className="flex justify-end">
              <div className="max-w-[80%] rounded-2xl rounded-br-md bg-[#34c759] px-3.5 py-2">
                <p className="whitespace-pre-wrap break-words text-[13.5px] leading-snug text-white">{m.text}</p>
                <p className="mt-0.5 text-right text-[10px] text-white/70">
                  {new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </p>
              </div>
            </div>
          ) : (
            <div key={m.id} className="flex justify-start">
              <div className="max-w-[80%] rounded-2xl rounded-bl-md bg-[#f2f2f7] px-3.5 py-2">
                <p className="text-[11px] font-semibold text-[#86868b]">{m.name}</p>
                <p className="mt-0.5 whitespace-pre-wrap break-words text-[13.5px] leading-snug text-[#1c1c1e]">
                  {m.text}
                </p>
                <p className="mt-0.5 text-[10px] text-[#aeaeb2]">
                  {new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </p>
              </div>
            </div>
          ),
        )}
      </div>
      <footer className="safe-bottom border-t border-black/[0.05] p-3">
        <div className="flex items-center gap-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
            placeholder="Message"
            aria-label="Chat message"
            maxLength={500}
            className="h-10 flex-1 rounded-full border border-black/[0.06] bg-[#f2f2f7] px-4 text-[14px] text-[#1c1c1e] outline-none placeholder:text-[#aeaeb2] focus:border-black/[0.14]"
          />
          <button
            onClick={send}
            disabled={!draft.trim()}
            aria-label="Send message"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#1c1c1e] text-white transition-all duration-150 active:scale-90 disabled:bg-[#e5e5ea] disabled:text-[#aeaeb2]"
          >
            <ArrowUp className="h-4.5 w-4.5" />
          </button>
        </div>
      </footer>
    </Sheet>
  )
}

/* ------------------------------------------------------------------ */
/* Participants                                                         */
/* ------------------------------------------------------------------ */

export function ParticipantsPanel({ onClose, roomCode }: { onClose: () => void; roomCode: string }) {
  const self = useCallStore((s) => s.self)
  const peers = useCallStore((s) => s.peers)
  const [copied, setCopied] = useState(false)

  const inviteLink = typeof window !== 'undefined' ? `${window.location.origin}/?room=${roomCode}` : ''

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(inviteLink)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = inviteLink
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      ta.remove()
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }

  const everyone = [
    {
      id: self.id || 'self',
      name: self.name || 'You',
      micOn: self.micOn,
      camOn: self.camOn,
      sharing: self.sharing,
      isSelf: true,
    },
    ...Object.values(peers).map((p) => ({
      id: p.id,
      name: p.name,
      micOn: p.micOn,
      camOn: p.camOn,
      sharing: p.sharing,
      isSelf: false,
    })),
  ]

  return (
    <Sheet title={`People · ${everyone.length}`} onClose={onClose}>
      <div className="border-b border-black/[0.05] p-3">
        <button
          onClick={copy}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#f2f2f7] py-2.5 text-[14px] font-semibold text-[#1c1c1e] transition-all active:scale-[0.98]"
        >
          {copied ? <Check className="h-4 w-4 text-[#34c759]" /> : <Link2 className="h-4 w-4 text-[#86868b]" />}
          {copied ? 'Link copied' : 'Copy invite link'}
        </button>
        <p className="mt-2 text-center text-[11px] font-medium tracking-wide text-[#aeaeb2]">
          {roomCode}
        </p>
      </div>
      <ul className="ios-scroll flex-1 overflow-y-auto p-2">
        {everyone.map((p) => (
          <li key={p.id} className="flex items-center gap-3 rounded-xl px-3 py-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[#e5e5ea] text-[12px] font-semibold text-[#6e6e73]">
              {p.name.slice(0, 2).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[14px] font-medium text-[#1c1c1e]">
                {p.name}
                {p.isSelf ? ' (You)' : ''}
              </p>
              <p className="text-[11px] text-[#aeaeb2]">
                {p.sharing ? 'Sharing screen' : p.camOn ? 'Camera on' : 'Camera off'}
              </p>
            </div>
            <div className="flex items-center gap-1.5 text-[#86868b]">
              {!p.micOn && <MicOff className="h-4 w-4 text-[#ff3b30]" aria-label="Muted" />}
              {!p.camOn && !p.sharing && <CameraOff className="h-4 w-4" aria-label="Camera off" />}
              {p.sharing && <MonitorUp className="h-4 w-4 text-[#34c759]" aria-label="Sharing" />}
            </div>
          </li>
        ))}
      </ul>
      <footer className="border-t border-black/[0.05] px-4 py-3 text-center text-[11px] text-[#aeaeb2]">
        <Users className="mr-1 inline h-3 w-3" /> Peer-to-peer · up to 8 people
      </footer>
    </Sheet>
  )
}

/* ------------------------------------------------------------------ */
/* Quality                                                              */
/* ------------------------------------------------------------------ */

const PRESET_OPTIONS: Array<{ key: QualityPreset; label: string; hint: string }> = [
  { key: 'auto', label: 'Auto', hint: 'Adapts to your network' },
  { key: 'saver', label: 'Data Saver', hint: '~90 kbps · 144p · 2G-ready' },
  { key: 'balanced', label: 'Balanced', hint: '~200 kbps · 360p' },
  { key: 'sharp', label: 'Sharp', hint: '~550 kbps · 480p' },
]

export function QualityPanel({ onClose }: { onClose: () => void }) {
  const preset = useCallStore((s) => s.preset)
  const effective = useCallStore((s) => s.effectiveLabel)
  const bitrate = useCallStore((s) => s.bitrateKbps)
  const overall = useCallStore((s) => s.overallLevel)
  const [pending, setPending] = useState<QualityPreset | null>(null)

  const choose = async (p: QualityPreset) => {
    setPending(p)
    try {
      await getEngine().setPreset(p)
    } finally {
      setPending(null)
    }
  }

  return (
    <Sheet title="Video quality" onClose={onClose}>
      <div className="ios-scroll flex-1 overflow-y-auto p-4">
        <div className="mb-4 flex items-center justify-between rounded-2xl bg-[#f2f2f7] px-4 py-3">
          <div>
            <p className="text-[13px] font-semibold text-[#1c1c1e]">{effective || 'Auto'}</p>
            <p className="text-[11px] text-[#86868b]">Sending ~{bitrate} kbps</p>
          </div>
          <div className="flex items-center gap-2">
            <NetworkBars level={overall} size="md" />
            <span className="text-[11px] text-[#86868b]">{LEVEL_LABEL[overall]}</span>
          </div>
        </div>

        <div className="overflow-hidden rounded-2xl border border-black/[0.05]">
          {PRESET_OPTIONS.map((opt, i) => (
            <button
              key={opt.key}
              onClick={() => void choose(opt.key)}
              disabled={pending !== null}
              className={`flex w-full items-center justify-between px-4 py-3 text-left transition-colors hover:bg-[#f7f7f9] ${
                i > 0 ? 'border-t border-black/[0.05]' : ''
              }`}
            >
              <span>
                <span className="block text-[14px] font-medium text-[#1c1c1e]">{opt.label}</span>
                <span className="block text-[11px] text-[#86868b]">{opt.hint}</span>
              </span>
              {preset === opt.key && <Check className="h-4 w-4 text-[#34c759]" />}
            </button>
          ))}
        </div>

        <p className="mt-4 px-1 text-[11px] leading-relaxed text-[#aeaeb2]">
          Pico sends every stream directly to the other person — nothing is uploaded to a server.
          Audio uses Opus DTX, so silence costs almost nothing.
        </p>
      </div>
    </Sheet>
  )
}
