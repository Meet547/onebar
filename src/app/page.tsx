'use client'

import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { getEngine } from '@/lib/call/engine'
import { useCallStore } from '@/lib/call/store'
import { generateRoomCode, hashPasscode } from '@/lib/call/types'
import { Home } from '@/components/call/home'
import { PreJoin } from '@/components/call/prejoin'
import { Room } from '@/components/call/room'

type View = 'home' | 'prejoin' | 'room'

function PicoApp() {
  const router = useRouter()
  const search = useSearchParams()
  const urlRoom = search.get('room') ?? ''
  const testMode = search.get('test') === '1'

  const [view, setView] = useState<View>(urlRoom ? 'prejoin' : 'home')
  const [roomCode, setRoomCode] = useState(urlRoom)
  const [joinError, setJoinError] = useState<string | null>(null)
  const [kickedNotice, setKickedNotice] = useState<string | null>(null)
  // Passcode chosen by the creator on the home screen (hashed before sending)
  const pendingPasscodeHash = useRef('')

  const previewRef = useRef<MediaStream | null>(null)

  // URL drives the room so invite links work; keep state in sync on back/forward
  useEffect(() => {
    if (!urlRoom) return
    const t = window.setTimeout(() => {
      setRoomCode(urlRoom)
      setView((v) => (v === 'room' ? v : 'prejoin'))
    }, 0)
    return () => window.clearTimeout(t)
  }, [urlRoom])

  useEffect(() => {
    const onUnload = () => {
      void getEngine().leave(true)
    }
    // beforeunload covers desktop tab closes; pagehide covers iOS Safari and
    // backgrounding, where beforeunload is skipped.
    window.addEventListener('beforeunload', onUnload)
    window.addEventListener('pagehide', onUnload)
    return () => {
      window.removeEventListener('beforeunload', onUnload)
      window.removeEventListener('pagehide', onUnload)
    }
  }, [])

  // Removed by the host — tear down and show why, back on the home screen.
  useEffect(() => {
    return useCallStore.subscribe((state) => {
      if (!state.kicked) return
      useCallStore.getState().setKicked(false)
      void getEngine().leave(true)
      previewRef.current?.getTracks().forEach((t) => t.stop())
      previewRef.current = null
      setKickedNotice('The host removed you from the call')
      setView('home')
      window.history.replaceState(null, '', testMode ? '/?test=1' : '/')
    })
  }, [testMode])

  const create = useCallback(
    async (passcode: string) => {
      pendingPasscodeHash.current = passcode ? await hashPasscode(passcode) : ''
      const code = generateRoomCode()
      setRoomCode(code)
      setJoinError(null)
      setView('prejoin')
      window.history.replaceState(null, '', `/?room=${code}${testMode ? '&test=1' : ''}`)
    },
    [testMode],
  )

  const joinWithStream = useCallback(
    async (stream: MediaStream | null, passcode: string): Promise<boolean> => {
      previewRef.current = stream
      setJoinError(null)
      try {
        const name = window.localStorage.getItem('pico-name') || 'Guest'
        const hash = passcode ? await hashPasscode(passcode) : pendingPasscodeHash.current
        await getEngine().start({
          roomId: roomCode,
          name,
          preset: 'balanced',
          initialStream: stream,
          testMode,
          passwordHash: hash,
        })
        previewRef.current = null // engine now owns the stream
        pendingPasscodeHash.current = hash
        setView('room')
        return true
      } catch (err) {
        // Rejected by the relay (wrong passcode, locked, full) — the preview
        // stream stays alive so the join screen can simply retry.
        previewRef.current = null
        setJoinError(err instanceof Error ? err.message : 'Could not join the room')
        setView('prejoin')
        return false
      }
    },
    [roomCode, testMode],
  )

  const backToHome = useCallback(() => {
    setView('home')
    setJoinError(null)
    if (!urlRoom) return
    router.replace('/')
  }, [router, urlRoom])

  const leaveCall = useCallback(() => {
    setView(urlRoom ? 'prejoin' : 'home')
    setJoinError(null)
    window.history.replaceState(null, '', testMode ? '/?test=1' : '/')
  }, [urlRoom, testMode])

  if (view === 'home') {
    return (
      <Home
        onCreate={create}
        error={joinError !== null}
        notice={kickedNotice ?? undefined}
        onDismissError={() => {
          setJoinError(null)
          setKickedNotice(null)
        }}
      />
    )
  }

  if (view === 'prejoin') {
    return (
      <PreJoin
        roomCode={roomCode}
        testMode={testMode}
        joinError={joinError}
        onBack={backToHome}
        onJoin={joinWithStream}
      />
    )
  }

  return <Room roomCode={roomCode} onLeave={leaveCall} />
}

export default function Page() {
  return (
    <Suspense fallback={<div className="min-h-[100dvh] bg-white" />}>
      <PicoApp />
    </Suspense>
  )
}
