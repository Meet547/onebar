'use client'

import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, KeyRound, Loader2, Lock, Mic, MicOff, Video, VideoOff } from 'lucide-react'
import { useCallStore } from '@/lib/call/store'
import { createTestStream } from '@/lib/call/test-stream'

type PreviewMode = 'loading' | 'full' | 'audio' | 'none'

interface RoomInfo {
  exists: boolean
  locked: boolean
  hasPassword: boolean
  count: number
}

interface PreJoinProps {
  roomCode: string
  testMode: boolean
  joinError?: string | null
  onBack: () => void
  /** Receives ownership of the preview stream (engine will stop it on leave). */
  onJoin: (stream: MediaStream | null, passcode: string) => void
}

export function PreJoin({ roomCode, testMode, joinError, onBack, onJoin }: PreJoinProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const handedOff = useRef(false)
  const [mode, setMode] = useState<PreviewMode>('loading')
  const [displayName, setDisplayName] = useState('')
  const [joining, setJoining] = useState(false)
  const [passcode, setPasscode] = useState('')
  const [roomInfo, setRoomInfo] = useState<RoomInfo | null>(null)
  const micOn = useCallStore((s) => s.self.micOn)
  const camOn = useCallStore((s) => s.self.camOn)

  useEffect(() => {
    // sync remembered name directly into the DOM (external system)
    if (nameRef.current) {
      nameRef.current.value = window.localStorage.getItem('pico-name') ?? ''
      setDisplayName(nameRef.current.value)
    }
    let cancelled = false

    // Ask the relay what this room expects — passcode, lock status.
    const info = fetch(`/info?XTransformPort=3004&room=${encodeURIComponent(roomCode)}`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
    void info.then((data: RoomInfo | null) => {
      if (!cancelled && data) setRoomInfo(data)
    })

    const acquire = async () => {
      let stream: MediaStream | null = null
      if (testMode) {
        stream = await createTestStream()
        setMode('full')
      } else {
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
            video: { width: { ideal: 480 }, height: { ideal: 360 }, frameRate: { ideal: 15, max: 24 }, facingMode: 'user' },
          })
          setMode('full')
        } catch {
          try {
            stream = await navigator.mediaDevices.getUserMedia({
              audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
            })
            setMode('audio')
          } catch {
            setMode('none')
          }
        }
      }
      if (cancelled) {
        stream?.getTracks().forEach((t) => t.stop())
        return
      }
      streamRef.current = stream
      if (stream && videoRef.current) {
        videoRef.current.srcObject = stream
        videoRef.current.play().catch(() => undefined)
      }
    }
    void acquire()

    return () => {
      cancelled = true
      // Stop preview only if it was not handed to the engine on join
      if (!handedOff.current) streamRef.current?.getTracks().forEach((t) => t.stop())
    }
  }, [testMode, roomCode])

  const toggleMic = () => {
    const next = !micOn
    useCallStore.getState().setSelf({ micOn: next })
    streamRef.current?.getAudioTracks().forEach((t) => (t.enabled = next))
  }
  const toggleCam = () => {
    const next = !camOn
    useCallStore.getState().setSelf({ camOn: next })
    streamRef.current?.getVideoTracks().forEach((t) => (t.enabled = next))
  }

  const join = () => {
    const clean = nameRef.current?.value.trim() || 'Guest'
    window.localStorage.setItem('pico-name', clean)
    setJoining(true)
    handedOff.current = true
    onJoin(streamRef.current, passcode.trim())
  }

  const initials = (displayName.trim() || 'Guest').slice(0, 2).toUpperCase()
  const needsPasscode = roomInfo?.hasPassword === true

  return (
    <div className="flex min-h-[100dvh] flex-col bg-white">
      <header className="flex items-center gap-3 px-5 py-4">
        <button onClick={onBack} aria-label="Back" className="ios-square press h-9 w-9">
          <ArrowLeft className="h-4 w-4" strokeWidth={2.4} />
        </button>
        <div className="min-w-0">
          <h1 className="text-[17px] font-bold tracking-[-0.01em] text-[#0d0d0f]">Ready to join?</h1>
          <p className="flex items-center gap-1.5 truncate font-mono text-[12px] text-[#7c7c82]">
            {roomInfo?.locked && <Lock className="h-3 w-3 text-[#ff9500]" strokeWidth={2.6} />}
            {roomCode}
          </p>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-[400px] flex-1 flex-col justify-center gap-5 px-5 pb-10">
        {/* Preview */}
        <div className="pico-pop relative aspect-[4/3] w-full overflow-hidden rounded-[24px] border border-black/[0.05] bg-[#f5f5f7]">
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className={`h-full w-full scale-x-[-1] object-cover ${mode === 'full' ? 'visible' : 'invisible'}`}
          />
          {mode === 'loading' && (
            <div className="absolute inset-0 flex items-center justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-[#a9a9b0]" />
            </div>
          )}
          {mode !== 'loading' && mode !== 'full' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-8 text-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-[#e8e8ed] text-[17px] font-bold text-[#7c7c82]">
                {initials}
              </div>
              <p className="text-[13px] font-medium leading-relaxed text-[#7c7c82]">
                {mode === 'audio'
                  ? 'No camera found — you will join with audio only'
                  : 'No camera or mic found — you will join to listen and chat'}
              </p>
            </div>
          )}
          {mode === 'full' && !camOn && (
            <div className="absolute inset-0 flex items-center justify-center bg-[#f5f5f7]/95">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-[#e8e8ed] text-[17px] font-bold text-[#7c7c82]">
                {initials}
              </div>
            </div>
          )}
        </div>

        {joinError && (
          <div
            role="alert"
            className="pico-pop flex items-center gap-2.5 rounded-2xl bg-[#ff3b30]/[0.07] px-4 py-3"
          >
            <p className="text-[13px] font-semibold leading-snug text-[#ff3b30]">{joinError}</p>
          </div>
        )}

        {/* Device toggles */}
        <div className="flex justify-center gap-4">
          <button
            onClick={toggleMic}
            aria-label={micOn ? 'Mute microphone' : 'Unmute microphone'}
            className={`ios-control ${!micOn ? 'ios-control-active' : ''}`}
          >
            <span key={micOn ? 'on' : 'off'} className="pico-icon-swap flex">
              {micOn ? <Mic className="h-5 w-5" strokeWidth={2.2} /> : <MicOff className="h-5 w-5" strokeWidth={2.2} />}
            </span>
          </button>
          <button
            onClick={toggleCam}
            aria-label={camOn ? 'Turn camera off' : 'Turn camera on'}
            className={`ios-control ${!camOn ? 'ios-control-active' : ''}`}
          >
            <span key={camOn ? 'on' : 'off'} className="pico-icon-swap flex">
              {camOn ? <Video className="h-5 w-5" strokeWidth={2.2} /> : <VideoOff className="h-5 w-5" strokeWidth={2.2} />}
            </span>
          </button>
        </div>

        {/* Name */}
        <div>
          <label htmlFor="pico-name" className="mb-1.5 block px-1 text-[12px] font-bold uppercase tracking-[0.08em] text-[#7c7c82]">
            Your name
          </label>
          <input
            id="pico-name"
            ref={nameRef}
            onChange={(e) => setDisplayName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && join()}
            placeholder="Guest"
            maxLength={24}
            autoFocus={!needsPasscode}
            className="ios-field"
          />
        </div>

        {/* Passcode (only when the room has one) */}
        {needsPasscode && (
          <div className="pico-pop">
            <label htmlFor="pico-passcode" className="mb-1.5 flex items-center gap-1.5 px-1 text-[12px] font-bold uppercase tracking-[0.08em] text-[#7c7c82]">
              <KeyRound className="h-3 w-3" strokeWidth={2.6} />
              Passcode
            </label>
            <input
              id="pico-passcode"
              value={passcode}
              onChange={(e) => setPasscode(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && join()}
              placeholder="Enter the room passcode"
              maxLength={24}
              autoFocus
              autoComplete="off"
              className="ios-field"
            />
          </div>
        )}

        {/* Join */}
        <button
          onClick={join}
          disabled={joining || (needsPasscode && passcode.trim().length === 0)}
          className="ios-pill w-full"
        >
          {joining ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {joining ? 'Connecting…' : 'Join call'}
        </button>

        <p className="text-center text-[12px] leading-relaxed text-[#a9a9b0]">
          Peer-to-peer call · encrypted in transit · nothing is recorded
          <br />
          On a slow connection, pick “Data Saver” inside the call
        </p>
      </main>
    </div>
  )
}
