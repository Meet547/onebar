'use client'

import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Mic, MicOff, Video, VideoOff, Loader2 } from 'lucide-react'
import { useCallStore } from '@/lib/call/store'
import { createTestStream } from '@/lib/call/test-stream'

type PreviewMode = 'loading' | 'full' | 'audio' | 'none'

interface PreJoinProps {
  roomCode: string
  testMode: boolean
  onBack: () => void
  /** Receives ownership of the preview stream (engine will stop it on leave). */
  onJoin: (stream: MediaStream | null) => void
}

export function PreJoin({ roomCode, testMode, onBack, onJoin }: PreJoinProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const handedOff = useRef(false)
  const [mode, setMode] = useState<PreviewMode>('loading')
  const [displayName, setDisplayName] = useState('')
  const [joining, setJoining] = useState(false)
  const micOn = useCallStore((s) => s.self.micOn)
  const camOn = useCallStore((s) => s.self.camOn)

  useEffect(() => {
    // sync remembered name directly into the DOM (external system)
    if (nameRef.current) {
      nameRef.current.value = window.localStorage.getItem('pico-name') ?? ''
      setDisplayName(nameRef.current.value)
    }
    let cancelled = false

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
  }, [testMode])

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
    onJoin(streamRef.current)
  }

  return (
    <div className="flex min-h-[100dvh] flex-col bg-white">
      <header className="flex items-center gap-3 px-5 py-4">
        <button
          onClick={onBack}
          aria-label="Back"
          className="flex h-9 w-9 items-center justify-center rounded-full bg-[#f2f2f7] text-[#1c1c1e] transition-all active:scale-90"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div>
          <h1 className="text-[16px] font-semibold text-[#1c1c1e]">Ready to join?</h1>
          <p className="font-mono text-[12px] text-[#86868b]">{roomCode}</p>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-5 px-5 pb-10">
        {/* Preview */}
        <div className="relative aspect-[4/3] w-full overflow-hidden rounded-3xl border border-black/[0.06] bg-[#f5f5f7] shadow-sm">
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className={`h-full w-full scale-x-[-1] object-cover ${mode === 'full' ? 'visible' : 'invisible'}`}
          />
          {mode === 'loading' && (
            <div className="absolute inset-0 flex items-center justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-[#aeaeb2]" />
            </div>
          )}
          {mode !== 'loading' && mode !== 'full' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-[#e5e5ea] text-[20px] font-semibold text-[#6e6e73]">
                {(displayName.trim() || 'Guest').slice(0, 2).toUpperCase()}
              </div>
              <p className="text-[13px] font-medium text-[#86868b]">
                {mode === 'audio'
                  ? 'No camera found — you will join with audio only'
                  : 'No camera or mic found — you will join to listen and chat'}
              </p>
            </div>
          )}
          {mode === 'full' && !camOn && (
            <div className="absolute inset-0 flex items-center justify-center bg-[#f5f5f7]/95">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-[#e5e5ea] text-[20px] font-semibold text-[#6e6e73]">
                {(displayName.trim() || 'Guest').slice(0, 2).toUpperCase()}
              </div>
            </div>
          )}
        </div>

        {/* Device toggles */}
        <div className="flex justify-center gap-4">
          <button
            onClick={toggleMic}
            aria-label={micOn ? 'Mute microphone' : 'Unmute microphone'}
            className={`ios-control ${!micOn ? 'ios-control-active' : ''}`}
          >
            {micOn ? <Mic className="h-5 w-5" /> : <MicOff className="h-5 w-5" />}
          </button>
          <button
            onClick={toggleCam}
            aria-label={camOn ? 'Turn camera off' : 'Turn camera on'}
            className={`ios-control ${!camOn ? 'ios-control-active' : ''}`}
          >
            {camOn ? <Video className="h-5 w-5" /> : <VideoOff className="h-5 w-5" />}
          </button>
        </div>

        {/* Name */}
        <div>
          <label htmlFor="pico-name" className="mb-1.5 block px-1 text-[12px] font-semibold text-[#86868b]">
            Your name
          </label>
          <input
            id="pico-name"
            ref={nameRef}
            onChange={(e) => setDisplayName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && join()}
            placeholder="Guest"
            maxLength={24}
            autoFocus
            className="h-12 w-full rounded-2xl border border-black/[0.06] bg-[#f2f2f7] px-4 text-[15px] text-[#1c1c1e] outline-none transition-colors placeholder:text-[#aeaeb2] focus:border-black/[0.16] focus:bg-white"
          />
        </div>

        {/* Join */}
        <button
          onClick={join}
          disabled={joining}
          className="ios-pill w-full bg-[#34c759] text-white shadow-[0_6px_20px_rgba(52,199,89,0.35)] disabled:opacity-70"
        >
          {joining ? <Loader2 className="h-4.5 w-4.5 animate-spin" /> : null}
          {joining ? 'Connecting…' : 'Join call'}
        </button>

        <p className="text-center text-[11.5px] leading-relaxed text-[#aeaeb2]">
          Peer-to-peer call · nothing is recorded
          <br />
          Tip: on a slow connection, pick “Data Saver” in the call's quality menu
        </p>
      </main>
    </div>
  )
}
