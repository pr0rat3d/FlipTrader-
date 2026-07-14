import { calculateRSI, calculateMACD, detectRSIDivergence, detectMACDCurl, calculateEMA } from '../src/lib/technicalIndicators.js'

export interface SignalResult {
  symbol: string
  timeframe: string
  rsiDivergence: 'bullish' | 'bearish' | null
  macdCurl: 'bullish' | 'bearish' | null
  hasSignal: boolean
  entryPrice: number
  target50EMA: number
}

// macdLookback: how many recent MACD bars count as "still backing" a curl,
// in candle-array terms (not MACD-array terms - see the offset math below).
// Defaults to 1 (exact current-bar cross only) so any other caller keeps the
// old strict behavior; scan-confluence.ts passes today's session bar count so
// a single early-session cross still backs a breakout that develops later.
export const analyzeCandles = (closes: number[], macdLookback: number = 1): SignalResult | null => {
  if (closes.length < 26) return null

  try {
    const rsiValues = calculateRSI(closes, 14)
    const macdData = calculateMACD(closes)

    // calculateMACD drops its warm-up bars, so the MACD array is shorter than
    // `closes` - shrink the lookback by that same offset to stay in bounds
    // and keep it meaning "this many trailing candles", not MACD-array bars.
    const macdOffset = closes.length - macdData.length
    const scopedLookback = Math.max(1, macdLookback - macdOffset)

    const rsiDivergence = detectRSIDivergence(closes, rsiValues)
    const macdCurl = detectMACDCurl(macdData, scopedLookback)

    // Signal only if both match
    const hasSignal = rsiDivergence === macdCurl && rsiDivergence !== null

    const entryPrice = closes[closes.length - 1]
    const target50EMA = calculateEMA(closes, 50)

    return {
      symbol: '',
      timeframe: '',
      rsiDivergence,
      macdCurl,
      hasSignal,
      entryPrice,
      target50EMA
    }
  } catch (error) {
    console.error('Error analyzing candles:', error)
    return null
  }
}
