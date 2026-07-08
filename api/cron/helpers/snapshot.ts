import { calculateRSI, calculateMACD, calculateEMA } from '../../../src/lib/technicalIndicators.js'
import { supabase } from './supabaseAdmin.js'

export type SnapshotCategory = 'day_trade' | 'swing'

export const recordSnapshot = async (
  symbol: string,
  category: SnapshotCategory,
  closes: number[],
  vwap: number | null = null
) => {
  if (closes.length < 26) return

  const rsiValues = calculateRSI(closes, 14)
  const macdData = calculateMACD(closes)
  const latestMacd = macdData[macdData.length - 1]
  const ema50 = calculateEMA(closes, 50)
  const ema200 = closes.length >= 200 ? calculateEMA(closes, 200) : null

  const { error } = await supabase.from('indicator_snapshots').insert({
    symbol,
    category,
    close_price: closes[closes.length - 1],
    rsi: rsiValues[rsiValues.length - 1] ?? null,
    macd_line: latestMacd?.MACD ?? null,
    macd_signal: latestMacd?.signal ?? null,
    macd_histogram: latestMacd?.histogram ?? null,
    ema_50: ema50,
    ema_200: ema200,
    vwap,
    timestamp: new Date()
  })

  if (error) {
    console.error(`Error recording snapshot for ${symbol}:`, error)
  }
}
