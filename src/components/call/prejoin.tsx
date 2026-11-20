'use client'

import { readDisplayName, saveDisplayName } from '@/lib/call/preferences'

import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, KeyRound, Loader2, Lock, Mic, MicOff, Video, VideoOff } from 'lucide-react'
import { useCallStore } from '@/lib/call/store'
import { createTestStream } from '@/lib/call/test-stream'
import { ROOM_INFO_URL } from '@/lib/call/config'

const stopPreview = (stream: MediaStream | null) => {
  ;(stream as (MediaStream & { __stop?: () => void }) | null)?.__stop?.()
  stream?.getTracks().forEach(track => track.stop())
}

type PreviewMode = 'loading' | 'full' | 'audio' | 'none'

interface DeviceEntry {
  deviceId: string
  label: string
}

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
  /** Receives ownership of the preview stream (engine will stop it on leave).
   *  Rejects (or resolves) when the attempt is over — failed attempts keep the
   *  caller on this screen with a live preview, ready to retry. */
  onJoin: (stream: MediaStream | null, passcode: string) => boolean | void | Promise<boolean | void>
}

const AUDIO_BASE = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }

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
  // Device pickers: labels only exist AFTER a successful getUserMedia.
  const [mics, setMics] = useState<DeviceEntry[]>([])
  const [cams, setCams] = useState<DeviceEntry[]>([])
  const [selMic, setSelMic] = useState('')
  const [selCam, setSelCam] = useState('')
  const mediaNotice = useCallStore((s) => s.mediaNotice)
  const setMediaNotice = useCallStore((s) => s.setMediaNotice)
  const [retryTick, setRetryTick] = useState(0)
  const micOn = useCallStore((s) => s.self.micOn)
  const camOn = useCallStore((s) => s.self.camOn)

  useEffect(() => {
    // sync remembered name directly into the DOM (external system)
    if (nameRef.current) {
      nameRef.current.value = readDisplayName()
      setDisplayName(nameRef.current.value)
    }
    let cancelled = false
    const controller = new AbortController()

    // Ask the relay what this room expects — passcode, lock status.
    const info = fetch(`${ROOM_INFO_URL}${ROOM_INFO_URL.includes('?') ? '&' : '?'}room=${encodeURIComponent(roomCode)}`, { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
    void info.then((data: RoomInfo | null) => {
      if (!cancelled && data) setRoomInfo(data)
    })

    const listDevices = async () => {
      try {
        const all = await navigator.mediaDevices.enumerateDevices()
        setMics(
          all
            .filter((d) => d.kind === 'audioinput')
            .map((d) => ({ deviceId: d.deviceId, label: d.label || 'Microphone' })),
        )
        setCams(
          all
            .filter((d) => d.kind === 'videoinput')
            .map((d) => ({ deviceId: d.deviceId, label: d.label || 'Camera' })),
        )
      } catch {
        /* no device list — the selects simply stay hidden */
      }
    }

    const acquire = async () => {
      let stream: MediaStream | null = null
      setMediaNotice(null)
      if (testMode) {
        stream = await createTestStream()
        setMode('full')
      } else {
        // Exact device when the user picked one; otherwise the OS default.
        const audio = selMic ? { ...AUDIO_BASE, deviceId: { exact: selMic } } : AUDIO_BASE
        const video = selCam
          ? { width: { ideal: 480 }, height: { ideal: 360 }, frameRate: { ideal: 15, max: 24 }, facingMode: 'user', deviceId: { exact: selCam } }
          : { width: { ideal: 480 }, height: { ideal: 360 }, frameRate: { ideal: 15, max: 24 }, facingMode: 'user' }
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio, video })
          setMode('full')
        } catch (videoErr) {
          // Video alone failing is normal (no camera / camera busy) — the
          // audio attempt decides the notice.
          try {
            stream = await navigator.mediaDevices.getUserMedia({ audio })
            setMode('audio')
          } catch (e) {
            const name = (e as DOMException)?.name ?? ''
            setMode('none')
            setMediaNotice(
              name === 'NotAllowedError'
                ? 'Microphone and camera access is blocked. Allow access in this site’s browser settings, then retry. You can still join without them.'
                : name === 'NotFoundError'
                  ? 'No microphone was found. Connect one or join to listen and chat.'
                  : name === 'NotReadableError'
                    ? 'Your microphone or camera is being used by another app. Close that app, then retry.'
                    : 'Your microphone or camera is unavailable right now. Check your device settings, then retry or join to listen and chat.',
            )
            void videoErr // inspected only for debugging; the audio error is what matters
          }
        }
      }
      if (cancelled) {
        stopPreview(stream)
        return
      }
      streamRef.current = stream
      if (stream && videoRef.current) {
        videoRef.current.srcObject = stream
        videoRef.current.play().catch(() => undefined)
      }
      if (stream) void listDevices()
    }
    void acquire()

    return () => {
      cancelled = true
      // Stop preview only if it was not handed to the engine on join
      controller.abort()
      if (!handedOff.current) stopPreview(streamRef.current)
    }
  }, [testMode, roomCode, selMic, selCam, retryTick])

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
    saveDisplayName(clean)
    setJoining(true)
    handedOff.current = true
    Promise.resolve(onJoin(streamRef.current, passcode.trim()))
      .then((ok) => {
        if (ok !== false) return // success — the engine owns the stream now
        // A rejected attempt (wrong passcode, locked, full room) lands back on
        // this screen: re-arm the button and keep the preview alive so the
        // user can simply fix the passcode and try again.
        setJoining(false)
        handedOff.current = false
      })
      .catch(() => {
        setJoining(false)
        handedOff.current = false
      })
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
          <p className="flex items-center gap-1.5 truncate font-mono text-[12px] text-[#62626a]">
            {roomInfo?.locked && <Lock className="h-3 w-3 text-[#ff9500]" strokeWidth={2.6} />}
            {roomCode}
          </p>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-[400px] flex-1 flex-col justify-center gap-5 px-5 pb-10">
        {/* Preview */}
        <div className="pico-pop relative aspect-[4/3] w-full overflow-hidden rounded-md border border-black/[0.05] bg-[#f5f5f7]">
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className={`h-full w-full scale-x-[-1] object-cover ${mode === 'full' ? 'visible' : 'invisible'}`}
          />
          {mode === 'loading' && (
            <div className="absolute inset-0 flex items-center justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-[#62626a]" />
            </div>
          )}
          {mode !== 'loading' && mode !== 'full' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-8 text-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-[#e8e8ed] text-[17px] font-bold text-[#62626a]">
                {initials}
              </div>
              <p className="text-[13px] font-medium leading-relaxed text-[#62626a]">
                {mode === 'audio'
                  ? 'No camera found — you will join with audio only'
                  : 'No camera or mic found — you will join to listen and chat'}
              </p>
            </div>
          )}
          {mode === 'full' && !camOn && (
            <div className="absolute inset-0 flex items-center justify-center bg-[#f5f5f7]/95">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-[#e8e8ed] text-[17px] font-bold text-[#62626a]">
                {initials}
              </div>
            </div>
          )}
        </div>

        {/* Permission problem + retry — denial is a flow, not a dead end. */}
        {mediaNotice && (
          <div role="status" className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-[12px] font-medium leading-relaxed text-amber-900">
            <div className="flex items-start justify-between gap-3">
              <span>{mediaNotice}</span>
              <button
                type="button"
                onClick={() => {
                  setMode('loading')
                  setRetryTick((t) => t + 1)
                }}
                className="shrink-0 rounded-sm bg-amber-900 px-2.5 py-1 text-[11px] font-bold text-white active:scale-95"
              >
                Retry
              </button>
            </div>
            {mediaNotice.includes('browser settings') && (
              <details className="mt-2 border-t border-amber-900/15 pt-2">
                <summary className="cursor-pointer font-bold underline underline-offset-2">Where are site settings?</summary>
                <p className="mt-1.5">Open your browser’s site information or privacy settings, allow microphone and camera access for this site, then return here and retry.</p>
              </details>
            )}
          </div>
        )}

        {/* Device pickers (labels appear once permission is granted). */}
        {(mics.length > 1 || cams.length > 1) && (
          <div className="flex flex-col gap-2">
            {mics.length > 1 && (
              <label className="flex items-center gap-2 text-[12px] font-semibold text-[#62626a]">
                <Mic className="h-3.5 w-3.5 shrink-0" />
                <select
                  aria-label="Microphone device"
                  value={selMic}
                  onChange={(e) => setSelMic(e.target.value)}
                  className="w-full rounded-sm border border-black/10 bg-white px-2 py-1.5 text-[12px] font-medium text-[#0d0d0f]"
                >
                  {mics.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>{d.label}</option>
                  ))}
                </select>
              </label>
            )}
            {cams.length > 1 && (
              <label className="flex items-center gap-2 text-[12px] font-semibold text-[#62626a]">
                <Video className="h-3.5 w-3.5 shrink-0" />
                <select
                  aria-label="Camera device"
                  value={selCam}
                  onChange={(e) => setSelCam(e.target.value)}
                  className="w-full rounded-sm border border-black/10 bg-white px-2 py-1.5 text-[12px] font-medium text-[#0d0d0f]"
                >
                  {cams.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>{d.label}</option>
                  ))}
                </select>
              </label>
            )}
          </div>
        )}

        {joinError && (
          <div
            role="alert"
            className="pico-pop flex items-center gap-2.5 rounded-md bg-[#d62f25]/[0.07] px-4 py-3"
          >
            <p className="text-[13px] font-semibold leading-snug text-[#c52d25]">{joinError}</p>
          </div>
        )}

        {/* Device toggles */}
        <div className="flex justify-center gap-4">
          <button
            onClick={toggleMic}
          aria-label={micOn ? 'Mute microphone' : 'Unmute microphone'}
          title={micOn ? 'Mute microphone' : 'Unmute microphone'}
            className={`ios-control ${!micOn ? 'ios-control-active' : ''}`}
          >
            <span key={micOn ? 'on' : 'off'} className="pico-icon-swap flex">
              {micOn ? <Mic className="h-5 w-5" strokeWidth={2.2} /> : <MicOff className="h-5 w-5" strokeWidth={2.2} />}
            </span>
          </button>
          <button
            onClick={toggleCam}
          aria-label={camOn ? 'Turn camera off' : 'Turn camera on'}
          title={camOn ? 'Turn camera off' : 'Turn camera on'}
            className={`ios-control ${!camOn ? 'ios-control-active' : ''}`}
          >
            <span key={camOn ? 'on' : 'off'} className="pico-icon-swap flex">
              {camOn ? <Video className="h-5 w-5" strokeWidth={2.2} /> : <VideoOff className="h-5 w-5" strokeWidth={2.2} />}
            </span>
          </button>
        </div>

        {/* Name */}
        <div>
          <label htmlFor="pico-name" className="mb-1.5 block px-1 text-[12px] font-bold uppercase tracking-[0.08em] text-[#62626a]">
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
            <label htmlFor="pico-passcode" className="mb-1.5 flex items-center gap-1.5 px-1 text-[12px] font-bold uppercase tracking-[0.08em] text-[#62626a]">
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
          disabled={joining || mode === 'loading' || (needsPasscode && passcode.trim().length === 0)}
          className="ios-pill w-full"
        >
          {joining ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {joining ? 'Connecting…' : 'Join call'}
        </button>

        <p className="text-center text-[12px] leading-relaxed text-[#62626a]">
          Direct call · encrypted in transit · nothing is recorded
          <br />
          On a weak signal, open connection settings during the call and choose “Data Saver”
        </p>
      </main>
    </div>
  )
}
