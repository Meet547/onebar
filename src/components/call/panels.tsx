'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowUp,
  CameraOff,
  Check,
  Crown,
  EyeOff,
  FileAudio,
  KeyRound,
  Link2,
  Lock,
  LockOpen,
  MessageSquareLock,
  Mic,
  MicOff,
  MonitorUp,
  Music2,
  Pause,
  Play,
  Radio,
  Reply,
  ServerOff,
  ShieldCheck,
  Smile,
  Square,
  UserMinus,
  Users,
  Volume2,
  X,
} from 'lucide-react'
import { useCallStore } from '@/lib/call/store'
import { getEngine } from '@/lib/call/engine'
import { type ChatMessage, type QualityPreset } from '@/lib/call/types'
// music.ts is dynamic-imported below (task 11) — the listen-together module
// stays out of the first-load bundle; only this type import is erased.
import type { MusicHandle } from '@/lib/call/music'
import { Sheet } from './sheet'
import { NetworkBars, LEVEL_LABEL } from './network-bars'

/* ------------------------------------------------------------------ */
/* Shared sheet shell                                                   */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Chat                                                                 */
/* ------------------------------------------------------------------ */

/**
 * Native-Unicode emoji picker — zero dependencies, zero network, mounted only
 * while open (a closed picker costs literally nothing). Categories are short
 * curated lists instead of the full Unicode table: instant render, no
 * virtualizer, no emoji font download (the OS emoji font already ships them).
 */
const EMOJI_GROUPS: Array<{ name: string; emojis: string[] }> = [
  {
    name: 'Smileys',
    emojis: ['😀', '😂', '🤣', '😊', '😍', '😘', '😎', '🤩', '🥳', '😏', '😢', '😭', '😤', '😡', '🤔', '😅', '😬', '🥺', '😴', '🤯', '😱', '🤗', '🤫', '🤝'],
  },
  {
    name: 'Gestures',
    emojis: ['👍', '👎', '👌', '✌️', '🤞', '🤟', '🤙', '👋', '🙌', '👏', '🙏', '💪', '🫡', '🫶', '✍️', '🤌', '👈', '👉', '👆', '👇', '☝️', '🖐️', '🤚', '🖖'],
  },
  {
    name: 'Fun',
    emojis: ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🔥', '✨', '🎉', '🎉', '💯', '⚡', '⭐', '🌟', '💥', '💫', '🎊', '🎁', '🏆', '🎯', '🎮', '🎧', '🎵'],
  },
  {
    name: 'Critters',
    emojis: ['🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐨', '🐯', '🦁', '🐮', '🐷', '🐸', '🐵', '🦄', '🐦', '🐧', '🦆', '🦉', '🐝', '🦋', '🐢', '🐙'],
  },
  {
    name: 'Food',
    emojis: ['☕', '🍵', '🥤', '🍺', '🍕', '🍔', '🍟', '🌮', '🍣', '🍜', '🍩', '🍪', '🎂', '🍫', '🍿', '🍎', '🍌', '🍓', '🥑', '🥕', '🌽', '🧀', '🍞', '🥐'],
  },
  {
    name: 'Work',
    emojis: ['💻', '🖥️', '⌨️', '🖱️', '📱', '☎️', '📧', '📝', '📌', '📎', '📁', '🔍', '🔧', '🔨', '💡', '🔋', '🛠️', '📊', '📈', '🗓️', '⏰', '🔔', '🔗', '✅'],
  },
]

const EMOJI_RECENTS_KEY = 'pico-emoji-recents'

function loadRecentEmojis(): string[] {
  try {
    const raw = localStorage.getItem(EMOJI_RECENTS_KEY)
    const list = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(list) ? (list.filter((e) => typeof e === 'string') as string[]).slice(0, 16) : []
  } catch {
    return []
  }
}

