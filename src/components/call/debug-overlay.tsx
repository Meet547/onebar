'use client'

import { useCallStore } from '@/lib/call/store'

/**
 * Field-debug overlay (?debug=1) — every value comes straight from the
 * engine's 3-second getStats() snapshot. Reads one store field, so it costs
 * nothing when the flag is off (the component is only mounted then anyway).
 */
export function DebugOverlay() {
  const d = useCallStore((s) => s.debug)
  if (!d) return null
  return (
    <div className="fixed left-2 top-2 z-50 max-w-[280px] rounded-xl bg-black/85 p-3 font-mono text-[10px] leading-relaxed text-lime-300 shadow-xl">
      <div className="mb-1 font-bold text-white">pico debug</div>
      <div>level: {d.level}</div>
      <div>bwe(out, weakest): {d.bweKbps} kbps</div>
      <div>budget/peer: {d.budgetKbps} kbps</div>
      <div>
        cpu: {d.cpuReason}
        {d.cpuStep > 0 ? ` (step ${d.cpuStep})` : ''}
      </div>
      <div>encode: {d.encodeMsPerFrame} ms/frame</div>
      {d.peers.map((p) => (
        <div key={p.id} className="mt-1 border-t border-white/15 pt-1">
          {p.id.slice(0, 5)}: ↑{p.kbpsUp} ↓{p.kbpsDown} kbps · L{p.level} · {p.candidateType}
        </div>
      ))}
    </div>
  )
}
