'use client'

import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  MessageSquare,
  Mic,
  MicOff,
  MonitorUp,
  Phone,
  SlidersHorizontal,
  Users,
  Video,
  VideoOff,
} from 'lucide-react'
import { getEngine } from '@/lib/call/engine'
import { useCallStore } from '@/lib/call/store'
import type { PeerState } from '@/lib/call/types'
import { VideoTile } from './video-tile'
import { NetworkBars, LEVEL_LABEL } from './network-bars'
import { ChatPanel, ParticipantsPanel, QualityPanel } from './panels'

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
    <span className="font-mono text-[12px] tabular-nums text-[#86868b]">
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
      {children}
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
          {spotId !== 'self' && <div className="h-20 w-32 shrink-0"><VideoTile peerId="self" state={selfState} isSelf /></div>}
          {rest.map((p) => (
            <div key={p.id} className="h-20 w-32 shrink-0">
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
      {peerList.map((p) => (
        <div key={p.id} className={count === 1 ? 'mx-auto aspect-video w-full max-w-3xl' : 'aspect-video'}>
          <VideoTile peerId={p.id} state={p} isSelf={false} />
        </div>
      ))}
    </div>
  )
}

/* ---------------- room ---------------- */

type Panel = 'chat' | 'people' | 'quality' | null

export function Room({ roomCode, onLeave }: { roomCode: string; onLeave: () => void }) {
  const [panel, setPanel] = useState<Panel>(null)
  const self = useCallStore((s) => s.self)
  const unread = useCallStore((s) => s.unreadChat)
  const overall = useCallStore((s) => s.overallLevel)
  const signaling = useCallStore((s) => s.signalingConnected)
  const peerCount = useCallStore((s) => Object.keys(s.peers).length)

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
    const on = await getEngine().toggleShare()
    toast(on ? 'You are sharing your screen' : 'Screen sharing stopped', { duration: 1600 })
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

  return (
    <div className="flex h-[100dvh] flex-col bg-white">
      {/* Header */}
      <header className="glass z-10 flex items-center justify-between gap-2 border-b border-black/[0.05] px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-[9px] bg-[#1c1c1e]">
            <Video className="h-3.5 w-3.5 text-white" strokeWidth={2.4} />
          </div>
          <span className="text-[15px] font-semibold tracking-tight text-[#1c1c1e]">Pico</span>
        </div>

        <button
          onClick={copyLink}
          className="flex max-w-[45%] items-center gap-1.5 rounded-full bg-[#f2f2f7] px-3 py-1.5 transition-all active:scale-95"
          title="Copy invite link"
        >
          <span className="truncate font-mono text-[12px] font-medium text-[#1c1c1e]">{roomCode}</span>
          <span className="text-[11px] font-semibold text-[#34c759]">Copy</span>
        </button>

        <div className="flex items-center gap-2.5">
          {!signaling && <span className="text-[11px] font-medium text-[#ff9500]">Reconnecting…</span>}
          <span
            className="h-1.5 w-1.5 rounded-full pico-pulse"
            style={{ backgroundColor: peerCount > 0 ? '#34c759' : '#aeaeb2' }}
            title={peerCount > 0 ? 'In call' : 'Waiting for others'}
          />
          <NetworkBars level={overall} />
          <span className="hidden text-[11px] text-[#aeaeb2] sm:inline" title={LEVEL_LABEL[overall]}>
            {LEVEL_LABEL[overall].split(' ')[0]}
          </span>
          <CallTimer />
        </div>
      </header>

      {/* Stage */}
      <main className="relative min-h-0 flex-1 overflow-hidden p-3 sm:p-4">
        <VideoGrid />
        {peerCount === 0 && (
          <div className="pointer-events-none absolute inset-x-0 top-3 flex justify-center px-4">
            <div className="pico-slide-up rounded-full bg-white/85 px-4 py-2 text-[12px] font-medium text-[#86868b] shadow-sm backdrop-blur-md">
              Share the code <span className="font-mono font-semibold text-[#1c1c1e]">{roomCode}</span> to invite someone
            </div>
          </div>
        )}
      </main>

      {/* Control bar */}
      <nav
        className="safe-bottom z-20 flex justify-center pb-4 pt-1"
        aria-label="Meeting controls"
      >
        <div className="glass flex items-center gap-2 rounded-full border border-black/[0.06] px-3 py-2 shadow-[0_8px_32px_rgba(0,0,0,0.10)]">
          <ControlButton onClick={toggleMic} active={!self.micOn} label={self.micOn ? 'Mute microphone' : 'Unmute microphone'}>
            {self.micOn ? <Mic className="h-[19px] w-[19px]" /> : <MicOff className="h-[19px] w-[19px]" />}
          </ControlButton>
          <ControlButton onClick={() => void toggleCam()} active={!self.camOn} label={self.camOn ? 'Turn camera off' : 'Turn camera on'}>
            {self.camOn ? <Video className="h-[19px] w-[19px]" /> : <VideoOff className="h-[19px] w-[19px]" />}
          </ControlButton>
          <ControlButton onClick={() => void toggleShare()} active={self.sharing} label={self.sharing ? 'Stop sharing' : 'Share screen'}>
            <MonitorUp className="h-[19px] w-[19px]" />
          </ControlButton>
          <ControlButton onClick={() => setPanel(panel === 'chat' ? null : 'chat')} label="Chat" badge={unread}>
            <MessageSquare className="h-[19px] w-[19px]" />
          </ControlButton>
          <ControlButton onClick={() => setPanel(panel === 'people' ? null : 'people')} label="Participants">
            <Users className="h-[19px] w-[19px]" />
          </ControlButton>
          <ControlButton onClick={() => setPanel(panel === 'quality' ? null : 'quality')} label="Quality and connection">
            <SlidersHorizontal className="h-[19px] w-[19px]" />
          </ControlButton>
          <button
            onClick={leave}
            aria-label="Leave call"
            className="ml-1 flex h-[52px] items-center gap-1.5 rounded-full bg-[#ff3b30] px-5 text-[14px] font-semibold text-white transition-all duration-150 ease-out active:scale-90"
          >
            <Phone className="h-[17px] w-[17px] rotate-[135deg]" />
            <span className="hidden sm:inline">Leave</span>
          </button>
        </div>
      </nav>

      {/* Panels */}
      {panel === 'chat' && <ChatPanel onClose={() => setPanel(null)} />}
      {panel === 'people' && <ParticipantsPanel onClose={() => setPanel(null)} roomCode={roomCode} />}
      {panel === 'quality' && <QualityPanel onClose={() => setPanel(null)} />}
    </div>
  )
}
