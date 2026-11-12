'use client'

import { useEffect, useRef, useState } from 'react'
import {
  ArrowUp,
  CameraOff,
  Check,
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
      className="pico-sheet-up fixed inset-x-0 bottom-0 z-40 flex h-[68vh] flex-col rounded-t-[24px] border border-black/[0.05] bg-white/95 shadow-[0_-8px_40px_rgba(0,0,0,0.10)] backdrop-blur-xl sm:inset-y-0 sm:left-auto sm:right-4 sm:top-4 sm:bottom-24 sm:h-auto sm:w-[360px] sm:rounded-[24px]"
      role="dialog"
      aria-label={title}
    >
      <header className="flex items-center justify-between border-b border-black/[0.05] px-5 py-3.5">
        <h2 className="text-[15px] font-bold tracking-[-0.01em] text-[#0d0d0f]">{title}</h2>
        <button onClick={onClose} aria-label={`Close ${title}`} className="ios-square">
          <X className="h-3.5 w-3.5" strokeWidth={2.6} />
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
          <p className="mt-10 text-center text-[13px] font-medium text-[#a9a9b0]">Messages appear here</p>
        )}
        {chat.map((m) =>
          m.system ? (
            <p key={m.id} className="text-center text-[11px] font-semibold uppercase tracking-[0.06em] text-[#a9a9b0]">
              {m.text}
            </p>
          ) : m.from === selfId ? (
            <div key={m.id} className="flex justify-end">
              <div className="max-w-[80%] rounded-[18px] rounded-br-[6px] bg-[#0d0d0f] px-3.5 py-2">
                <p className="whitespace-pre-wrap break-words text-[13px] leading-snug text-white">{m.text}</p>
                <p className="mt-0.5 text-right text-[10px] font-medium text-white/55">
                  {new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </p>
              </div>
            </div>
          ) : (
            <div key={m.id} className="flex justify-start">
              <div className="max-w-[80%] rounded-[18px] rounded-bl-[6px] bg-[#f5f5f7] px-3.5 py-2">
                <p className="text-[11px] font-bold text-[#7c7c82]">{m.name}</p>
                <p className="mt-0.5 whitespace-pre-wrap break-words text-[13px] leading-snug text-[#0d0d0f]">
                  {m.text}
                </p>
                <p className="mt-0.5 text-[10px] font-medium text-[#a9a9b0]">
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
            className="ios-field h-10 flex-1 rounded-full"
          />
          <button
            onClick={send}
            disabled={!draft.trim()}
            aria-label="Send message"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#0d0d0f] text-white transition-all duration-[130ms] ease-[cubic-bezier(0.34,1.35,0.64,1)] hover:bg-[#26262b] active:scale-90 disabled:bg-[#e8e8ed] disabled:text-[#a9a9b0]"
          >
            <ArrowUp className="h-4 w-4" strokeWidth={2.6} />
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
        <button onClick={copy} className="ios-pill-soft h-10 w-full text-[13px]">
          {copied ? <Check className="h-4 w-4 text-[#30d158]" strokeWidth={2.6} /> : <Link2 className="h-4 w-4 text-[#7c7c82]" strokeWidth={2.2} />}
          {copied ? 'Link copied' : 'Copy invite link'}
        </button>
        <p className="mt-2 text-center font-mono text-[11px] font-medium tracking-wide text-[#a9a9b0]">
          {roomCode}
        </p>
      </div>
      <ul className="ios-scroll flex-1 overflow-y-auto p-2">
        {everyone.map((p) => (
          <li key={p.id} className="flex items-center gap-3 rounded-2xl px-3 py-2.5">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#e8e8ed] text-[12px] font-bold text-[#7c7c82]">
              {p.name.slice(0, 2).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[15px] font-semibold text-[#0d0d0f]">
                {p.name}
                {p.isSelf ? ' (You)' : ''}
              </p>
              <p className="text-[12px] font-medium text-[#a9a9b0]">
                {p.sharing ? 'Sharing screen' : p.camOn ? 'Camera on' : 'Camera off'}
              </p>
            </div>
            <div className="flex items-center gap-1.5 text-[#7c7c82]">
              {!p.micOn && <MicOff className="h-4 w-4 text-[#ff3b30]" aria-label="Muted" strokeWidth={2.4} />}
              {!p.camOn && !p.sharing && <CameraOff className="h-4 w-4" aria-label="Camera off" strokeWidth={2.4} />}
              {p.sharing && <MonitorUp className="h-4 w-4 text-[#30d158]" aria-label="Sharing" strokeWidth={2.4} />}
            </div>
          </li>
        ))}
      </ul>
      <footer className="border-t border-black/[0.05] px-4 py-3 text-center text-[12px] font-medium text-[#a9a9b0]">
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
        <div className="mb-4 flex items-center justify-between rounded-[18px] bg-[#f5f5f7] px-4 py-3">
          <div>
            <p className="text-[15px] font-bold text-[#0d0d0f]">{effective || 'Auto'}</p>
            <p className="text-[12px] font-medium tabular-nums text-[#7c7c82]">Sending ~{bitrate} kbps</p>
          </div>
          <div className="flex items-center gap-2">
            <NetworkBars level={overall} size="md" />
            <span className="text-[12px] font-medium text-[#7c7c82]">{LEVEL_LABEL[overall]}</span>
          </div>
        </div>

        <div className="overflow-hidden rounded-[18px] border border-black/[0.05]">
          {PRESET_OPTIONS.map((opt, i) => (
            <button
              key={opt.key}
              onClick={() => void choose(opt.key)}
              disabled={pending !== null}
              className={`flex w-full items-center justify-between px-4 py-3 text-left transition-colors duration-150 hover:bg-[#f7f7f9] active:bg-[#f0f0f4] ${
                i > 0 ? 'border-t border-black/[0.05]' : ''
              }`}
            >
              <span>
                <span className="block text-[15px] font-semibold text-[#0d0d0f]">{opt.label}</span>
                <span className="block text-[12px] font-medium text-[#7c7c82]">{opt.hint}</span>
              </span>
              {preset === opt.key && <Check className="h-4 w-4 shrink-0 text-[#30d158]" strokeWidth={2.8} />}
            </button>
          ))}
        </div>

        <p className="mt-4 px-1 text-[12px] leading-relaxed text-[#a9a9b0]">
          Pico sends every stream directly to the other person — nothing is uploaded to a server.
          Audio uses Opus DTX, so silence costs almost nothing.
        </p>
      </div>
    </Sheet>
  )
}
