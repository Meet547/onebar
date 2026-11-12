'use client'

import { useEffect, useRef, memo } from 'react'
import { MicOff, MonitorUp } from 'lucide-react'
import { getStream } from '@/lib/call/store'
import type { PeerState } from '@/lib/call/types'
import { NetworkBars } from './network-bars'

const AVATAR_TONES = ['#E8E3DA', '#E3EDE4', '#EAE6F2', '#F2E8E0', '#E0EBF0', '#F0E0E8']

function toneFor(id: string): string {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return AVATAR_TONES[h % AVATAR_TONES.length]
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return name.slice(0, 2).toUpperCase() || '?'
}

interface VideoTileProps {
  peerId: string
  state: PeerState
  isSelf: boolean
  large?: boolean
}

/**
 * Video tile. The <video> element is created once and streams are attached
 * imperatively — streaming never causes React re-renders, keeping CPU cost
 * near zero. Presence flags (mic/cam/share/level) come in as tiny props.
 */
export const VideoTile = memo(function VideoTile({ peerId, state, isSelf, large }: VideoTileProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamVersion = state.streamVersion
  const { sharing, camOn, micOn, level, hasStream } = state

  // Attach the stream whenever its identity may have changed
  useEffect(() => {
    const el = videoRef.current
    if (!el) return
    const stream = getStream(peerId)
    if (stream && el.srcObject !== stream) {
      el.srcObject = stream
      el.play().catch(() => undefined)
    }
    if (!stream && el.srcObject) {
      el.srcObject = null
    }
  }, [peerId, streamVersion, sharing, hasStream])

  const hasVideo =
    hasStream && getStream(peerId)?.getVideoTracks().some((t) => t.readyState === 'live') === true
  const showAvatar = !hasVideo || !camOn

  return (
    <div
      className={`relative overflow-hidden rounded-2xl transition-colors duration-300 ${
        showAvatar ? 'border border-black/[0.06] bg-[#f5f5f7]' : 'bg-neutral-900'
      } ${large ? 'h-full w-full' : ''}`}
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={isSelf}
        className={`h-full w-full object-cover ${isSelf && !sharing ? 'scale-x-[-1]' : ''} ${
          showAvatar ? 'invisible' : 'visible'
        }`}
      />

      {/* Avatar placeholder when the camera is off */}
      {showAvatar && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div
            className="flex items-center justify-center rounded-full font-semibold text-[#6e6e73]"
            style={{
              width: large ? 96 : 56,
              height: large ? 96 : 56,
              fontSize: large ? 30 : 18,
              backgroundColor: toneFor(peerId),
            }}
          >
            {initials(state.name)}
          </div>
        </div>
      )}

      {/* Name + mic chip */}
      <div className="absolute bottom-2 left-2 flex max-w-[calc(100%-16px)] items-center gap-1.5 rounded-full bg-black/45 px-2.5 py-1 backdrop-blur-md">
        {!micOn && <MicOff className="h-3 w-3 shrink-0 text-[#ff453a]" aria-hidden />}
        {sharing && <MonitorUp className="h-3 w-3 shrink-0 text-white" aria-hidden />}
        <span className="truncate text-[11px] font-medium text-white">
          {state.name}
          {isSelf ? ' (You)' : ''}
        </span>
      </div>

      {/* Network quality (remote peers only) */}
      {!isSelf && (
        <div className="absolute right-2 top-2 rounded-full bg-black/35 px-1.5 py-1.5 backdrop-blur-md">
          <NetworkBars level={level} />
        </div>
      )}
    </div>
  )
})
