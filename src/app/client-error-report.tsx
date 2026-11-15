'use client'

import { useEffect } from 'react'
import { NEXT_PUBLIC_PICO_VERSION } from '@/lib/call/version-env'

/**
 * Global client error reporter — mounted once in the root layout. Sends
 * message + first stack frames + path WITHOUT query string (room codes live
 * in query strings and must not reach the server) to /api/client-error,
 * throttled so an error loop cannot flood anything. No PII: no ids, no
 * query strings, no user agent.
 */
export function ClientErrorReporter() {
  useEffect(() => {
    if (typeof window === 'undefined') return
    let sent = 0
    let windowStart = Date.now()
    const allow = () => {
      const now = Date.now()
      if (now - windowStart >= 60_000) {
        windowStart = now
        sent = 0
      }
      return ++sent <= 5
    }
    const report = (msg: string, stack: string) => {
      if (!allow()) return
      const body = JSON.stringify({
        msg: msg.slice(0, 300),
        stack: stack.split('\n').slice(0, 4).join('\n').slice(0, 700),
        url: window.location.pathname,
        ver: NEXT_PUBLIC_PICO_VERSION,
      })
      try {
        fetch('/api/client-error', {
          method: 'POST',
          body,
          keepalive: true,
          headers: { 'Content-Type': 'application/json' },
        }).catch(() => {})
      } catch {
        /* reporting must never throw */
      }
    }
    const onErr = (e: ErrorEvent) => report(e.message, e.error?.stack ?? '')
    const onRej = (e: PromiseRejectionEvent) =>
      report(`unhandledrejection: ${String(e.reason).slice(0, 200)}`, e.reason?.stack ?? '')
    window.addEventListener('error', onErr)
    window.addEventListener('unhandledrejection', onRej)
    return () => {
      window.removeEventListener('error', onErr)
      window.removeEventListener('unhandledrejection', onRej)
    }
  }, [])
  return null
}
