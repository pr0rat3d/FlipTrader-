import { Candle, getDailyCandles } from './twelvedata.js'
import { nyDateKey } from './marketHours.js'
import { supabase } from './supabaseAdmin.js'

export interface SupportResistanceLevels {
  pdh: number | null
  pdl: number | null
  pdc: number | null
  orh: number | null
  orl: number | null
  gapUp: boolean
  gapDown: boolean
}

const GAP_THRESHOLD_PCT = 0.001 // 0.1%
const OPENING_RANGE_MINUTES = 15

// PDH/PDL/PDC only change once a day - cached in daily_levels so IV detection
// doesn't need a fresh daily-candle API call every 5-min run, only once per
// symbol per NY trading day.
export const getDailyLevels = async (symbol: string): Promise<{ pdh: number; pdl: number; pdc: number } | null> => {
  const today = nyDateKey(new Date())

  const { data: cached } = await supabase
    .from('daily_levels')
    .select('pdh, pdl, pdc')
    .eq('symbol', symbol)
    .eq('trading_date', today)
    .maybeSingle()

  if (cached) return cached

  const candles = await getDailyCandles(symbol, 5)
  if (!candles || candles.length === 0) return null

  // Most recent COMPLETED day strictly before today - the API's last row may be
  // today's still-forming bar.
  const priorDay = [...candles].reverse().find(c => nyDateKey(c.datetime) !== today)
  if (!priorDay) return null

  const levels = { pdh: priorDay.high, pdl: priorDay.low, pdc: priorDay.close }

  await supabase
    .from('daily_levels')
    .upsert({ symbol, trading_date: today, ...levels }, { onConflict: 'symbol,trading_date' })

  return levels
}

// High/low of the first 15 minutes of today's regular session, from candles already
// fetched for the confluence scan - no extra API call.
export const calculateOpeningRange = (todaysIntradayCandles: Candle[]): { orh: number; orl: number } | null => {
  const today = nyDateKey(new Date())
  const sessionCandles = todaysIntradayCandles.filter(c => nyDateKey(c.datetime) === today)
  if (sessionCandles.length === 0) return null

  const firstTime = new Date(sessionCandles[0].datetime).getTime()
  const windowEnd = firstTime + OPENING_RANGE_MINUTES * 60_000
  const orBars = sessionCandles.filter(c => new Date(c.datetime).getTime() < windowEnd)
  if (orBars.length === 0) return null

  return {
    orh: Math.max(...orBars.map(c => c.high)),
    orl: Math.min(...orBars.map(c => c.low))
  }
}

export const detectGap = (todayOpen: number, pdc: number): { gapUp: boolean; gapDown: boolean } => {
  const diff = (todayOpen - pdc) / pdc
  return { gapUp: diff > GAP_THRESHOLD_PCT, gapDown: diff < -GAP_THRESHOLD_PCT }
}

export const getSupportResistanceLevels = async (
  symbol: string,
  todaysIntradayCandles: Candle[]
): Promise<SupportResistanceLevels> => {
  const dailyLevels = await getDailyLevels(symbol)
  const or = calculateOpeningRange(todaysIntradayCandles)

  const today = nyDateKey(new Date())
  const todaysCandles = todaysIntradayCandles.filter(c => nyDateKey(c.datetime) === today)
  const todayOpen = todaysCandles[0]?.open

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
    gapDown: gap.gapDown
  }
}
