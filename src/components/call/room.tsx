'use client'

import { useEffect, useMemo, useState } from 'react'
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
import { getEngine } from '@/lib/call/engine'
import { useCallStore } from '@/lib/call/store'
import type { ChatMessage, PeerState } from '@/lib/call/types'
import { VideoTile } from './video-tile'
import { NetworkBars } from './network-bars'
import { ChatPanel, MusicPanel, ParticipantsPanel, QualityPanel, SecurityPanel } from './panels'
import { BrandMark, useSpeakingRingSoft } from './brand'

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
    <span className="font-mono text-[12px] tabular-nums text-[#7c7c82]">
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
  badge,
  children,
}: {
  onClick: () => void
  active?: boolean
  danger?: boolean
  label: string
  badge?: number
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`ios-control ${active ? 'ios-control-active' : ''} ${danger ? 'ios-control-danger' : ''}`}
    >
      <span key={label + (active ? '1' : '0') + (danger ? 'd' : '')} className="pico-icon-swap flex">
        {children}
      </span>
      {badge !== undefined && badge > 0 && (
        <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-[#ff3b30] px-1 text-[10px] font-bold text-white">
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
        <div className="flex shrink-0 gap-3 overflow-x-auto pb-1">
          {spotId !== 'self' && (
            <div className="h-20 w-32 shrink-0 pico-pop">
              <VideoTile peerId="self" state={selfState} isSelf />
            </div>
          )}
          {rest.map((p, i) => (
            <div key={p.id} className="h-20 w-32 shrink-0 pico-pop" style={{ animationDelay: `${i * 40}ms` }}>
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
      className="pico-toast-in fixed bottom-[176px] left-1/2 z-30 flex max-w-[min(92vw,380px)] -translate-x-1/2 items-center gap-2.5 rounded-[18px] border border-black/[0.05] bg-white/95 py-2.5 pl-3 pr-3.5 text-left shadow-[0_10px_36px_rgba(0,0,0,0.16)] backdrop-blur-xl sm:bottom-[132px]"
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#0d0d0f] text-[11px] font-bold text-white">
        {msg.name.slice(0, 2).toUpperCase()}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px] font-bold text-[#0d0d0f]">{msg.name}</span>
        <span className="line-clamp-1 block text-[12px] leading-snug text-[#7c7c82]">
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
  const micMeterRef = useSpeakingRingSoft('self', self.micOn)

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
            className="press flex max-w-[140px] items-center gap-1.5 rounded-full bg-[#f5f5f7] py-1.5 pl-3 pr-3 sm:max-w-[180px]"
            title="Copy invite link"
          >
            <span className="truncate font-mono text-[12px] font-medium text-[#0d0d0f]">{roomCode}</span>
            <span className="text-[11px] font-bold uppercase tracking-wide text-[#7c7c82]">Copy</span>
          </button>
        </div>

        <div className="flex shrink-0 items-center gap-2.5">
          {!signaling && <span className="text-[12px] font-semibold text-[#ff9500]">Reconnecting…</span>}
          <button
            onClick={() => setPanel('security')}
            className="press flex items-center gap-1.5 rounded-full bg-[#f5f5f7] py-1.5 pl-2 pr-2.5"
            title="Privacy and security"
            aria-label="Privacy and security"
          >
            <ShieldCheck className="h-3.5 w-3.5 text-[#30d158]" strokeWidth={2.4} />
            <span className="hidden text-[11px] font-bold uppercase tracking-wide text-[#7c7c82] sm:inline">
              Encrypted
            </span>
          </button>
          <span
            className="h-1.5 w-1.5 rounded-full pico-breathe"
            style={{ backgroundColor: peerCount > 0 ? '#30d158' : '#c7c7cd' }}
            title={peerCount > 0 ? 'In call' : 'Waiting for others'}
          />
          <NetworkBars level={overall} />
          <CallTimer />
        </div>
      </header>

      {/* Stage */}
      <main className="relative min-h-0 flex-1 overflow-hidden p-3 sm:p-4">
        <VideoGrid />
        {peerCount === 0 && (
          <div className="pointer-events-none absolute inset-x-0 top-3 flex justify-center px-4">
            <div className="pico-rise rounded-full bg-white/85 px-4 py-2 text-[12px] font-semibold text-[#7c7c82] shadow-[0_1px_6px_rgba(0,0,0,0.06)] backdrop-blur-md">
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
          className="pico-pop mx-auto mb-1 flex max-w-[92vw] items-center gap-2.5 rounded-full bg-[#0d0d0f] py-2 pl-3 pr-4 text-white shadow-[0_8px_28px_rgba(0,0,0,0.22)]"
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
        <div className="control-bar glass flex items-center gap-1 rounded-full border border-black/[0.05] px-2 py-2 shadow-[0_8px_28px_rgba(0,0,0,0.08)] sm:gap-2 sm:px-3">
          <div ref={micMeterRef} className="rounded-full transition-shadow duration-200">
            <ControlButton
              onClick={toggleMic}
              active={!self.micOn}
              label={self.micOn ? 'Mute microphone' : 'Unmute microphone'}
            >
              {self.micOn ? <Mic className="h-[19px] w-[19px]" strokeWidth={2.2} /> : <MicOff className="h-[19px] w-[19px]" strokeWidth={2.2} />}
            </ControlButton>
          </div>
          <ControlButton
            onClick={() => void toggleCam()}
            active={!self.camOn}
            label={self.camOn ? 'Turn camera off' : 'Turn camera on'}
          >
            {self.camOn ? <Video className="h-[19px] w-[19px]" strokeWidth={2.2} /> : <VideoOff className="h-[19px] w-[19px]" strokeWidth={2.2} />}
          </ControlButton>
          <ControlButton onClick={() => void toggleShare()} active={self.sharing} label={self.sharing ? 'Stop sharing' : 'Share screen'}>
            <MonitorUp className="h-[19px] w-[19px]" strokeWidth={2.2} />
          </ControlButton>
          <ControlButton
            onClick={() => setPanel(panel === 'music' ? null : 'music')}
            active={musicActive}
            label="Listen together"
          >
            <Music2 className="h-[19px] w-[19px]" strokeWidth={2.2} />
          </ControlButton>
          <ControlButton onClick={() => setPanel(panel === 'chat' ? null : 'chat')} label="Chat" badge={unread}>
            <MessageSquare className="h-[19px] w-[19px]" strokeWidth={2.2} />
          </ControlButton>
          <ControlButton onClick={() => setPanel(panel === 'people' ? null : 'people')} label="Participants">
            <Users className="h-[19px] w-[19px]" strokeWidth={2.2} />
          </ControlButton>
          <ControlButton onClick={() => setPanel(panel === 'quality' ? null : 'quality')} label="Quality and connection">
            <SlidersHorizontal className="h-[19px] w-[19px]" strokeWidth={2.2} />
          </ControlButton>
          <button
            onClick={leave}
            aria-label="Leave call"
            className="ml-0.5 flex h-[52px] items-center gap-1.5 rounded-full bg-[#ff3b30] px-4 text-[15px] font-bold text-white transition-all duration-[130ms] ease-[cubic-bezier(0.34,1.35,0.64,1)] hover:bg-[#eb3329] active:scale-90 sm:ml-1 sm:px-5"
          >
            <Phone className="h-[17px] w-[17px] rotate-[135deg]" strokeWidth={2.4} />
            <span className="hidden sm:inline">Leave</span>
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
    </div>
  )
}
