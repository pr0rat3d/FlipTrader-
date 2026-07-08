export const tierAlert = (indicesTriggered: string[]): 'TTF' | 'DTF' | 'STF' => {
  const count = indicesTriggered.length
  if (count === 3) return 'TTF'
  if (count === 2) return 'DTF'
  return 'STF'
}

export const getTierColor = (tier: 'TTF' | 'DTF' | 'STF'): string => {
  if (tier === 'TTF') return '#10b981' // green
  if (tier === 'DTF') return '#f59e0b' // yellow
  return '#ef4444' // red
}

export const getTierLabel = (tier: 'TTF' | 'DTF' | 'STF'): string => {
  if (tier === 'TTF') return 'Triple - Strong'
  if (tier === 'DTF') return 'Double - Good'
  return 'Single - Weak'
}
