import { calculateRSI, calculateMACD, calculateEMA, calculateATR } from '../src/lib/technicalIndicators.js'
import { supabase } from './supabaseAdmin.js'
import { nyDateKey } from './marketHours.js'
import { Candle } from './twelvedata.js'
import { detectCandlestickPattern } from './candlestickPatterns.js'

export type SnapshotCategory = 'day_trade' | 'swing'

export interface SnapshotBarExtras {
  vwap?: number | null
}

export const recordSnapshot = async (
  symbol: string,
  category: SnapshotCategory,
  candles: Candle[],
  extras: SnapshotBarExtras = {}
) => {
  const closes = candles.map(c => c.close)
  if (closes.length < 26) return

  const { vwap = null } = extras
  const highs = candles.map(c => c.high)
  const lows = candles.map(c => c.low)
  const latest = candles[candles.length - 1]

  const rsiValues = calculateRSI(closes, 14)
  const macdData = calculateMACD(closes)
  const latestMacd = macdData[macdData.length - 1]
  const ema50 = calculateEMA(closes, 50)
  const ema200 = closes.length >= 200 ? calculateEMA(closes, 200) : null
  const atrValues = calculateATR(highs, lows, closes, 14)
  const patternMatch = detectCandlestickPattern(candles)

  const row = {
    symbol,
    category,
    close_price: latest.close,
    open_price: latest.open,
    high_price: latest.high,
    low_price: latest.low,
    volume: latest.volume,
    atr: atrValues[atrValues.length - 1] ?? null,
    rsi: rsiValues[rsiValues.length - 1] ?? null,
    macd_line: latestMacd?.MACD ?? null,
    macd_signal: latestMacd?.signal ?? null,
    macd_histogram: latestMacd?.histogram ?? null,
    ema_50: ema50,
    ema_200: ema200,
    vwap,
    candlestick_pattern: patternMatch?.pattern ?? null,
    candlestick_direction: patternMatch?.direction ?? null,
    timestamp: new Date()
  }

  if (category === 'swing') {
    // Swing bars are daily, but this cron re-scans every ~15 min - without this,
    // a single still-forming daily bar would pile up dozens of near-identical
    // snapshots. Keep one row per symbol per NY trading day, updated in place as
    // the day progresses, instead of a fresh row every run.
    const today = nyDateKey(new Date())
    const { data: existing } = await supabase
      .from('indicator_snapshots')
      .select('id, timestamp')
      .eq('symbol', symbol)
      .eq('category', 'swing')
      .order('timestamp', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (existing && nyDateKey(existing.timestamp) === today) {
      const { error } = await supabase.from('indicator_snapshots').update(row).eq('id', existing.id)
      if (error) console.error(`Error updating snapshot for ${symbol}:`, error)
      return
    }
  }

  const { error } = await supabase.from('indicator_snapshots').insert(row)
  if (error) {
    console.error(`Error recording snapshot for ${symbol}:`, error)
  }
}
