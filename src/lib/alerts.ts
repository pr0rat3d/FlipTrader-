// TTTF/DTTF/STTF = Triple/Double/Single-index Triple Time Frame - "triple
// time frame" describes the RSI-divergence + MACD-curl confluence method
// itself (unchanged), the prefix says how many of the 3 confluence indices
// (SPY/QQQ/IWM) agreed.
export const tierAlert = (indicesTriggered: string[]): 'TTTF' | 'DTTF' | 'STTF' => {
  const count = indicesTriggered.length
  if (count === 3) return 'TTTF'
  if (count === 2) return 'DTTF'
  return 'STTF'
}

export const getTierColor = (tier: 'TTTF' | 'DTTF' | 'STTF' | 'IV' | 'ORB'): string => {
  if (tier === 'TTTF') return '#10b981' // green
  if (tier === 'DTTF') return '#f59e0b' // yellow
  if (tier === 'IV') return '#8b5cf6' // purple - early momentum, distinct from confluence tiers
  if (tier === 'ORB') return '#3b82f6' // blue - breakout continuation, distinct from all the others
  return '#ef4444' // red (STTF)
}

export const getTierLabel = (tier: 'TTTF' | 'DTTF' | 'STTF' | 'IV' | 'ORB'): string => {
  if (tier === 'TTTF') return 'Triple - Strong'
  if (tier === 'DTTF') return 'Double - Good'
  if (tier === 'IV') return 'Momentum Entry'
  if (tier === 'ORB') return 'Breakout Continuation'
  return 'Single - Weak'
}
