export const isMarketOpen = (): boolean => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
    weekday: 'short'
  }).formatToParts(new Date())

  const weekday = parts.find(p => p.type === 'weekday')?.value
  const hour = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10)
  const minute = parseInt(parts.find(p => p.type === 'minute')?.value || '0', 10)

  if (weekday === 'Sat' || weekday === 'Sun') return false

  const minutesSinceMidnight = hour * 60 + minute
  const marketOpen = 9 * 60 + 30
  const marketClose = 16 * 60

  return minutesSinceMidnight >= marketOpen && minutesSinceMidnight < marketClose
}
