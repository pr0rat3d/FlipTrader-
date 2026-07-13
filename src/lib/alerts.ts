export const tierAlert = (indicesTriggered: string[]): 'TTF' | 'DTF' | 'STF' => {
  const count = indicesTriggered.length
  if (count === 3) return 'TTF'
  if (count === 2) return 'DTF'
  return 'STF'
}

export const getTierColor = (tier: 'TTF' | 'DTF' | 'STF' | 'IV' | 'ORB'): string => {
  if (tier === 'TTF') return '#10b981' // green
  if (tier === 'DTF') return '#f59e0b' // yellow
  if (tier === 'IV') return '#8b5cf6' // purple - early momentum, distinct from confluence tiers
  if (tier === 'ORB') return '#3b82f6' // blue - breakout continuation, distinct from all the others
  return '#ef4444' // red (STF)
}

export const getTierLabel = (tier: 'TTF' | 'DTF' | 'STF' | 'IV' | 'ORB'): string => {
  if (tier === 'TTF') return 'Triple - Strong'
  if (tier === 'DTF') return 'Double - Good'
  if (tier === 'IV') return 'Momentum Entry'
  if (tier === 'ORB') return 'Breakout Continuation'
  return 'Single - Weak'
}
