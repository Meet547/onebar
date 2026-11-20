'use client'

import { useState } from 'react'
import { useCallStore } from '@/lib/call/store'
import { buildFieldReport } from '@/lib/call/field-report'
import { NEXT_PUBLIC_PICO_VERSION } from '@/lib/call/version-env'

/**
 * Field-debug overlay (?debug=1) — every value comes straight from the
 * engine's 3-second getStats() snapshot. Reads one store field, so it costs
 * nothing when the flag is off (the component is only mounted then anyway).
 * "Copy report" hands a sanitized plain-text block to the clipboard for
 * bug reports — no IPs, no credentials, no room ids (see field-report.ts).
 */
export function DebugOverlay() {
  const d = useCallStore((s) => s.debug)
  const [copied, setCopied] = useState(false)
  if (!d) return null

  const copy = async () => {
    const text = buildFieldReport({
      appVersion: NEXT_PUBLIC_PICO_VERSION,
      browser: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
      level: d.level,
      bweKbps: d.bweKbps,
      budgetKbps: d.budgetKbps,
      cpuReason: d.cpuReason,
      cpuStep: d.cpuStep,
      encodeMsPerFrame: d.encodeMsPerFrame,
      qlReason: d.qlReason,
      lossPct: d.lossPct,
      rttMs: d.rttMs,
      peers: d.peers,
      events: d.events,
    })
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // Clipboard API denied (http, permissions) — hidden-textarea fallback.
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      ta.remove()
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="fixed left-2 top-2 z-50 max-w-[280px] rounded-md bg-black/85 p-3 font-mono text-[10px] leading-relaxed text-lime-300 shadow-xl">
      <div className="mb-1 flex items-center justify-between font-bold text-white">
        <span>pico debug</span>
        <button
          type="button"
          onClick={copy}
          className="rounded-sm border border-white/25 px-1.5 py-0.5 text-[9px] font-semibold normal-case text-white hover:bg-white/15"
        >
          {copied ? 'copied ✓' : 'copy report'}
        </button>
      </div>
      <div>level: {d.level}</div>
      <div>bwe(out, weakest): {d.bweKbps} kbps</div>
      <div>budget/peer: {d.budgetKbps} kbps</div>
      <div>
        cpu: {d.cpuReason}
        {d.cpuStep > 0 ? ` (step ${d.cpuStep})` : ''}
      </div>
      <div>encode: {d.encodeMsPerFrame} ms/frame · ql: {d.qlReason}</div>
      <div>
        loss: {d.lossPct === null ? 'n/a' : `${d.lossPct}%`} · rtt:{' '}
        {d.rttMs === null ? 'n/a' : `${d.rttMs} ms`}
      </div>
      {d.peers.map((p) => (
        <div key={p.id} className="mt-1 border-t border-white/15 pt-1">
          {p.id.slice(0, 5)}: ↑{p.kbpsUp} ↓{p.kbpsDown} kbps · L{p.level} · {p.candidateType}
          {p.lossPct !== null ? ` · ${p.lossPct}%` : ''}
          {p.rttMs !== null ? ` · ${p.rttMs}ms` : ''}
        </div>
      ))}
      {d.events.length > 0 && (
        <div className="mt-1 border-t border-white/15 pt-1 text-white/60">
          {d.events.slice(-4).map((e, i) => (
            <div key={i}>{e}</div>
          ))}
        </div>
      )}
    </div>
  )
}
