import { Candle } from './twelvedata.js'

const nyDateKey = (isoOrDatetime: string | Date): string => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date(isoOrDatetime))

  const year = parts.find(p => p.type === 'year')?.value
  const month = parts.find(p => p.type === 'month')?.value
  const day = parts.find(p => p.type === 'day')?.value
  return `${year}-${month}-${day}`
}

// Session VWAP: cumulative typical-price-weighted average, reset each trading day.
// Recomputed from scratch every run (same style as RSI/MACD/EMA) - no incremental state.
export const calculateSessionVWAP = (candles: Candle[]): number | null => {
  if (candles.length === 0) return null

  const today = nyDateKey(new Date())
  const todaysCandles = candles.filter(c => nyDateKey(c.datetime) === today)
  if (todaysCandles.length === 0) return null

  let cumulativeTypicalVolume = 0
  let cumulativeVolume = 0

  for (const candle of todaysCandles) {
    const typicalPrice = (candle.high + candle.low + candle.close) / 3
    cumulativeTypicalVolume += typicalPrice * candle.volume
    cumulativeVolume += candle.volume
  }

  if (cumulativeVolume === 0) return null

  return cumulativeTypicalVolume / cumulativeVolume
}
