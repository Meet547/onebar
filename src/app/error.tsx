'use client'

import { useEffect } from 'react'
import { getEngine } from '@/lib/call/engine'

/**
 * Route-level error boundary. A crash inside the call UI must never leave
 * camera/microphone tracks open or the user stranded on a white screen —
 * this tears the call down and offers a clean way back.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    try {
      void getEngine().leave(true)
    } catch {
      /* engine may not exist yet */
    }
  }, [])

  return (
    <div className="flex min-h-[100dvh] flex-col items-center justify-center bg-white px-6">
      <div className="pico-pop w-full max-w-[400px] rounded-md border border-black/[0.05] bg-white p-8 text-center shadow-[0_8px_40px_rgba(0,0,0,0.08)]">
        <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full bg-[#ff3b30]/10 text-[22px] font-bold text-[#ff3b30]">
          !
        </div>
        <h1 className="text-[19px] font-extrabold tracking-[-0.01em] text-[#0d0d0f]">
          Something went wrong
        </h1>
        <p className="mt-2 text-[13px] leading-relaxed text-[#7c7c82]">
          The call was closed safely — your camera and microphone are released.
          Reopen the page and start again.
        </p>
        <button onClick={reset} className="ios-pill mt-6 w-full">
          Back to Pico
        </button>
      </div>
    </div>
  )
}
