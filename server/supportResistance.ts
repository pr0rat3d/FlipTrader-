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

export interface DailyLevels {
  pdh: number
  pdl: number
  pdc: number
  avgVolume20d: number | null
}

const GAP_THRESHOLD_PCT = 0.001 // 0.1%
const OPENING_RANGE_MINUTES = 15
const VOLUME_BASELINE_DAYS = 20

// PDH/PDL/PDC/avgVolume20d only change once a day - cached in daily_levels so
// IV detection and RVOL don't need a fresh daily-candle API call every run, only
// once per symbol per NY trading day. Pass prefetchedDailyCandles when the caller
// already has daily candles in hand (e.g. scan-swings.ts's main loop) - avoids a
// second, redundant API call for the same symbol in the same run, which briefly
// caused a 429 (every symbol whose cache was cold in the same batch effectively
// doubled its credit cost).
export const getDailyLevels = async (
  symbol: string,
  prefetchedDailyCandles?: Candle[] | null
): Promise<DailyLevels | null> => {
  const today = nyDateKey(new Date())

  const { data: cached } = await supabase
    .from('daily_levels')
    .select('pdh, pdl, pdc, avg_volume_20d')
    .eq('symbol', symbol)
    .eq('trading_date', today)
    .maybeSingle()

  if (cached) return { pdh: cached.pdh, pdl: cached.pdl, pdc: cached.pdc, avgVolume20d: cached.avg_volume_20d }

  // Buffer beyond 20 for weekends/holidays so we still get 20 completed trading days.
  const candles = prefetchedDailyCandles ?? await getDailyCandles(symbol, VOLUME_BASELINE_DAYS + 10)
  if (!candles || candles.length === 0) return null

  // Completed days strictly before today - the API's last row may be today's
  // still-forming bar.
  const completedDays = candles.filter(c => nyDateKey(c.datetime) !== today)
  const priorDay = completedDays[completedDays.length - 1]
  if (!priorDay) return null

  const recentVolumes = completedDays.slice(-VOLUME_BASELINE_DAYS).map(c => c.volume)
  const avgVolume20d = recentVolumes.length > 0
    ? Math.round(recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length)
    : null

  const levels = { pdh: priorDay.high, pdl: priorDay.low, pdc: priorDay.close, avgVolume20d }

  await supabase
    .from('daily_levels')
    .upsert(
      { symbol, trading_date: today, pdh: levels.pdh, pdl: levels.pdl, pdc: levels.pdc, avg_volume_20d: avgVolume20d },
      { onConflict: 'symbol,trading_date' }
    )

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