function EmojiPicker({ onPick, onClose }: { onPick: (e: string) => void; onClose: () => void }) {
  const [group, setGroup] = useState(0)
  const [recent, setRecent] = useState<string[]>(loadRecentEmojis)

  const pick = (e: string) => {
    const next = [e, ...recent.filter((x) => x !== e)].slice(0, 16)
    setRecent(next)
    try {
      localStorage.setItem(EMOJI_RECENTS_KEY, JSON.stringify(next))
    } catch {
      /* storage full / disabled — recents are a nicety, not a need */
    }
    onPick(e)
  }

  return (
    <div
      className="pico-pop absolute bottom-[calc(100%+8px)] left-2 right-2 z-10 rounded-md border border-black/[0.05] bg-white p-2 shadow-[0_12px_40px_rgba(0,0,0,0.14)]"
      role="dialog"
      aria-label="Emoji picker"
    >
      <div className="flex items-center justify-between px-1 pb-1.5">
        <div className="pico-carousel flex gap-0.5 overflow-x-auto">
          {recent.length > 0 && (
            <button
              onClick={() => setGroup(-1)}
              aria-label="Recent emojis"
              className={`h-7 rounded-sm px-2.5 text-[11px] font-bold transition-colors ${group === -1 ? 'bg-[#0d0d0f] text-white' : 'text-[#62626a] hover:bg-[#f5f5f7]'}`}
            >
              Recent
            </button>
          )}
          {EMOJI_GROUPS.map((g, i) => (
            <button
              key={g.name}
              onClick={() => setGroup(i)}
              className={`h-7 rounded-sm px-2.5 text-[11px] font-bold transition-colors ${group === i ? 'bg-[#0d0d0f] text-white' : 'text-[#62626a] hover:bg-[#f5f5f7]'}`}
            >
              {g.name}
            </button>
          ))}
        </div>
        <button onClick={onClose} aria-label="Close emoji picker" className="shrink-0 rounded-md p-1 text-[#62626a] hover:bg-[#f5f5f7]">
          <X className="h-3.5 w-3.5" strokeWidth={2.6} />
        </button>
      </div>
      <div className="ios-scroll grid max-h-40 grid-cols-8 gap-0.5 overflow-y-auto pt-1">
        {(group === -1 ? recent : EMOJI_GROUPS[group]?.emojis ?? []).map((e, i) => (
          <button
            key={e + i}
            onClick={() => pick(e)}
            className="flex h-9 w-9 items-center justify-center rounded-md text-[20px] leading-none transition-transform duration-100 hover:bg-[#f5f5f7] active:scale-90"
            aria-label={`Emoji ${e}`}
          >
            {e}
          </button>
        ))}
      </div>
    </div>
  )
}

