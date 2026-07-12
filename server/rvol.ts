const MARKET_OPEN_MINUTES = 9 * 60 + 30
const TRADING_DAY_MINUTES = 390 // 6.5 hours

export const nyMinutesSinceMidnight = (d: Date): number => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false
  }).formatToParts(d)
  const hour = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10)
  const minute = parseInt(parts.find(p => p.type === 'minute')?.value || '0', 10)
  return hour * 60 + minute
}

// (minutes since 9:30am ET) / 390, clamped to [0, 1] - guards both pre-market
// (negative) and after-hours (>1) so callers never divide by ~0.
export const fractionOfTradingDayElapsed = (now: Date = new Date()): number => {
  const minutesSinceOpen = nyMinutesSinceMidnight(now) - MARKET_OPEN_MINUTES
  return Math.min(1, Math.max(0, minutesSinceOpen / TRADING_DAY_MINUTES))
}

// A stock trading at 3x its time-adjusted expected volume is "in play" - far more
// likely to have a clean, tradeable move than one at its usual, sleepy pace.
export const calculateDayTradeRVOL = (
  cumulativeVolumeToday: number,
  avgDailyVolume: number | null,
  now: Date = new Date()
): number | null => {
  if (!avgDailyVolume) return null
  const fraction = fractionOfTradingDayElapsed(now)
  // Right at the open there's essentially no "expected volume so far" to divide
  // by - too noisy to be meaningful, so don't report a figure yet.
  if (fraction < 0.02) return null
  const expectedSoFar = avgDailyVolume * fraction
  return expectedSoFar > 0 ? cumulativeVolumeToday / expectedSoFar : null
}

// Swing doesn't need time-of-day fractioning the same way - just compares the
// day's volume (so far, or completed) against the 20-day average.
export const calculateSwingRVOL = (volumeToday: number, avgDailyVolume: number | null): number | null => {
  if (!avgDailyVolume) return null
  return volumeToday / avgDailyVolume
}
