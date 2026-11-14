/**
 * Field report builder (?debug=1 → "Copy report") — PURE, so it compiles to
 * CommonJS for the offline tests. Produces a plain-text support block with
 * the adaptation-relevant readings and NOTHING identity-relevant: peer ids
 * are truncated to 5 chars, candidate types carry no IP/port/protocol
 * credentials, no room ids, no ICE usernames.
 */

export interface FieldReportPeer {
  id: string
  kbpsUp: number
  kbpsDown: number
  level: number
  /** "localType/protocol→remoteType/protocol", e.g. "relay/udp→srflx/udp" */
  candidateType: string
  lossPct: number | null
  rttMs: number | null
}

export interface FieldReportData {
  appVersion: string | null
  browser: string
  level: number
  /** Smoothed outgoing bandwidth estimate, weakest link (kbps). */
  bweKbps: number
  /** This peer's share of the upload budget (kbps). */
  budgetKbps: number
  cpuReason: string
  cpuStep: number
  encodeMsPerFrame: number
  /** Raw qualityLimitationReason from the encoder ('cpu', 'bandwidth', …). */
  qlReason: string
  /** Worst-case across peers (fractions 0..1 → %). */
  lossPct: number | null
  rttMs: number | null
  peers: FieldReportPeer[]
  /** Last 20 adaptation events, newest last, as "[hh:mm:ss] text". */
  events: string[]
}

const ID_LEN = 5

export function buildFieldReport(d: FieldReportData, now: Date = new Date()): string {
  const t = now.toTimeString().slice(0, 8)
  const lines: string[] = []
  lines.push(`pico field report ${now.toISOString()}`)
  lines.push(`version: ${d.appVersion ?? 'unknown'}`)
  lines.push(`browser: ${d.browser}`)
  lines.push(
    `link: L${d.level} · bwe(weakest) ${d.bweKbps} kbps · budget/peer ${d.budgetKbps} kbps`,
  )
  lines.push(
    `cpu: ${d.cpuReason}${d.cpuStep > 0 ? ` (step ${d.cpuStep})` : ''} · encode ${d.encodeMsPerFrame} ms/frame · ql: ${d.qlReason}`,
  )
  lines.push(
    `worst loss: ${d.lossPct === null ? 'n/a' : `${d.lossPct}%`} · worst rtt: ${d.rttMs === null ? 'n/a' : `${d.rttMs} ms`}`,
  )
  lines.push(`peers (${d.peers.length}):`)
  for (const p of d.peers) {
    lines.push(
      `  ${p.id.slice(0, ID_LEN)}: ↑${p.kbpsUp} ↓${p.kbpsDown} kbps · L${p.level} · ${p.candidateType}` +
        ` · loss ${p.lossPct === null ? 'n/a' : `${p.lossPct}%`} · rtt ${p.rttMs === null ? 'n/a' : `${p.rttMs} ms`}`,
    )
  }
  lines.push(`adaptation events (last ${d.events.length}):`)
  for (const e of d.events) lines.push(`  ${e}`)
  return lines.join('\n')
}