export function ChatPanel({ onClose }: { onClose: () => void }) {
  const chat = useCallStore((s) => s.chat)
  const typingPeers = useCallStore((s) => s.typingPeers)
  const selfId = useCallStore((s) => s.self.id)
  const [draft, setDraft] = useState('')
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null)
  const [emojiOpen, setEmojiOpen] = useState(false)
  const [typingClock, setTypingClock] = useState(Date.now())
  const listRef = useRef<HTMLDivElement>(null)
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const typingSent = useRef(false)

  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [chat.length])

  useEffect(() => {
    const timer = window.setInterval(() => setTypingClock(Date.now()), 500)
    return () => window.clearInterval(timer)
  }, [])

  const send = () => {
    const text = draft.trim()
    if (!text) return
    getEngine().sendChat(text, replyTo ? { id: replyTo.id, name: replyTo.name, text: replyTo.text } : undefined)
    if (typingSent.current) getEngine().sendChatTyping(false)
    typingSent.current = false
    if (typingTimer.current) clearTimeout(typingTimer.current)
    setDraft('')
    setReplyTo(null)
    setEmojiOpen(false)
  }

  useEffect(() => () => {
    if (typingTimer.current) clearTimeout(typingTimer.current)
    if (typingSent.current) getEngine().sendChatTyping(false)
  }, [])

  const onDraftChange = (value: string) => {
    setDraft(value.slice(0, 500))
    const active = Boolean(value.trim())
    if (!active) {
      if (typingTimer.current) clearTimeout(typingTimer.current)
      typingTimer.current = null
      if (typingSent.current) getEngine().sendChatTyping(false)
      typingSent.current = false
      return
    }
    if (active && !typingSent.current) {
      typingSent.current = true
      getEngine().sendChatTyping(true)
    }
    if (typingTimer.current) clearTimeout(typingTimer.current)
    typingTimer.current = setTimeout(() => {
      typingSent.current = false
      getEngine().sendChatTyping(false)
    }, 1400)
    if (!active && typingSent.current) {
      typingSent.current = false
      getEngine().sendChatTyping(false)
    }
  }

  const typingNames = Object.values(typingPeers)
    .filter((person) => typingClock - person.at < 2200)
    .map((person) => person.name)

  const jumpTo = (id: string) => {
    const el = document.getElementById(`chat-msg-${id}`)
    if (!el) return
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    el.classList.remove('pico-flash')
    // restart the highlight animation if it just ran on this node
    void el.offsetWidth
    el.classList.add('pico-flash')
  }

  const renderQuote = (q: { id: string; name: string; text: string }, mine: boolean) => (
    <button
      onClick={() => jumpTo(q.id)}
      className={`mb-1 block w-full rounded-sm px-2 py-1 text-left ${mine ? 'bg-white/10' : 'bg-black/[0.04]'}`}
      aria-label={`Jump to message from ${q.name}`}
    >
      <span className={`block text-[10px] font-bold ${mine ? 'text-white/70' : 'text-[#62626a]'}`}>{q.name}</span>
      <span className={`line-clamp-2 block text-[11px] leading-snug ${mine ? 'text-white/60' : 'text-[#62626a]'}`}>{q.text}</span>
    </button>
  )

  return (
    <Sheet title="Chat" onClose={onClose}>
      <div ref={listRef} className="ios-scroll flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4">
        {chat.length === 0 && (
          <p className="mt-10 text-center text-[13px] font-medium text-[#62626a]">Messages appear here</p>
        )}
        {chat.map((m) =>
          m.system ? (
            <p key={m.id} className="text-center text-[11px] font-semibold uppercase tracking-[0.06em] text-[#62626a]">
              {m.text}
            </p>
          ) : m.from === selfId ? (
            <div key={m.id} id={`chat-msg-${m.id}`} className="group flex items-end justify-end gap-1.5">
              <button
                onClick={() => setReplyTo(m)}
                aria-label="Reply to your message"
                className="pico-reply-btn mr-1.5 flex h-7 w-7 shrink-0 self-center items-center justify-center rounded-md bg-[#f5f5f7] text-[#62626a] hover:bg-[#ebebf0]"
              >
                <Reply className="h-3.5 w-3.5 -scale-x-100" strokeWidth={2.4} />
              </button>
              <div className="max-w-[84%] min-w-0 rounded-[18px] rounded-br-[6px] bg-[#0d0d0f] px-3.5 py-2.5 shadow-sm">
                {m.replyTo && renderQuote(m.replyTo, true)}
                <p className="whitespace-pre-wrap break-words text-[13px] leading-snug text-white">{m.text}</p>
                <p className="mt-0.5 text-right text-[10px] font-medium text-white/55">
                  {new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </p>
              </div>
            </div>
          ) : (
            <div key={m.id} id={`chat-msg-${m.id}`} className="group flex items-end justify-start gap-1.5">
              <div className="max-w-[84%] min-w-0 rounded-[18px] rounded-bl-[6px] border border-black/[0.06] bg-[#f5f5f7] px-3.5 py-2.5">
                <p className="text-[11px] font-bold text-[#62626a]">{m.name}</p>
                {m.replyTo && renderQuote(m.replyTo, false)}
                <p className="mt-0.5 whitespace-pre-wrap break-words text-[13px] leading-snug text-[#0d0d0f]">
                  {m.text}
                </p>
                <p className="mt-0.5 text-[10px] font-medium text-[#62626a]">
                  {new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </p>
              </div>
              <button
                onClick={() => setReplyTo(m)}
                aria-label={`Reply to ${m.name}`}
                className="pico-reply-btn ml-1.5 flex h-7 w-7 shrink-0 self-center items-center justify-center rounded-md bg-[#f5f5f7] text-[#62626a] hover:bg-[#ebebf0]"
              >
                <Reply className="h-3.5 w-3.5 -scale-x-100" strokeWidth={2.4} />
              </button>
            </div>
          ),
        )}
        {typingNames.length > 0 && (
          <div className="flex items-center gap-2 self-start rounded-full border border-black/[0.06] bg-[#f5f5f7] px-3 py-2 text-[12px] font-medium text-[#62626a]" role="status" aria-live="polite">
            <span>{typingNames.length === 1 ? `${typingNames[0]} is typing` : 'Someone is typing'}</span>
            <span className="pico-typing-dots" aria-hidden="true"><i /><i /><i /></span>
          </div>
        )}
      </div>
      <footer className="safe-bottom relative shrink-0 border-t border-black/[0.08] bg-white/95 p-3">
        {emojiOpen && <EmojiPicker onPick={(e) => setDraft((d) => (d + e).slice(0, 500))} onClose={() => setEmojiOpen(false)} />}
        {replyTo && (
          <div className="mb-2 flex items-center gap-2 rounded-md bg-[#f5f5f7] px-3 py-2">
            <Reply className="h-3.5 w-3.5 shrink-0 -scale-x-100 text-[#62626a]" strokeWidth={2.4} />
            <div className="min-w-0 flex-1 border-l-2 border-[#c7c7cd] pl-2">
              <p className="text-[10px] font-bold text-[#62626a]">Replying to {replyTo.name}</p>
              <p className="line-clamp-1 text-[11px] leading-snug text-[#62626a]">{replyTo.text}</p>
            </div>
            <button
              onClick={() => setReplyTo(null)}
              aria-label="Cancel reply"
            className="shrink-0 rounded-md p-1 text-[#62626a] hover:bg-[#ebebf0]"
            >
              <X className="h-3.5 w-3.5" strokeWidth={2.6} />
            </button>
          </div>
        )}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setEmojiOpen((v) => !v)}
            aria-label={emojiOpen ? 'Close emoji picker' : 'Open emoji picker'}
            aria-expanded={emojiOpen}
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-md transition-colors ${emojiOpen ? 'bg-[#0d0d0f] text-white' : 'text-[#62626a] hover:bg-[#f5f5f7]'}`}
          >
            <Smile className="h-[18px] w-[18px]" strokeWidth={2.2} />
          </button>
          <textarea
            value={draft}
            onChange={(e) => onDraftChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
            onKeyUp={(e) => {
              const target = e.currentTarget
              target.style.height = '40px'
              target.style.height = `${Math.min(target.scrollHeight, 112)}px`
            }}
            placeholder="Write a message…"
            aria-label="Chat message"
            maxLength={500}
            rows={1}
            className="ios-field min-h-10 max-h-28 min-w-0 flex-1 resize-none rounded-[14px] py-2.5 leading-5"
          />
          <button
            onClick={send}
            disabled={!draft.trim()}
            aria-label="Send message"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-[#0d0d0f] text-white transition-all duration-[130ms] ease-[cubic-bezier(0.22,1,0.36,1)] hover:bg-[#26262b] active:scale-90 disabled:bg-[#e8e8ed] disabled:text-[#62626a]"
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
  const hostId = useCallStore((s) => s.hostId)
  const locked = useCallStore((s) => s.locked)
  const music = useCallStore((s) => s.music)
  const [copied, setCopied] = useState(false)
  const [removed, setRemoved] = useState<string | null>(null)

  const isHost = !!self.id && hostId === self.id

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

  const remove = (id: string, name: string) => {
    getEngine().hostRemove(id)
    setRemoved(name)
    setTimeout(() => setRemoved(null), 2200)
  }

  return (
    <Sheet title={`People · ${everyone.length}`} onClose={onClose}>
      <div className="border-b border-black/[0.05] p-3">
        <button onClick={copy} className="ios-pill-soft h-10 w-full text-[13px]">
          {copied ? <Check className="h-4 w-4 text-[#30d158]" strokeWidth={2.6} /> : <Link2 className="h-4 w-4 text-[#62626a]" strokeWidth={2.2} />}
          {copied ? 'Link copied' : 'Copy invite link'}
        </button>
        <p className="mt-2 text-center font-mono text-[11px] font-medium tracking-wide text-[#62626a]">
          {locked ? 'Locked · nobody new can join' : roomCode}
        </p>
      </div>

      {removed && (
        <p className="px-4 pt-3 text-[12px] font-semibold text-[#c52d25]" role="status">
          {removed} was removed from the call
        </p>
      )}

      <ul className="ios-scroll flex-1 overflow-y-auto p-2">
        {everyone.map((p) => (
          <li key={p.id} className="flex items-center gap-3 px-3 py-2.5">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#e8e8ed] text-[12px] font-bold text-[#62626a]">
              {p.name.slice(0, 2).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-1.5 truncate text-[15px] font-semibold text-[#0d0d0f]">
                {p.name}
                {p.isSelf ? ' (You)' : ''}
                {hostId === p.id && <Crown className="h-3.5 w-3.5 shrink-0 text-[#f5a623]" aria-label="Host" strokeWidth={2.4} />}
              </p>
              <p className="text-[12px] font-medium text-[#62626a]">
                {music.peerId === p.id
                  ? 'Playing music for everyone'
                  : p.sharing
                    ? 'Sharing screen'
                    : p.camOn
                      ? 'Camera on'
                      : 'Camera off'}
              </p>
            </div>
            <div className="flex items-center gap-1.5 text-[#62626a]">
              {!p.micOn && <MicOff className="h-4 w-4 text-[#c52d25]" aria-label="Muted" strokeWidth={2.4} />}
              {!p.camOn && !p.sharing && <CameraOff className="h-4 w-4" aria-label="Camera off" strokeWidth={2.4} />}
              {p.sharing && <MonitorUp className="h-4 w-4 text-[#30d158]" aria-label="Sharing" strokeWidth={2.4} />}
            </div>
            {isHost && !p.isSelf && (
              <div className="flex shrink-0 items-center gap-1">
                {p.micOn && (
                  <button
                    onClick={() => getEngine().hostMute(p.id)}
                    aria-label={`Mute ${p.name}`}
                    title={`Mute ${p.name}`}
                    className="press flex h-8 w-8 items-center justify-center rounded-md bg-[#f5f5f7] text-[#3c3c43] hover:bg-[#ebebf0] active:scale-90"
                  >
                    <MicOff className="h-3.5 w-3.5" strokeWidth={2.4} />
                  </button>
                )}
                <button
                  onClick={() => remove(p.id, p.name)}
                  aria-label={`Remove ${p.name}`}
                  title={`Remove ${p.name}`}
                  className="press flex h-8 w-8 items-center justify-center rounded-md bg-[#d62f25]/10 text-[#c52d25] hover:bg-[#d62f25]/15 active:scale-90"
                >
                  <UserMinus className="h-3.5 w-3.5" strokeWidth={2.4} />
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>

      {isHost && (
        <div className="border-t border-black/[0.05] p-3">
          <div className="flex gap-2">
            <button
              onClick={() => getEngine().hostMuteAll()}
              className="ios-pill-soft h-10 flex-1 text-[13px]"
            >
              <MicOff className="h-4 w-4 text-[#62626a]" strokeWidth={2.2} />
              Mute everyone
            </button>
            <button
              onClick={() => getEngine().hostLock(!locked)}
              className="ios-pill-soft h-10 flex-1 text-[13px]"
            >
              {locked ? <LockOpen className="h-4 w-4 text-[#30d158]" strokeWidth={2.2} /> : <Lock className="h-4 w-4 text-[#62626a]" strokeWidth={2.2} />}
              {locked ? 'Unlock room' : 'Lock room'}
            </button>
          </div>
          <p className="mt-2 text-center text-[11px] font-medium text-[#62626a]">
            You are the host — you can mute or remove anyone
          </p>
        </div>
      )}

      <footer className="border-t border-black/[0.05] px-4 py-3 text-center text-[12px] font-medium text-[#62626a]">
        <Users className="mr-1 inline h-3 w-3" /> Peer-to-peer · up to 10 people
      </footer>
    </Sheet>
  )
}

/* ------------------------------------------------------------------ */
/* Music — listen together                                              */
/* ------------------------------------------------------------------ */

const fmtTime = (t: number) => {
  const s = Math.max(0, Math.floor(t))
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

export function MusicPanel({ onClose }: { onClose: () => void }) {
  const music = useCallStore((s) => s.music)
  const selfId = useCallStore((s) => s.self.id)
  const peers = useCallStore((s) => s.peers)
  const fileRef = useRef<HTMLInputElement>(null)
  const [position, setPosition] = useState(0)
  const [monitorVol, setMonitorVol] = useState(1)
  const [remoteVol, setRemoteVol] = useState(1)
  const [starting, setStarting] = useState(false)
  const testMode = typeof window !== 'undefined' && window.location.search.includes('test=1')

  // music.ts is loaded on panel open (task 11): a lazy one-off the bundle
  // never carries on first paint.
  const musicRef = useRef<typeof import('@/lib/call/music') | null>(null)
  const loadMusicModule = async () => {
    if (!musicRef.current) musicRef.current = await import('@/lib/call/music')
    return musicRef.current
  }

  const isSelf = music.peerId !== null && music.peerId === selfId
  const sharerName =
    music.peerId === null ? '' : music.peerId === selfId ? 'You' : peers[music.peerId]?.name ?? 'Someone'

  // Live position for the sharer — read straight from the active source
  useEffect(() => {
    if (!isSelf) return
    const t = window.setInterval(() => {
      const h = getEngine().activeMusic
      if (h) setPosition(h.getPosition())
    }, 500)
    return () => window.clearInterval(t)
  }, [isSelf])

  const beginShare = (handle: MusicHandle, origin: 'file' | 'test') => {
    handle.onMeta(() => getEngine().broadcastMusicMeta())
    getEngine().startMusicShare(handle, origin)
    void handle.play().then(() => getEngine().broadcastMusicMeta())
  }

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const m = await loadMusicModule()
      const handle = m.createFileMusicHandle(file)
      beginShare(handle, 'file')
    } catch {
      /* file unreadable */
    }
    e.target.value = ''
  }

  const startTest = async () => {
    setStarting(true)
    try {
      const m = await loadMusicModule()
      beginShare(m.createTestMusicHandle(), 'test')
    } finally {
      setStarting(false)
    }
  }

  const startTabShare = async () => {
    setStarting(true)
    try {
      await getEngine().startTabAudioShare()
    } finally {
      setStarting(false)
    }
  }

  const stop = () => {
    // One call tears down senders, store state and the element-backed handle
    getEngine().stopMusicShare()
  }

  const togglePlay = () => {
    const h = getEngine().activeMusic
    if (!h) return
    if (h.isPlaying()) h.pause?.()
    else void h.play?.()
    getEngine().broadcastMusicMeta()
  }

  const active = getEngine().activeMusic
  const duration = active?.duration || 0
  // Tab shares have no play/pause/seek — playback belongs to the source tab.
  const canControl = !!active && (!!active.play || getEngine().musicOriginKind !== 'tab')

  return (
    <Sheet title="Listen together" onClose={onClose}>
      <div className="ios-scroll flex-1 overflow-y-auto p-4">
        {music.peerId === null ? (
          <>
            <div className="mb-4 flex items-start gap-3 rounded-md bg-[#f5f5f7] px-4 py-3.5">
              <Music2 className="mt-0.5 h-5 w-5 shrink-0 text-[#0d0d0f]" strokeWidth={2.2} />
              <p className="text-[13px] leading-relaxed text-[#3c3c43]">
                Play music from this device and everyone in the call hears the same thing, in sync.
                It rides its own stereo audio channel — nobody&apos;s mic or video is touched.
              </p>
            </div>

            <input ref={fileRef} type="file" accept="audio/*" onChange={(e) => void onFile(e)} className="hidden" />
            <button onClick={() => fileRef.current?.click()} className="ios-pill h-12 w-full">
              <FileAudio className="h-4 w-4" strokeWidth={2.2} />
              Choose a music file
            </button>
            <button onClick={() => void startTabShare()} disabled={starting} className="ios-pill mt-2 h-12 w-full">
              <Radio className="h-4 w-4" strokeWidth={2.2} />
              {starting ? 'Waiting for picker…' : 'Share audio from a tab…'}
            </button>
            <p className="mt-2.5 text-center text-[12px] leading-relaxed text-[#62626a]">
              The browser picker lists every open tab, window and screen — pick the platform
              or tab you want to share. Only its sound is sent (~96 kbps); the video capture
              stops instantly, so this costs no CPU to speak of.
            </p>
            <p className="mt-1.5 text-center text-[11px] leading-relaxed text-[#c7c7cd]">
              Local file instead? MP3, M4A, WAV, OGG — stays on your device.
            </p>

            {testMode && (
              <button onClick={() => void startTest()} disabled={starting} className="ios-pill-soft mt-4 h-11 w-full text-[13px]">
                <Music2 className="h-4 w-4 text-[#62626a]" strokeWidth={2.2} />
                {starting ? 'Starting…' : 'Play demo tune (test mode)'}
              </button>
            )}
          </>
        ) : isSelf ? (
          <>
            <div className="rounded-md bg-[#0d0d0f] px-4 py-4 text-white">
              <div className="flex items-center gap-3">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-white/10">
                  <Music2 className="h-5 w-5 text-[#30d158]" strokeWidth={2.2} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[15px] font-bold">{music.title}</p>
                  <p className="text-[12px] font-medium text-white/60">
                    {music.playing ? 'Playing for everyone' : 'Paused'}
                  </p>
                </div>
                <span className="flex items-end gap-[2.5px]" aria-hidden>
                  {[0, 1, 2, 3].map((i) => (
                    <span
                      key={i}
                      className="eq-bar eq-bar-dark"
                      style={{ animationDelay: `${i * 140}ms`, animationPlayState: music.playing ? 'running' : 'paused' }}
                    />
                  ))}
                </span>
              </div>

              {duration > 0 && canControl && (
                <div className="mt-4">
                  <input
                    type="range"
                    min={0}
                    max={Math.floor(duration)}
                    value={Math.min(position, duration)}
                    onChange={(e) => {
                      const t = Number(e.target.value)
                      setPosition(t)
                      active?.seek?.(t)
                    }}
                    onMouseUp={() => getEngine().broadcastMusicMeta()}
                    onTouchEnd={() => getEngine().broadcastMusicMeta()}
                    aria-label="Seek"
                    className="ios-range"
                  />
                  <div className="mt-1 flex justify-between font-mono text-[10px] tabular-nums text-white/55">
                    <span>{fmtTime(position)}</span>
                    <span>{fmtTime(duration)}</span>
                  </div>
                </div>
              )}

              <div className="mt-4 flex items-center justify-between">
                {canControl ? (
                  <button
                    onClick={togglePlay}
                    aria-label={music.playing ? 'Pause music' : 'Play music'}
                    className="press flex h-11 w-11 items-center justify-center rounded-md bg-white text-[#0d0d0f] active:scale-90"
                  >
                    {music.playing ? <Pause className="h-5 w-5" strokeWidth={2.4} /> : <Play className="h-5 w-5 translate-x-[1px]" strokeWidth={2.4} />}
                  </button>
                ) : (
                  <span className="text-[12px] font-semibold text-white/60">Sharing this tab&apos;s sound</span>
                )}
                <button
                  onClick={stop}
                  className="flex h-11 items-center gap-2 rounded-md bg-[#d62f25] px-5 text-[14px] font-bold text-white transition-all duration-[130ms] ease-[cubic-bezier(0.22,1,0.36,1)] hover:bg-[#bf2920] active:scale-95"
                >
                  <Square className="h-3.5 w-3.5" strokeWidth={2.6} />
                  Stop
                </button>
              </div>

              {canControl && (
                <div className="mt-4 flex items-center gap-2.5 border-t border-white/10 pt-3.5">
                  <Volume2 className="h-4 w-4 shrink-0 text-white/60" strokeWidth={2.2} />
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={Math.round(monitorVol * 100)}
                    onChange={(e) => {
                      const v = Number(e.target.value) / 100
                      setMonitorVol(v)
                      active?.setMonitorVolume?.(v)
                    }}
                    aria-label="Volume for you"
                    className="ios-range flex-1 bg-white/20"
                  />
                  <span className="w-9 text-right font-mono text-[11px] tabular-nums text-white/60">{Math.round(monitorVol * 100)}</span>
                </div>
              )}
              <p className="mt-1.5 text-[11px] font-medium text-white/50">
                {canControl ? 'Volume for you — everyone else always hears the full mix' : 'Sound from the screen you are sharing, for everyone'}
              </p>
            </div>
          </>
        ) : (
          <>
            <div className="rounded-md border border-black/[0.05] bg-[#f5f5f7] px-4 py-4">
              <div className="flex items-center gap-3">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-[#0d0d0f]">
                  <Music2 className="h-5 w-5 text-[#30d158]" strokeWidth={2.2} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[15px] font-bold text-[#0d0d0f]">{music.title}</p>
                  <p className="text-[12px] font-medium text-[#62626a]">
                    {sharerName} · {music.playing ? 'playing now' : 'paused'}
                  </p>
                </div>
                <span className="flex items-end gap-[2.5px]" aria-hidden>
                  {[0, 1, 2, 3].map((i) => (
                    <span
                      key={i}
                      className="eq-bar"
                      style={{ animationDelay: `${i * 140}ms`, animationPlayState: music.playing ? 'running' : 'paused' }}
                    />
                  ))}
                </span>
              </div>

              <div className="mt-4 flex items-center gap-2.5 border-t border-black/[0.05] pt-3.5">
                <Volume2 className="h-4 w-4 shrink-0 text-[#62626a]" strokeWidth={2.2} />
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={Math.round(remoteVol * 100)}
                    onChange={(e) => {
                      const v = Number(e.target.value) / 100
                      setRemoteVol(v)
                      void loadMusicModule().then((m) => m.setRemoteMusicVolume(v))
                    }}
                  aria-label="Music volume"
                  className="ios-range flex-1"
                />
                <span className="w-9 text-right font-mono text-[11px] tabular-nums text-[#62626a]">{Math.round(remoteVol * 100)}</span>
              </div>
            </div>
            <p className="mt-3 px-1 text-[12px] leading-relaxed text-[#62626a]">
              The music arrives on its own audio channel, so you can keep talking and your camera
              quality never dips.
            </p>
          </>
        )}
      </div>
    </Sheet>
  )
}

/* ------------------------------------------------------------------ */
/* Security & privacy                                                   */
/* ------------------------------------------------------------------ */

const PRIVACY_ROWS = [
  { icon: EyeOff, title: 'Nothing is recorded', text: 'There is no recording. When you leave, it is gone.' },
  { icon: ServerOff, title: 'Media never touches a server', text: 'Audio and video travel directly between devices.' },
  { icon: MessageSquareLock, title: 'Chat is memory-only', text: 'Messages are relayed live and never stored.' },
  { icon: KeyRound, title: 'No accounts, no tracking', text: 'No sign-up, no email, no analytics.' },
]

export function SecurityPanel({ onClose }: { onClose: () => void }) {
  const locked = useCallStore((s) => s.locked)
  const passcodeProtected = useCallStore((s) => s.passcodeProtected)
  const hostId = useCallStore((s) => s.hostId)
  const selfId = useCallStore((s) => s.self.id)
  const peers = useCallStore((s) => s.peers)
  const isHost = !!selfId && hostId === selfId
  const hostName =
    hostId === selfId ? (useCallStore.getState().self.name || 'You') : peers[hostId ?? '']?.name ?? '—'

  return (
    <Sheet title="Privacy & security" onClose={onClose}>
      <div className="ios-scroll flex-1 overflow-y-auto p-4">
        <div className="mb-4 flex items-start gap-3 rounded-md bg-[#0d0d0f] px-4 py-4 text-white">
          <ShieldCheck className="mt-0.5 h-6 w-6 shrink-0 text-[#30d158]" strokeWidth={2.2} />
          <div>
            <p className="text-[15px] font-bold">Encrypted, end to end</p>
            <p className="mt-1 text-[12px] leading-relaxed text-white/65">
              Every packet is encrypted with DTLS-SRTP by your browser and travels straight to the
              other participants. The signaling relay only handles connection setup — it can never
              see or hear anything.
            </p>
          </div>
        </div>

        <div className="overflow-hidden rounded-md border border-black/[0.05]">
          <div className="flex items-center gap-3 px-4 py-3">
            {passcodeProtected ? (
              <KeyRound className="h-4 w-4 shrink-0 text-[#30d158]" strokeWidth={2.2} />
            ) : (
              <LockOpen className="h-4 w-4 shrink-0 text-[#62626a]" strokeWidth={2.2} />
            )}
            <p className="text-[13px] font-medium text-[#3c3c43]">
              {passcodeProtected ? 'Protected with a passcode' : 'Open room — anyone with the link can join'}
            </p>
          </div>
          {PRIVACY_ROWS.map((row, i) => (
            <div key={row.title} className={`flex items-start gap-3 border-t border-black/[0.05] px-4 py-3`}>
              <row.icon className="mt-0.5 h-4 w-4 shrink-0 text-[#62626a]" strokeWidth={2.2} />
              <div>
                <p className="text-[14px] font-semibold text-[#0d0d0f]">{row.title}</p>
                <p className="mt-0.5 text-[12px] leading-relaxed text-[#62626a]">{row.text}</p>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-4 overflow-hidden rounded-md border border-black/[0.05]">
          {isHost ? (
            <div className="flex items-center justify-between gap-3 px-4 py-3.5">
              <div>
                <p className="text-[14px] font-semibold text-[#0d0d0f]">Lock this call</p>
                <p className="mt-0.5 text-[12px] leading-relaxed text-[#62626a]">
                  Nobody new can join until you turn this off.
                </p>
              </div>
              <button
                role="switch"
                aria-checked={locked}
                aria-label="Lock call"
                data-on={locked}
                onClick={() => getEngine().hostLock(!locked)}
                className="ios-switch"
              />
            </div>
          ) : (
            <div className="flex items-center gap-3 px-4 py-3.5">
              <Crown className="h-4 w-4 shrink-0 text-[#f5a623]" strokeWidth={2.4} />
              <p className="text-[13px] font-medium text-[#3c3c43]">
                Host: <span className="font-bold text-[#0d0d0f]">{hostName}</span> — they can mute or
                remove participants and lock the call.
              </p>
            </div>
          )}
        </div>

        <p className="mt-4 px-1 text-[12px] leading-relaxed text-[#62626a]">
          Pico runs entirely in your browser. There is no server-side storage at all — refreshing
          this page removes the last trace of the call.
        </p>
      </div>
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
  const peers = useCallStore((s) => s.peers)
  const lite = useCallStore((s) => s.lite)
  const liteAuto = useCallStore((s) => s.liteAuto)
  const [pending, setPending] = useState<QualityPreset | null>(null)

  // Honest status: "still dialing" is not "bad network". If no media flows
  // yet and a peer link is still being established, say so.
  const dialing = Object.values(peers).some((p) => p.connecting)
  const anyMedia = Object.values(peers).some((p) => p.hasStream)
  const statusLabel = overall === 0 && dialing && !anyMedia ? 'Connecting to peers…' : LEVEL_LABEL[overall]

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
        <DeviceSection />
        <div className="mb-4 flex items-center justify-between rounded-md bg-[#f5f5f7] px-4 py-3">
          <div>
            <p className="text-[15px] font-bold text-[#0d0d0f]">{effective || 'Auto'}</p>
            <p className="text-[12px] font-medium tabular-nums text-[#62626a]">Sending ~{bitrate} kbps</p>
          </div>
          <div className="flex items-center gap-2">
            <NetworkBars level={overall} size="md" />
            <span className="text-[12px] font-medium text-[#62626a]">{statusLabel}</span>
          </div>
        </div>

        <div className="overflow-hidden rounded-md border border-black/[0.05]">
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
                <span className="block text-[12px] font-medium text-[#62626a]">{opt.hint}</span>
              </span>
              {preset === opt.key && <Check className="h-4 w-4 shrink-0 text-[#30d158]" strokeWidth={2.8} />}
            </button>
          ))}
        </div>

        <div className="mt-4 overflow-hidden rounded-md border border-black/[0.05]">
          <div className="flex items-center justify-between gap-3 px-4 py-3.5">
            <div>
              <p className="text-[14px] font-semibold text-[#0d0d0f]">Lite mode</p>
              <p className="mt-0.5 text-[12px] leading-relaxed text-[#62626a]">
                Audio-only send, receive video only from the active speaker.
                {liteAuto ? ' Auto-enabled for your connection.' : ''} Lowest data, lowest CPU.
              </p>
            </div>
            <button
              role="switch"
              aria-checked={lite}
              aria-label="Lite mode"
              data-on={lite}
              onClick={() => getEngine().setLiteMode(!lite)}
              className="ios-switch shrink-0"
            />
          </div>
        </div>

        <p className="mt-4 px-1 text-[12px] leading-relaxed text-[#62626a]">
          Pico sends every stream directly to the other person — nothing is uploaded to a server.
          Audio uses Opus DTX, so silence costs almost nothing. Music in Listen Together steps down
          to 48 kbps on weak links, before your video ever stutters.
        </p>
      </div>
    </Sheet>
  )
}

/** In-call mic/camera switching (replaceTrack — no renegotiation). Devices
 *  list refreshes on every panel open; a failed switch keeps the old device
 *  and surfaces the reason via the store's mediaNotice. */
function DeviceSection() {
  const [mics, setMics] = useState<MediaDeviceInfo[]>([])
  const [cams, setCams] = useState<MediaDeviceInfo[]>([])
  const [selMic, setSelMic] = useState('')
  const [selCam, setSelCam] = useState('')
  const mediaNotice = useCallStore((s) => s.mediaNotice)

  useEffect(() => {
    let cancelled = false
    navigator.mediaDevices
      .enumerateDevices()
      .then((all) => {
        if (cancelled) return
        setMics(all.filter((d) => d.kind === 'audioinput'))
        setCams(all.filter((d) => d.kind === 'videoinput'))
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  if (mics.length < 2 && cams.length < 2 && !mediaNotice) return null
  return (
    <div className="mb-4 flex flex-col gap-2 rounded-md bg-[#f5f5f7] px-4 py-3">
      <p className="text-[12px] font-bold uppercase tracking-wide text-[#62626a]">Devices</p>
      {mics.length > 1 && (
        <select
          aria-label="Microphone device"
          value={selMic}
          onChange={(e) => {
            setSelMic(e.target.value)
            void getEngine().switchDevice('mic', e.target.value)
          }}
          className="w-full rounded-sm border border-black/10 bg-white px-2 py-1.5 text-[13px] font-medium text-[#0d0d0f]"
        >
          {mics.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>{d.label || 'Microphone'}</option>
          ))}
        </select>
      )}
      {cams.length > 1 && (
        <select
          aria-label="Camera device"
          value={selCam}
          onChange={(e) => {
            setSelCam(e.target.value)
            void getEngine().switchDevice('cam', e.target.value)
          }}
          className="w-full rounded-sm border border-black/10 bg-white px-2 py-1.5 text-[13px] font-medium text-[#0d0d0f]"
        >
          {cams.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>{d.label || 'Camera'}</option>
          ))}
        </select>
      )}
      {mediaNotice && <p className="text-[12px] font-medium text-amber-700">{mediaNotice}</p>}
    </div>
  )
}
