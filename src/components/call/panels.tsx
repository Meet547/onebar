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
import { createFileMusicHandle, createTestMusicHandle, setRemoteMusicVolume, type MusicHandle } from '@/lib/call/music'
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
      className="pico-pop absolute bottom-[calc(100%+8px)] left-2 right-2 z-10 rounded-[18px] border border-black/[0.05] bg-white p-2 shadow-[0_12px_40px_rgba(0,0,0,0.14)]"
      role="dialog"
      aria-label="Emoji picker"
    >
      <div className="flex items-center justify-between px-1 pb-1.5">
        <div className="flex gap-0.5 overflow-x-auto">
          {recent.length > 0 && (
            <button
              onClick={() => setGroup(-1)}
              aria-label="Recent emojis"
              className={`h-7 rounded-full px-2.5 text-[11px] font-bold transition-colors ${group === -1 ? 'bg-[#0d0d0f] text-white' : 'text-[#7c7c82] hover:bg-[#f5f5f7]'}`}
            >
              Recent
            </button>
          )}
          {EMOJI_GROUPS.map((g, i) => (
            <button
              key={g.name}
              onClick={() => setGroup(i)}
              className={`h-7 rounded-full px-2.5 text-[11px] font-bold transition-colors ${group === i ? 'bg-[#0d0d0f] text-white' : 'text-[#7c7c82] hover:bg-[#f5f5f7]'}`}
            >
              {g.name}
            </button>
          ))}
        </div>
        <button onClick={onClose} aria-label="Close emoji picker" className="shrink-0 rounded-full p-1 text-[#a9a9b0] hover:bg-[#f5f5f7]">
          <X className="h-3.5 w-3.5" strokeWidth={2.6} />
        </button>
      </div>
      <div className="ios-scroll grid max-h-40 grid-cols-8 gap-0.5 overflow-y-auto pt-1">
        {(group === -1 ? recent : EMOJI_GROUPS[group]?.emojis ?? []).map((e, i) => (
          <button
            key={e + i}
            onClick={() => pick(e)}
            className="flex h-9 w-9 items-center justify-center rounded-xl text-[20px] leading-none transition-transform duration-100 hover:bg-[#f5f5f7] active:scale-90"
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
  const selfId = useCallStore((s) => s.self.id)
  const [draft, setDraft] = useState('')
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null)
  const [emojiOpen, setEmojiOpen] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [chat.length])

  const send = () => {
    const text = draft.trim()
    if (!text) return
    getEngine().sendChat(text, replyTo ? { id: replyTo.id, name: replyTo.name, text: replyTo.text } : undefined)
    setDraft('')
    setReplyTo(null)
    setEmojiOpen(false)
  }

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
      className={`mb-1 block w-full rounded-[10px] border-l-2 px-2 py-1 text-left ${mine ? 'border-white/50 bg-white/10' : 'border-[#7c7c82] bg-black/[0.04]'}`}
      aria-label={`Jump to message from ${q.name}`}
    >
      <span className={`block text-[10px] font-bold ${mine ? 'text-white/70' : 'text-[#7c7c82]'}`}>{q.name}</span>
      <span className={`line-clamp-2 block text-[11px] leading-snug ${mine ? 'text-white/60' : 'text-[#7c7c82]'}`}>{q.text}</span>
    </button>
  )

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
            <div key={m.id} id={`chat-msg-${m.id}`} className="group flex justify-end rounded-xl">
              <button
                onClick={() => setReplyTo(m)}
                aria-label="Reply to your message"
                className="pico-reply-btn mr-1.5 flex h-7 w-7 shrink-0 self-center items-center justify-center rounded-full bg-[#f5f5f7] text-[#7c7c82] hover:bg-[#ebebf0]"
              >
                <Reply className="h-3.5 w-3.5 -scale-x-100" strokeWidth={2.4} />
              </button>
              <div className="max-w-[80%] rounded-[18px] rounded-br-[6px] bg-[#0d0d0f] px-3.5 py-2">
                {m.replyTo && renderQuote(m.replyTo, true)}
                <p className="whitespace-pre-wrap break-words text-[13px] leading-snug text-white">{m.text}</p>
                <p className="mt-0.5 text-right text-[10px] font-medium text-white/55">
                  {new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </p>
              </div>
            </div>
          ) : (
            <div key={m.id} id={`chat-msg-${m.id}`} className="group flex justify-start rounded-xl">
              <div className="max-w-[80%] rounded-[18px] rounded-bl-[6px] bg-[#f5f5f7] px-3.5 py-2">
                <p className="text-[11px] font-bold text-[#7c7c82]">{m.name}</p>
                {m.replyTo && renderQuote(m.replyTo, false)}
                <p className="mt-0.5 whitespace-pre-wrap break-words text-[13px] leading-snug text-[#0d0d0f]">
                  {m.text}
                </p>
                <p className="mt-0.5 text-[10px] font-medium text-[#a9a9b0]">
                  {new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </p>
              </div>
              <button
                onClick={() => setReplyTo(m)}
                aria-label={`Reply to ${m.name}`}
                className="pico-reply-btn ml-1.5 flex h-7 w-7 shrink-0 self-center items-center justify-center rounded-full bg-[#f5f5f7] text-[#7c7c82] hover:bg-[#ebebf0]"
              >
                <Reply className="h-3.5 w-3.5 -scale-x-100" strokeWidth={2.4} />
              </button>
            </div>
          ),
        )}
      </div>
      <footer className="safe-bottom relative border-t border-black/[0.05] p-3">
        {emojiOpen && <EmojiPicker onPick={(e) => setDraft((d) => (d + e).slice(0, 500))} onClose={() => setEmojiOpen(false)} />}
        {replyTo && (
          <div className="mb-2 flex items-center gap-2 rounded-[14px] bg-[#f5f5f7] px-3 py-2">
            <Reply className="h-3.5 w-3.5 shrink-0 -scale-x-100 text-[#7c7c82]" strokeWidth={2.4} />
            <div className="min-w-0 flex-1 border-l-2 border-[#c7c7cd] pl-2">
              <p className="text-[10px] font-bold text-[#7c7c82]">Replying to {replyTo.name}</p>
              <p className="line-clamp-1 text-[11px] leading-snug text-[#a9a9b0]">{replyTo.text}</p>
            </div>
            <button
              onClick={() => setReplyTo(null)}
              aria-label="Cancel reply"
              className="shrink-0 rounded-full p-1 text-[#a9a9b0] hover:bg-[#ebebf0]"
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
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition-colors ${emojiOpen ? 'bg-[#0d0d0f] text-white' : 'text-[#7c7c82] hover:bg-[#f5f5f7]'}`}
          >
            <Smile className="h-[18px] w-[18px]" strokeWidth={2.2} />
          </button>
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
          {copied ? <Check className="h-4 w-4 text-[#30d158]" strokeWidth={2.6} /> : <Link2 className="h-4 w-4 text-[#7c7c82]" strokeWidth={2.2} />}
          {copied ? 'Link copied' : 'Copy invite link'}
        </button>
        <p className="mt-2 text-center font-mono text-[11px] font-medium tracking-wide text-[#a9a9b0]">
          {locked ? 'Locked · nobody new can join' : roomCode}
        </p>
      </div>

      {removed && (
        <p className="px-4 pt-3 text-[12px] font-semibold text-[#ff3b30]" role="status">
          {removed} was removed from the call
        </p>
      )}

      <ul className="ios-scroll flex-1 overflow-y-auto p-2">
        {everyone.map((p) => (
          <li key={p.id} className="flex items-center gap-3 rounded-2xl px-3 py-2.5">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#e8e8ed] text-[12px] font-bold text-[#7c7c82]">
              {p.name.slice(0, 2).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-1.5 truncate text-[15px] font-semibold text-[#0d0d0f]">
                {p.name}
                {p.isSelf ? ' (You)' : ''}
                {hostId === p.id && <Crown className="h-3.5 w-3.5 shrink-0 text-[#f5a623]" aria-label="Host" strokeWidth={2.4} />}
              </p>
              <p className="text-[12px] font-medium text-[#a9a9b0]">
                {music.peerId === p.id
                  ? 'Playing music for everyone'
                  : p.sharing
                    ? 'Sharing screen'
                    : p.camOn
                      ? 'Camera on'
                      : 'Camera off'}
              </p>
            </div>
            <div className="flex items-center gap-1.5 text-[#7c7c82]">
              {!p.micOn && <MicOff className="h-4 w-4 text-[#ff3b30]" aria-label="Muted" strokeWidth={2.4} />}
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
                    className="press flex h-8 w-8 items-center justify-center rounded-full bg-[#f5f5f7] text-[#3c3c43] hover:bg-[#ebebf0] active:scale-90"
                  >
                    <MicOff className="h-3.5 w-3.5" strokeWidth={2.4} />
                  </button>
                )}
                <button
                  onClick={() => remove(p.id, p.name)}
                  aria-label={`Remove ${p.name}`}
                  title={`Remove ${p.name}`}
                  className="press flex h-8 w-8 items-center justify-center rounded-full bg-[#ff3b30]/10 text-[#ff3b30] hover:bg-[#ff3b30]/15 active:scale-90"
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
              <MicOff className="h-4 w-4 text-[#7c7c82]" strokeWidth={2.2} />
              Mute everyone
            </button>
            <button
              onClick={() => getEngine().hostLock(!locked)}
              className="ios-pill-soft h-10 flex-1 text-[13px]"
            >
              {locked ? <LockOpen className="h-4 w-4 text-[#30d158]" strokeWidth={2.2} /> : <Lock className="h-4 w-4 text-[#7c7c82]" strokeWidth={2.2} />}
              {locked ? 'Unlock room' : 'Lock room'}
            </button>
          </div>
          <p className="mt-2 text-center text-[11px] font-medium text-[#a9a9b0]">
            You are the host — you can mute or remove anyone
          </p>
        </div>
      )}

      <footer className="border-t border-black/[0.05] px-4 py-3 text-center text-[12px] font-medium text-[#a9a9b0]">
        <Users className="mr-1 inline h-3 w-3" /> Peer-to-peer · up to 8 people
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

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const handle = createFileMusicHandle(file)
      beginShare(handle, 'file')
    } catch {
      /* file unreadable */
    }
    e.target.value = ''
  }

  const startTest = () => {
    setStarting(true)
    try {
      beginShare(createTestMusicHandle(), 'test')
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
            <div className="mb-4 flex items-start gap-3 rounded-[18px] bg-[#f5f5f7] px-4 py-3.5">
              <Music2 className="mt-0.5 h-5 w-5 shrink-0 text-[#0d0d0f]" strokeWidth={2.2} />
              <p className="text-[13px] leading-relaxed text-[#3c3c43]">
                Play music from this device and everyone in the call hears the same thing, in sync.
                It rides its own stereo audio channel — nobody&apos;s mic or video is touched.
              </p>
            </div>

            <input ref={fileRef} type="file" accept="audio/*" onChange={onFile} className="hidden" />
            <button onClick={() => fileRef.current?.click()} className="ios-pill h-12 w-full">
              <FileAudio className="h-4 w-4" strokeWidth={2.2} />
              Choose a music file
            </button>
            <button onClick={() => void startTabShare()} disabled={starting} className="ios-pill mt-2 h-12 w-full">
              <Radio className="h-4 w-4" strokeWidth={2.2} />
              {starting ? 'Waiting for picker…' : 'Share audio from a tab…'}
            </button>
            <p className="mt-2.5 text-center text-[12px] leading-relaxed text-[#a9a9b0]">
              The browser picker lists every open tab, window and screen — pick the platform
              or tab you want to share. Only its sound is sent (~96 kbps); the video capture
              stops instantly, so this costs no CPU to speak of.
            </p>
            <p className="mt-1.5 text-center text-[11px] leading-relaxed text-[#c7c7cd]">
              Local file instead? MP3, M4A, WAV, OGG — stays on your device.
            </p>

            {testMode && (
              <button onClick={startTest} disabled={starting} className="ios-pill-soft mt-4 h-11 w-full text-[13px]">
                <Music2 className="h-4 w-4 text-[#7c7c82]" strokeWidth={2.2} />
                {starting ? 'Starting…' : 'Play demo tune (test mode)'}
              </button>
            )}
          </>
        ) : isSelf ? (
          <>
            <div className="rounded-[18px] bg-[#0d0d0f] px-4 py-4 text-white">
              <div className="flex items-center gap-3">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white/10">
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
                    className="press flex h-11 w-11 items-center justify-center rounded-full bg-white text-[#0d0d0f] active:scale-90"
                  >
                    {music.playing ? <Pause className="h-5 w-5" strokeWidth={2.4} /> : <Play className="h-5 w-5 translate-x-[1px]" strokeWidth={2.4} />}
                  </button>
                ) : (
                  <span className="text-[12px] font-semibold text-white/60">Sharing this tab&apos;s sound</span>
                )}
                <button
                  onClick={stop}
                  className="flex h-11 items-center gap-2 rounded-full bg-[#ff3b30] px-5 text-[14px] font-bold text-white transition-all duration-[130ms] ease-[cubic-bezier(0.34,1.35,0.64,1)] hover:bg-[#eb3329] active:scale-95"
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
            <div className="rounded-[18px] border border-black/[0.05] bg-[#f5f5f7] px-4 py-4">
              <div className="flex items-center gap-3">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#0d0d0f]">
                  <Music2 className="h-5 w-5 text-[#30d158]" strokeWidth={2.2} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[15px] font-bold text-[#0d0d0f]">{music.title}</p>
                  <p className="text-[12px] font-medium text-[#7c7c82]">
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
                <Volume2 className="h-4 w-4 shrink-0 text-[#7c7c82]" strokeWidth={2.2} />
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={Math.round(remoteVol * 100)}
                  onChange={(e) => {
                    const v = Number(e.target.value) / 100
                    setRemoteVol(v)
                    setRemoteMusicVolume(v)
                  }}
                  aria-label="Music volume"
                  className="ios-range flex-1"
                />
                <span className="w-9 text-right font-mono text-[11px] tabular-nums text-[#a9a9b0]">{Math.round(remoteVol * 100)}</span>
              </div>
            </div>
            <p className="mt-3 px-1 text-[12px] leading-relaxed text-[#a9a9b0]">
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
        <div className="mb-4 flex items-start gap-3 rounded-[18px] bg-[#0d0d0f] px-4 py-4 text-white">
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

        <div className="overflow-hidden rounded-[18px] border border-black/[0.05]">
          <div className="flex items-center gap-3 px-4 py-3">
            {passcodeProtected ? (
              <KeyRound className="h-4 w-4 shrink-0 text-[#30d158]" strokeWidth={2.2} />
            ) : (
              <LockOpen className="h-4 w-4 shrink-0 text-[#7c7c82]" strokeWidth={2.2} />
            )}
            <p className="text-[13px] font-medium text-[#3c3c43]">
              {passcodeProtected ? 'Protected with a passcode' : 'Open room — anyone with the link can join'}
            </p>
          </div>
          {PRIVACY_ROWS.map((row, i) => (
            <div key={row.title} className={`flex items-start gap-3 border-t border-black/[0.05] px-4 py-3`}>
              <row.icon className="mt-0.5 h-4 w-4 shrink-0 text-[#7c7c82]" strokeWidth={2.2} />
              <div>
                <p className="text-[14px] font-semibold text-[#0d0d0f]">{row.title}</p>
                <p className="mt-0.5 text-[12px] leading-relaxed text-[#7c7c82]">{row.text}</p>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-4 overflow-hidden rounded-[18px] border border-black/[0.05]">
          {isHost ? (
            <div className="flex items-center justify-between gap-3 px-4 py-3.5">
              <div>
                <p className="text-[14px] font-semibold text-[#0d0d0f]">Lock this call</p>
                <p className="mt-0.5 text-[12px] leading-relaxed text-[#7c7c82]">
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

        <p className="mt-4 px-1 text-[12px] leading-relaxed text-[#a9a9b0]">
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
        <div className="mb-4 flex items-center justify-between rounded-[18px] bg-[#f5f5f7] px-4 py-3">
          <div>
            <p className="text-[15px] font-bold text-[#0d0d0f]">{effective || 'Auto'}</p>
            <p className="text-[12px] font-medium tabular-nums text-[#7c7c82]">Sending ~{bitrate} kbps</p>
          </div>
          <div className="flex items-center gap-2">
            <NetworkBars level={overall} size="md" />
            <span className="text-[12px] font-medium text-[#7c7c82]">{statusLabel}</span>
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
          Audio uses Opus DTX, so silence costs almost nothing. Music in Listen Together steps down
          to 48 kbps on weak links, before your video ever stutters.
        </p>
      </div>
    </Sheet>
  )
}
