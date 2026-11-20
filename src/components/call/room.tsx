'use client'

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  MessageSquare,
  Mic,
  MicOff,
  MonitorUp,
  Music2,
  Phone,
  ShieldCheck,
  SlidersHorizontal,
  Users,
  Video,
  VideoOff,
} from 'lucide-react'
import { SHED_ROOM_SIZE, getEngine } from '@/lib/call/engine'
import { useCallStore } from '@/lib/call/store'
import type { ChatMessage, PeerState } from '@/lib/call/types'
import { subscribeLevel } from '@/lib/call/audio-levels'
import { VideoTile } from './video-tile'
import { LEVEL_LABEL, NetworkBars } from './network-bars'
import { ChatPanel, MusicPanel, ParticipantsPanel, QualityPanel, SecurityPanel } from './panels'
import { DebugOverlay } from './debug-overlay'
import { BrandMark, useSpeakingRingSoft } from './brand'

/* ---- receive-side shedding constants (task 7) ---- */
/** Loudness above which a peer counts as "speaking" (audio-levels 0..1). */
const SPEAKER_LEVEL_THRESHOLD = 0.18
/** A speaker stays "recently active" this long after their last burst. */
const SPEAKER_MEMORY_MS = 2500
/** A speaker change must hold this long before we re-wish — anti-flap. */
const SPEAKER_COMMIT_MS = 3000

/* ---------------- call timer (isolated: re-renders once per second) ---------------- */

function CallTimer() {
  const [secs, setSecs] = useState(0)
  useEffect(() => {
    const t = window.setInterval(() => setSecs((s) => s + 1), 1000)
    return () => window.clearInterval(t)
  }, [])
  const mm = String(Math.floor(secs / 60)).padStart(2, '0')
  const ss = String(secs % 60).padStart(2, '0')
  return (
    <span className="font-mono text-[12px] tabular-nums text-[#62626a]">
      {mm}:{ss}
    </span>
  )
}

/* ---------------- control bar ---------------- */

