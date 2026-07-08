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

export const analyzeCandles = (closes: number[]): SignalResult | null => {
  if (closes.length < 26) return null

  try {
    const rsiValues = calculateRSI(closes, 14)
    const macdData = calculateMACD(closes)

    const rsiDivergence = detectRSIDivergence(closes, rsiValues)
    const macdCurl = detectMACDCurl(macdData)

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
