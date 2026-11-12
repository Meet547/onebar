'use client'

import type { NetworkLevel } from '@/lib/call/types'

const BAR_COLORS: Record<NetworkLevel, string> = {
  0: '#ff3b30',
  1: '#ff9500',
  2: '#34c759',
  3: '#34c759',
}

/** iOS-style signal strength indicator (3 bars). */
export function NetworkBars({ level, size = 'sm' }: { level: NetworkLevel; size?: 'sm' | 'md' }) {
  const heights = size === 'sm' ? [5, 8, 11] : [6, 10, 14]
  const active = level === 0 ? 1 : level // 0 still shows one red bar
  return (
    <span className="inline-flex items-end gap-[2px]" role="img" aria-label={`Network quality ${level + 1} of 4`}>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="w-[3px] rounded-full transition-colors duration-300"
          style={{
            height: heights[i],
            backgroundColor: i < active ? BAR_COLORS[level] : 'rgba(134,134,139,0.35)',
          }}
        />
      ))}
    </span>
  )
}

export const LEVEL_LABEL: Record<NetworkLevel, string> = {
  0: 'Poor connection',
  1: 'Weak connection',
  2: 'Good connection',
  3: 'Excellent connection',
}
