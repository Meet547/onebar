'use client'

import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'

/**
 * Shared sheet shell — bottom sheet on phones, floating card on desktop.
 * Mount plays `pico-sheet-up`; while `closing` is true the parent keeps it
 * mounted one extra frame-window and `pico-sheet-down` plays the exit.
 */
export function Sheet({
  title,
  onClose,
  closing,
  children,
}: {
  title: string
  onClose: () => void
  closing?: boolean
  children: React.ReactNode
}) {
  const ref = useRef<HTMLElement>(null)
  const closeRef = useRef(onClose)
  useEffect(() => { closeRef.current = onClose }, [onClose])
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const panel = ref.current
    panel?.querySelector<HTMLElement>('button, input, select, textarea, [tabindex="0"]')?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeRef.current()
      }
    }
    panel?.addEventListener('keydown', onKey)
    return () => {
      panel?.removeEventListener('keydown', onKey)
      if (previous?.isConnected) previous.focus()
    }
  }, [])
  return (
    <aside
      ref={ref}
      className={`pico-sheet-up ${closing ? 'pico-sheet-down' : ''} fixed inset-x-0 bottom-0 z-40 flex h-[68dvh] flex-col rounded-t-md border border-black/[0.05] bg-white/95 shadow-[0_-8px_40px_rgba(0,0,0,0.10)] backdrop-blur-xl sm:inset-y-0 sm:left-auto sm:right-4 sm:top-4 sm:bottom-24 sm:h-auto sm:w-[360px] sm:rounded-md`}
      role="dialog"
      aria-label={title}
    >
      <header className="flex items-center justify-between border-b border-black/[0.05] px-5 py-3.5">
        <h2 className="text-[15px] font-bold tracking-[-0.01em] text-[#0d0d0f]">{title}</h2>
        <button onClick={onClose} aria-label={`Close ${title}`} className="ios-square">
          <X className="h-3.5 w-3.5" strokeWidth={2.6} />
        </button>
      </header>
      {children}
    </aside>
  )
}