function ControlButton({
  onClick,
  active,
  danger,
  label,
  displayLabel,
  shortcut,
  badge,
  children,
}: {
  onClick: () => void
  active?: boolean
  danger?: boolean
  label: string
  displayLabel?: string
  shortcut?: string
  badge?: number
  children: React.ReactNode
}) {
  const labelId = useId()
  return (
    <button
      onClick={onClick}
      aria-labelledby={`${labelId}-visible ${labelId}-action`}
      className={`ios-control control-action ${active ? 'ios-control-active' : ''} ${danger ? 'ios-control-danger' : ''}`}
    >
      <span key={label + (active ? '1' : '0') + (danger ? 'd' : '')} className="pico-icon-swap flex">
        {children}
      </span>
      <span id={`${labelId}-visible`} className="hidden items-center gap-1 text-[12px] font-semibold leading-none tracking-[-0.01em] md:inline-flex">
        {displayLabel ?? label}
        {shortcut && <kbd className="rounded-sm border border-current/20 px-1 py-0.5 font-mono text-[9px] font-semibold opacity-70">{shortcut}</kbd>}
      </span>
      <span id={`${labelId}-action`} className="sr-only">{label}</span>
      {badge !== undefined && badge > 0 && (
        <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-[#d62f25] px-1 text-[10px] font-bold text-white">
          {badge > 9 ? '9+' : badge}
        </span>
      )}
    </button>
  )
}

/* ---------------- video grid ---------------- */

function gridCols(count: number): string {
  if (count <= 1) return 'grid-cols-1'
  if (count <= 2) return 'grid-cols-1 sm:grid-cols-2'
  if (count <= 4) return 'grid-cols-2'
  if (count <= 6) return 'grid-cols-2 lg:grid-cols-3'
  return 'grid-cols-2 lg:grid-cols-4'
}

function VideoGrid() {
  const self = useCallStore((s) => s.self)
  const peers = useCallStore((s) => s.peers)
  const spotlight = useCallStore((s) => s.spotlight)
  const overallLevel = useCallStore((s) => s.overallLevel)

  const selfState: PeerState = useMemo(
    () => ({
      id: self.id || 'self',
      name: self.name || 'You',
      micOn: self.micOn,
      camOn: self.camOn,
      sharing: self.sharing,
      level: overallLevel,
      hasStream: true,
      streamVersion: self.sharing ? 1 : 0,
    }),
    [self, overallLevel],
  )

  const peerList = useMemo(() => Object.values(peers), [peers])
  const count = peerList.length + 1
  const spotId = spotlight

  const spotState: PeerState | null =
    spotId === 'self' ? selfState : spotId ? peers[spotId] ?? null : null

  if (spotId && spotState) {
    const rest = spotId === 'self' ? peerList : peerList.filter((p) => p.id !== spotId)
    return (
      <div className="flex h-full w-full flex-col gap-3">
        <div className="min-h-0 flex-1 pico-pop">
          <VideoTile peerId={spotId === 'self' ? 'self' : spotId} state={spotState} isSelf={spotId === 'self'} large />
        </div>
        <div className="pico-carousel flex shrink-0 gap-3 overflow-x-auto pb-1">
          {spotId !== 'self' && (
            <div className="h-20 w-32 shrink-0 pico-pop">
              <VideoTile peerId="self" state={selfState} isSelf />
            </div>
          )}
          {rest.map((p, i) => (
            <div
              key={p.id}
              data-peer-id={p.id}
              className="h-20 w-32 shrink-0 pico-pop"
              style={{ animationDelay: `${i * 40}ms` }}
            >
              <VideoTile peerId={p.id} state={p} isSelf={false} />
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className={`grid h-full w-full content-center gap-3 ${gridCols(count)}`}>
      <div className={count === 1 ? 'mx-auto aspect-video w-full max-w-3xl' : 'aspect-video'}>
        <VideoTile peerId="self" state={selfState} isSelf />
      </div>
      {peerList.map((p, i) => (
        <div
          key={p.id}
          data-peer-id={p.id}
          className={`pico-pop ${count === 1 ? 'mx-auto aspect-video w-full max-w-3xl' : 'aspect-video'}`}
          style={{ animationDelay: `${(i + 1) * 50}ms` }}
        >
          <VideoTile peerId={p.id} state={p} isSelf={false} />
        </div>
      ))}
    </div>
  )
}

/* ---------------- incoming-chat preview (chat closed) ---------------- */

/**
 * Floating preview of the latest incoming message, shown only while the chat
 * panel is CLOSED. One subscription on the store (fires per mutation, does a
 * length compare — nanoseconds), one element, pure-CSS entrance. Clicking it
 * opens the chat; it dismisses itself after a few seconds.
 */
function ChatPreview({ onOpen }: { onOpen: () => void }) {
  const [msg, setMsg] = useState<ChatMessage | null>(null)

  useEffect(() => {
    return useCallStore.subscribe((s, prev) => {
      if (s.chat.length <= prev.chat.length) return
      const m = s.chat[s.chat.length - 1]
      if (m && !m.system && m.from !== s.self.id) setMsg(m)
    })
  }, [])

  useEffect(() => {
    if (!msg) return
    const t = window.setTimeout(() => setMsg(null), 5200)
    return () => window.clearTimeout(t)
  }, [msg])

  if (!msg) return null
  return (
    <button
      key={msg.id}
      onClick={() => {
        setMsg(null)
        onOpen()
      }}
      aria-label="Open chat"
      className="pico-toast-in fixed bottom-[176px] left-1/2 z-30 flex max-w-[min(92vw,380px)] -translate-x-1/2 items-center gap-2.5 rounded-md border border-black/[0.05] bg-white/95 py-2.5 pl-3 pr-3.5 text-left shadow-[0_10px_36px_rgba(0,0,0,0.16)] backdrop-blur-xl sm:bottom-[132px]"
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#0d0d0f] text-[11px] font-bold text-white">
        {msg.name.slice(0, 2).toUpperCase()}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px] font-bold text-[#0d0d0f]">{msg.name}</span>
        <span className="line-clamp-1 block text-[12px] leading-snug text-[#62626a]">
          {msg.replyTo ? `↩ ${msg.text}` : msg.text}
        </span>
      </span>
      <MessageSquare className="h-4 w-4 shrink-0 text-[#30d158]" strokeWidth={2.4} />
    </button>
  )
}

/* ---------------- room ---------------- */

type Panel = 'chat' | 'people' | 'quality' | 'music' | 'security' | null

export function Room({ roomCode, onLeave }: { roomCode: string; onLeave: () => void }) {
  const [panel, setPanel] = useState<Panel>(null)
  const self = useCallStore((s) => s.self)
  const unread = useCallStore((s) => s.unreadChat)
  const overall = useCallStore((s) => s.overallLevel)
  const signaling = useCallStore((s) => s.signalingConnected)
  const peerCount = useCallStore((s) => Object.keys(s.peers).length)
  const music = useCallStore((s) => s.music)
  const lite = useCallStore((s) => s.lite)
  const spotlight = useCallStore((s) => s.spotlight)
  const micMeterRef = useSpeakingRingSoft('self', self.micOn)
  const debugOn = useMemo(() => new URLSearchParams(window.location.search).has('debug'), [])

  /* ---- receive-side video interest (task 7) ----
     visibleRef: remote peer ids whose tile is actually on screen
     (IntersectionObserver on the grid). speakerRef: active speaker after a
     commit hysteresis. Background tab, lite mode, or rooms ≥ SHED_ROOM_SIZE
     shrink the interest set to speaker + spotlight; senders on the other
     side pause their encoders toward peers nobody watches. */
  const visibleRef = useRef(new Set<string>())
  const speakerRef = useRef<string | null>(null)
  const [speaker, setSpeaker] = useState<string | null>(null)

  const recomputeInterest = useCallback(() => {
    const s = useCallStore.getState()
    const ids = Object.keys(s.peers)
    const bg = document.visibilityState === 'hidden'
    const size = ids.length + 1
    const wanted =
      bg || s.lite || size >= SHED_ROOM_SIZE
        ? ids.filter((id) => id === speakerRef.current || id === s.spotlight)
        : ids.filter((id) => visibleRef.current.has(id))
    getEngine().setVideoInterest(wanted)
  }, [])

  // Active speaker: audio-levels ticks update a Map (no React), one commit
  // pass per second with a SPEAKER_COMMIT_MS hold — a passing cough never
  // re-wishes the room.
  useEffect(() => {
    const lastLoud = new Map<string, number>()
    let candidate: string | null = null
    let candidateSince = 0
    const commit = window.setInterval(() => {
      const now = Date.now()
      let best: string | null = null
      let bestTs = 0
      for (const [id, ts] of lastLoud) {
        if (now - ts > SPEAKER_MEMORY_MS) {
          lastLoud.delete(id)
          continue
        }
        if (ts > bestTs) {
          bestTs = ts
          best = id
        }
      }
      if (best !== candidate) {
        candidate = best
        candidateSince = now
      }
      if (now - candidateSince < SPEAKER_COMMIT_MS) return
      if (candidate !== speakerRef.current) {
        speakerRef.current = candidate
        setSpeaker(candidate)
      }
    }, 1000)
    const ids = Object.keys(useCallStore.getState().peers)
    const subs = ids.map((id) =>
      subscribeLevel(id, (level) => {
        if (level > SPEAKER_LEVEL_THRESHOLD) lastLoud.set(id, Date.now())
      }),
    )
    return () => {
      window.clearInterval(commit)
      subs.forEach((u) => u())
    }
  }, [peerCount])

  // Tile visibility: observe the grid wrappers; new peers start optimistic
  // (visible) until the observer reports otherwise.
  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) => {
        let changed = false
        for (const e of entries) {
          const id = (e.target as HTMLElement).dataset.peerId
          if (!id || id === 'self') continue
          if (e.isIntersecting && !visibleRef.current.has(id)) {
            visibleRef.current.add(id)
            changed = true
          } else if (!e.isIntersecting && visibleRef.current.has(id)) {
            visibleRef.current.delete(id)
            changed = true
          }
        }
        if (changed) recomputeInterest()
      },
      { threshold: 0.2 },
    )
    visibleRef.current = new Set(Object.keys(useCallStore.getState().peers))
    document.querySelectorAll<HTMLElement>('[data-peer-id]').forEach((n) => {
      const id = n.dataset.peerId
      if (id && id !== 'self') io.observe(n)
    })
    recomputeInterest()
    return () => io.disconnect()
  }, [peerCount, recomputeInterest])

  // Background tab: shed everything but speaker/spotlight, restore on return.
  useEffect(() => {
    const onVis = () => recomputeInterest()
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [recomputeInterest])

  // Any interest input change re-wishes (lite toggle, spotlight, speaker).
  useEffect(() => {
    recomputeInterest()
  }, [speaker, spotlight, lite, recomputeInterest])

  // opening the chat clears the unread badge
  useEffect(() => {
    if (panel === 'chat') useCallStore.getState().clearUnread()
  }, [panel, unread])

  const toggleMic = () => {
    const on = getEngine().toggleMic()
    toast(on ? 'Microphone on' : 'Microphone muted', { duration: 1200 })
  }
  const toggleCam = async () => {
    const on = await getEngine().toggleCam()
    toast(on ? 'Camera on' : 'Camera off', { duration: 1200 })
  }
  const toggleShare = async () => {
    const result = await getEngine().toggleShare()
    if (result === 'started') toast('You are sharing your screen', { duration: 1600 })
    else if (result === 'stopped') toast('Screen sharing stopped', { duration: 1600 })
    else toast('Screen share cancelled', { duration: 1400 })
  }
  const leave = () => {
    getEngine().leave()
    onLeave()
  }
  const copyLink = async () => {
    const link = `${window.location.origin}/?room=${roomCode}`
    try {
      await navigator.clipboard.writeText(link)
      toast('Invite link copied', { duration: 1600 })
    } catch {
      toast('Copy failed — the code is shown above', { duration: 2000 })
    }
  }

  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.repeat) return
      const target = event.target
      const isTyping = target instanceof HTMLElement && target.closest('input, textarea, select, [contenteditable="true"]')
      if (isTyping && event.key !== 'Escape') return

      const key = event.key.toLowerCase()
      if (key === 'm') {
        event.preventDefault()
        toggleMic()
      } else if (key === 'v') {
        event.preventDefault()
        void toggleCam()
      } else if (key === 'c') {
        event.preventDefault()
        setPanel((current) => (current === 'chat' ? null : 'chat'))
      } else if (event.key === 'Escape' && panel) {
        setPanel(null)
      }
    }
    window.addEventListener('keydown', onShortcut)
    return () => window.removeEventListener('keydown', onShortcut)
  }, [panel, toggleCam, toggleMic])

  const musicActive = music.peerId !== null

  return (
    <div className="flex h-[100dvh] flex-col bg-white">
      {/* Header */}
      <header className="glass z-10 flex items-center justify-between gap-2 border-b border-black/[0.05] px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <BrandMark size={28} radius={9} animate={false} />
          <span className="hidden text-[15px] font-extrabold tracking-[-0.02em] text-[#0d0d0f] sm:inline">
            Pico
          </span>
          <button
            onClick={copyLink}
            className="press flex max-w-[140px] items-center gap-1.5 rounded-md bg-[#f5f5f7] py-1.5 pl-3 pr-3 sm:max-w-[180px]"
            title="Copy invite link"
          >
            <span className="truncate font-mono text-[12px] font-medium text-[#0d0d0f]">{roomCode}</span>
            <span className="text-[11px] font-bold uppercase tracking-wide text-[#62626a]">Copy</span>
          </button>
        </div>

        <div className="flex shrink-0 items-center gap-2.5">
          {!signaling && <span className="text-[12px] font-semibold text-[#ff9500]">Reconnecting…</span>}
          <button
            onClick={() => setPanel('security')}
            className="press flex items-center gap-1.5 rounded-md bg-[#f5f5f7] py-1.5 pl-2 pr-2.5"
            title="Privacy and security"
            aria-label="Encrypted — privacy and security"
          >
            <ShieldCheck className="h-3.5 w-3.5 text-[#30d158]" strokeWidth={2.4} />
            <span className="hidden text-[11px] font-bold uppercase tracking-wide text-[#62626a] sm:inline">
              Encrypted
            </span>
          </button>
          <span
            className="h-1.5 w-1.5 rounded-full pico-breathe"
            style={{ backgroundColor: peerCount > 0 ? '#30d158' : '#c7c7cd' }}
            title={peerCount > 0 ? 'In call' : 'Waiting for others'}
          />
          <button
            type="button"
            onClick={() => setPanel('quality')}
            aria-label={`${LEVEL_LABEL[overall]}. Open connection settings`}
            title={`${LEVEL_LABEL[overall]} — open connection settings`}
            className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px] font-semibold text-[#62626a] hover:bg-[#f5f5f7]"
          >
            <NetworkBars level={overall} />
            <span className="hidden md:inline">{LEVEL_LABEL[overall]}</span>
          </button>
          <CallTimer />
        </div>
      </header>

      {/* Stage */}
      <main className="relative min-h-0 flex-1 overflow-hidden p-3 sm:p-4">
        <VideoGrid />
        {peerCount === 0 && (
          <div className="pointer-events-none absolute inset-x-0 top-3 flex justify-center px-4">
            <div className="pico-rise rounded-md bg-white/85 px-4 py-2 text-[12px] font-semibold text-[#62626a] shadow-[0_1px_6px_rgba(0,0,0,0.06)] backdrop-blur-md">
              Share <span className="font-mono font-bold text-[#0d0d0f]">{roomCode}</span> to invite someone
            </div>
          </div>
        )}
      </main>

      {/* Now playing pill */}
      {musicActive && panel !== 'music' && (
        <button
          onClick={() => setPanel('music')}
          aria-label="Open music panel"
          className="pico-pop mx-auto mb-1 flex max-w-[92vw] items-center gap-2.5 rounded-md bg-[#0d0d0f] py-2 pl-3 pr-4 text-white shadow-[0_8px_28px_rgba(0,0,0,0.22)]"
        >
          <Music2 className="h-4 w-4 shrink-0 text-[#30d158]" strokeWidth={2.4} />
          <span className="min-w-0 truncate text-[13px] font-semibold">{music.title}</span>
          <span className="flex shrink-0 items-end gap-[2px]" aria-hidden>
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="eq-bar eq-bar-dark h-2.5"
                style={{ animationDelay: `${i * 160}ms`, animationPlayState: music.playing ? 'running' : 'paused' }}
              />
            ))}
          </span>
        </button>
      )}

      {/* Control bar */}
      <nav className="safe-bottom z-20 flex justify-center pb-4 pt-1" aria-label="Meeting controls">
        <div className="control-bar glass flex items-center gap-1 rounded-md border border-black/[0.05] px-2 py-2 shadow-[0_8px_28px_rgba(0,0,0,0.08)] sm:gap-2 sm:px-3">
          <div ref={micMeterRef} className="rounded-md transition-shadow duration-200">
            <ControlButton
              onClick={toggleMic}
              active={!self.micOn}
              label={self.micOn ? 'Mute microphone' : 'Unmute microphone'}
              displayLabel="Mic"
              shortcut="M"
            >
              {self.micOn ? <Mic className="h-[19px] w-[19px]" strokeWidth={2.2} /> : <MicOff className="h-[19px] w-[19px]" strokeWidth={2.2} />}
            </ControlButton>
          </div>
          <ControlButton
            onClick={() => void toggleCam()}
            active={!self.camOn}
            label={self.camOn ? 'Turn camera off' : 'Turn camera on'}
            displayLabel="Cam"
            shortcut="V"
          >
            {self.camOn ? <Video className="h-[19px] w-[19px]" strokeWidth={2.2} /> : <VideoOff className="h-[19px] w-[19px]" strokeWidth={2.2} />}
          </ControlButton>
          <ControlButton onClick={() => void toggleShare()} active={self.sharing} label={self.sharing ? 'Stop sharing' : 'Share screen'} displayLabel={self.sharing ? 'Stop' : 'Share'}>
            <MonitorUp className="h-[19px] w-[19px]" strokeWidth={2.2} />
          </ControlButton>
          <ControlButton
            onClick={() => setPanel(panel === 'music' ? null : 'music')}
            active={musicActive}
            label="Listen together"
            displayLabel="Music"
          >
            <Music2 className="h-[19px] w-[19px]" strokeWidth={2.2} />
          </ControlButton>
          <ControlButton onClick={() => setPanel(panel === 'chat' ? null : 'chat')} label="Chat" displayLabel="Chat" shortcut="C" badge={unread}>
            <MessageSquare className="h-[19px] w-[19px]" strokeWidth={2.2} />
          </ControlButton>
          <ControlButton onClick={() => setPanel(panel === 'people' ? null : 'people')} label="Participants" displayLabel="People">
            <Users className="h-[19px] w-[19px]" strokeWidth={2.2} />
          </ControlButton>
          <ControlButton onClick={() => setPanel(panel === 'quality' ? null : 'quality')} label="Quality and connection" displayLabel="Quality">
            <SlidersHorizontal className="h-[19px] w-[19px]" strokeWidth={2.2} />
          </ControlButton>
          <button
            onClick={leave}
            aria-label="Leave call"
            title="Leave call"
            className="ml-0.5 flex h-[52px] items-center gap-1.5 rounded-md bg-[#d62f25] px-4 text-[14px] font-semibold tracking-[-0.01em] text-white transition-all duration-[130ms] ease-[cubic-bezier(0.22,1,0.36,1)] hover:bg-[#bf2920] active:scale-90 sm:ml-1 sm:px-5"
          >
            <Phone className="h-[17px] w-[17px] rotate-[135deg]" strokeWidth={2.4} />
            <span className="hidden md:inline">Leave</span>
          </button>
        </div>
      </nav>

      {/* Panels */}
      {panel === 'chat' && <ChatPanel onClose={() => setPanel(null)} />}
      {panel !== 'chat' && <ChatPreview onOpen={() => setPanel('chat')} />}
      {panel === 'people' && <ParticipantsPanel onClose={() => setPanel(null)} roomCode={roomCode} />}
      {panel === 'quality' && <QualityPanel onClose={() => setPanel(null)} />}
      {panel === 'music' && <MusicPanel onClose={() => setPanel(null)} />}
      {panel === 'security' && <SecurityPanel onClose={() => setPanel(null)} />}
      {debugOn && <DebugOverlay />}
    </div>
  )
}
