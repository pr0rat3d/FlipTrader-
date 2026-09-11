import { nyDateKey } from './marketHours.js'

// Fed's own published calendar (federalreserve.gov/monetarypolicy/fomccalendars.htm)
// - decision day only (2nd day of the 2-day meeting). Free, official, published
// a year ahead - no API needed. MUST be refreshed once/year when the Fed posts
// next year's calendar (usually mid-prior-year).
const FOMC_DATES: string[] = [
  '2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17',
  '2026-07-29', '2026-09-16', '2026-10-28', '2026-12-09'
]

// BLS's published release schedule (bls.gov/schedule/news_release/cpi.htm) -
// same "free, published a year ahead, refresh annually" reasoning as above.
const CPI_DATES: string[] = [
  '2026-01-13', '2026-02-13', '2026-03-11', '2026-04-10',
  '2026-05-12', '2026-06-10', '2026-07-14', '2026-08-12',
  '2026-09-11', '2026-10-14', '2026-11-10', '2026-12-10'
]

export const isFomcDay = (date: Date = new Date()): boolean => FOMC_DATES.includes(nyDateKey(date))
export const isCpiDay = (date: Date = new Date()): boolean => CPI_DATES.includes(nyDateKey(date))

// OPEX/quad-witching are pure calendar math (3rd Friday of the month; quad-
// witching is the 3rd Friday of Mar/Jun/Sep/Dec) - no external source needed.
//
// Deliberately stays in plain (year, month, day) integer space throughout -
// an earlier version built a synthetic UTC-midnight Date for "the 1st of the
// month" and re-derived its key via nyDateKey, which re-interprets that UTC
// instant through the America/New_York offset and silently shifts it back a
// calendar day (ET is behind UTC). UTC-noon here is only ever used to ask
// "what weekday is calendar date Y-M-D", never reformatted through another
// timezone, so there's no re-conversion to shift it.
const weekdayOf = (year: number, month: number, day: number): number =>
  new Date(Date.UTC(year, month - 1, day, 12)).getUTCDay()

const thirdFridayOfMonth = (year: number, month: number): number => {
  const firstWeekday = weekdayOf(year, month, 1)
  const offset = (5 - firstWeekday + 7) % 7 // 5 = Friday
  return 1 + offset + 14
}

export const isOpexDay = (date: Date = new Date()): boolean => {
  const [year, month, day] = nyDateKey(date).split('-').map(Number)
  return day === thirdFridayOfMonth(year, month)
}

export const isQuadWitchingDay = (date: Date = new Date()): boolean => {
  const month = Number(nyDateKey(date).split('-')[1])
  return [3, 6, 9, 12].includes(month) && isOpexDay(date)
}

export interface MacroEvent {
  type: 'FOMC' | 'CPI' | 'OPEX' | 'QUAD_WITCH'
  date: string
  daysAway: number
}

// Scans forward day-by-day rather than maintaining a merged pre-sorted event
// list - withinDays is always small (a handful of days), so this stays cheap
// and keeps all four event checks in one place.
export const getUpcomingMacroEvents = (withinDays: number, from: Date = new Date()): MacroEvent[] => {
  const events: MacroEvent[] = []
  for (let i = 0; i <= withinDays; i++) {
    const d = new Date(from.getTime() + i * 24 * 60 * 60 * 1000)
    if (isFomcDay(d)) events.push({ type: 'FOMC', date: nyDateKey(d), daysAway: i })
    if (isCpiDay(d)) events.push({ type: 'CPI', date: nyDateKey(d), daysAway: i })
    if (isQuadWitchingDay(d)) events.push({ type: 'QUAD_WITCH', date: nyDateKey(d), daysAway: i })
    else if (isOpexDay(d)) events.push({ type: 'OPEX', date: nyDateKey(d), daysAway: i })
  }
  return events
}
