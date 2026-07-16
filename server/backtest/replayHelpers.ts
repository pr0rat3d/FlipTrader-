import { Candle } from '../twelvedata.js'
import { calculateEMA } from '../../src/lib/technicalIndicators.js'
import { SupportResistanceLevels, detectGap } from '../supportResistance.js'

export interface DailyLevelsSnapshot {
  pdh: number
  pdl: number
  pdc: number
  dailyEma50: number | null
  dailyEma200: number | null
}

// Same math as supportResistance.ts's getDailyLevels, but parameterized on
// an explicit "as of" index into a pre-loaded daily-candle array instead of
// hardcoding nyDateKey(new Date()) - the live function can't be reused
// directly for a historical replay, since "today" there always means the
// real current date, not whatever day the backtest is currently walking
// through. completedDays = every daily candle strictly BEFORE asOfIndex,
// matching live's "prior day" framing exactly. No Supabase caching here -
// recomputing from an in-memory array is cheap, and a backtest run has no
// use for a cross-run cache anyway.
export const dailyLevelsAsOf = (dailyCandles: Candle[], asOfIndex: number): DailyLevelsSnapshot | null => {
  const completedDays = dailyCandles.slice(0, asOfIndex)
  const priorDay = completedDays[completedDays.length - 1]
  if (!priorDay) return null

  const completedCloses = completedDays.map(c => c.close)
  const dailyEma50 = completedCloses.length >= 50 ? calculateEMA(completedCloses, 50) : null
  const dailyEma200 = completedCloses.length >= 200 ? calculateEMA(completedCloses, 200) : null

  return { pdh: priorDay.high, pdl: priorDay.low, pdc: priorDay.close, dailyEma50, dailyEma200 }
}

// Same math as supportResistance.ts's calculateOpeningRange, but takes
// candles already filtered to a single session (the backtest driver splits
// history into sessions itself) instead of filtering by
// nyDateKey(new Date()) internally.
export const openingRangeFor = (sessionCandlesSoFar: Candle[]): { orh: number; orl: number } | null => {
  if (sessionCandlesSoFar.length === 0) return null
  const firstTime = new Date(sessionCandlesSoFar[0].datetime).getTime()
  const windowEnd = firstTime + 15 * 60_000
  const orBars = sessionCandlesSoFar.filter(c => new Date(c.datetime).getTime() < windowEnd)
  if (orBars.length === 0) return null

  return {
    orh: Math.max(...orBars.map(c => c.high)),
    orl: Math.min(...orBars.map(c => c.low))
  }
}

// Composes the two helpers above plus detectGap (already pure/reusable
// as-is from supportResistance.ts) into the exact same shape
// getSupportResistanceLevels returns live - for IV detection's replay.
export const supportResistanceLevelsAsOf = (
  dailyCandles: Candle[],
  dailyAsOfIndex: number,
  sessionCandlesSoFar: Candle[]
): SupportResistanceLevels => {
  const dailyLevels = dailyLevelsAsOf(dailyCandles, dailyAsOfIndex)
  const or = openingRangeFor(sessionCandlesSoFar)
  const todayOpen = sessionCandlesSoFar[0]?.open

  const gap = dailyLevels && todayOpen !== undefined
    ? detectGap(todayOpen, dailyLevels.pdc)
    : { gapUp: false, gapDown: false }

  return {
    pdh: dailyLevels?.pdh ?? null,
    pdl: dailyLevels?.pdl ?? null,
    pdc: dailyLevels?.pdc ?? null,
    orh: or?.orh ?? null,
    orl: or?.orl ?? null,
    gapUp: gap.gapUp,
    gapDown: gap.gapDown,
    dailyEma50: dailyLevels?.dailyEma50 ?? null,
    dailyEma200: dailyLevels?.dailyEma200 ?? null
  }
}
