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

// Shared NY-calendar-day key, used by both session VWAP and profit-target expiry so
// there's one timezone implementation instead of two that can drift apart.
export const nyDateKey = (isoOrDate: string | Date): string => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date(isoOrDate))

  const year = parts.find(p => p.type === 'year')?.value
  const month = parts.find(p => p.type === 'month')?.value
  const day = parts.find(p => p.type === 'day')?.value
  return `${year}-${month}-${day}`
}

const nyHourMinute = (d: Date): { hour: number; minute: number } => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false
  }).formatToParts(d)

  const hour = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10)
  const minute = parseInt(parts.find(p => p.type === 'minute')?.value || '0', 10)
  return { hour, minute }
}

// True once the trading session containing entryTime has closed - either entryTime
// was a prior calendar day entirely, or it's today but past today's 4pm ET close.
export const hasSessionClosedSince = (entryTime: Date, now: Date = new Date()): boolean => {
  const entryDay = nyDateKey(entryTime)
  const nowDay = nyDateKey(now)
  if (nowDay !== entryDay) return true

  const { hour, minute } = nyHourMinute(now)
  const minutesSinceMidnight = hour * 60 + minute
  const marketClose = 16 * 60
  return minutesSinceMidnight >= marketClose
}
