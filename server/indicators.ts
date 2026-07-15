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

// macdLookback: how many recent bars count as "still backing" a curl - a
// trailing count, same meaning whether applied to `closes` or `macdData`.
// Defaults to 1 (exact current-bar cross only) so any other caller keeps the
// old strict behavior; scan-confluence.ts passes today's session bar count so
// a single early-session cross still backs a breakout that develops later.
//
// BUG (found live, 2026-07-15 morning session): this used to subtract
// macdData's warm-up offset from the lookback before passing it down
// (`macdLookback - macdOffset`), on the theory that macdData is shorter than
// closes so the count needed shrinking to "stay in bounds." That reasoning
// was wrong - a TRAILING count needs no offset conversion at all, since both
// arrays end at the same most-recent bar and only differ in where they
// start. Subtracting the offset (~25 bars for a 12/26/9 MACD, confirmed
// empirically) meant the lookback silently clamped to 1 - the ORIGINAL
// exact-bar-only bug this was supposed to fix - for roughly the first two
// hours of every single session (until today's bar count exceeded 25),
// which is exactly when this was caught: alerts were unexpectedly sparse
// all morning on a day IWM had a genuine, sustained ORB breakout.
export const analyzeCandles = (closes: number[], macdLookback: number = 1): SignalResult | null => {
  if (closes.length < 26) return null

  try {
    const rsiValues = calculateRSI(closes, 14)
    const macdData = calculateMACD(closes)

    const rsiDivergence = detectRSIDivergence(closes, rsiValues)
    const macdCurl = detectMACDCurl(macdData, macdLookback)

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
