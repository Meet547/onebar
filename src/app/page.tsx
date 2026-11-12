'use client'

import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { getEngine } from '@/lib/call/engine'
import { useCallStore } from '@/lib/call/store'
import { generateRoomCode } from '@/lib/call/types'
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
    window.addEventListener('beforeunload', onUnload)
    return () => window.removeEventListener('beforeunload', onUnload)
  }, [])

  const create = useCallback(() => {
    const code = generateRoomCode()
    setRoomCode(code)
    setView('prejoin')
    window.history.replaceState(null, '', `/?room=${code}${testMode ? '&test=1' : ''}`)
  }, [testMode])

  const joinWithStream = useCallback(
    async (stream: MediaStream | null) => {
      previewRef.current = stream
      const name = window.localStorage.getItem('pico-name') || 'Guest'
      await getEngine().start({
        roomId: roomCode,
        name,
        preset: 'balanced',
        initialStream: stream,
        testMode,
      })
      previewRef.current = null // engine now owns the stream
      setView('room')
    },
    [roomCode, testMode],
  )

  const backToHome = useCallback(() => {
    setView('home')
    if (!urlRoom) return
    router.replace('/')
  }, [router, urlRoom])

  const leaveCall = useCallback(() => {
    setView(urlRoom ? 'prejoin' : 'home')
    window.history.replaceState(null, '', testMode ? '/?test=1' : '/')
  }, [urlRoom, testMode])

  if (view === 'home') {
    return <Home onCreate={create} />
  }

  if (view === 'prejoin') {
    return (
      <PreJoin
        roomCode={roomCode}
        testMode={testMode}
        onBack={backToHome}
        onJoin={(stream) => void joinWithStream(stream)}
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
