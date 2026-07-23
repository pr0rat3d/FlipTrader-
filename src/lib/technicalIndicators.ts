import { RSI, MACD, ATR, ADX } from 'technicalindicators'

export const calculateRSI = (closes: number[], period: number = 14): number[] => {
  return RSI.calculate({ values: closes, period })
}

export const calculateMACD = (closes: number[]) => {
  return MACD.calculate({
    values: closes,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false
  })
}

export const calculateATR = (highs: number[], lows: number[], closes: number[], period: number = 14): number[] => {
  return ATR.calculate({ high: highs, low: lows, close: closes, period })
}

// Trend STRENGTH, not direction - a high ADX means a real trending move is
// underway regardless of which way; low ADX means chop. Used as a regime
// filter (2026-07-23, opt-in in the backtest) distinct from direction-based
// checks like the daily-EMA trend modifier.
export const calculateADX = (highs: number[], lows: number[], closes: number[], period: number = 14) => {
  return ADX.calculate({ high: highs, low: lows, close: closes, period })
}

export const calculateEMA = (closes: number[], period: number): number => {
  if (closes.length < period) return closes[closes.length - 1]

  let ema = closes.slice(0, period).reduce((a, b) => a + b) / period
  const multiplier = 2 / (period + 1)

  for (let i = period; i < closes.length; i++) {
    ema = (closes[i] - ema) * multiplier + ema
  }

  return ema
}

// `scanLookback` controls how many recent bars are checked for a divergence
// condition, not just the current bar - mirrors detectMACDCurl's `lookback`
// param and exists for the same reason: the confirming indicator (a real
// MACD crossover) is inherently the LATER of the two events, since the
// histogram has to fully collapse through zero first. Found live
// 2026-07-15: SPY's divergence condition was true at 2:36pm ET (a marginal
// new price high with RSI below its own recent peak), but MACD didn't
// actually cross until 2:48pm - by which point price was no longer at a
// new high, so the divergence condition (checked only on the current bar)
// had already gone false again too. TTF/DTF/STF's `rsiDivergence ===
// macdCurl` same-bar requirement never had a chance to see both conditions
// true at once. Scans newest-to-oldest so a more recent divergence
// correctly wins over a stale one further back. Defaults to 1 (exact
// current-bar-only) so any other caller keeps the old strict behavior.
export const detectRSIDivergence = (closes: number[], rsiValues: number[], scanLookback: number = 1): 'bullish' | 'bearish' | null => {
  // RSI.calculate() returns fewer values than the input closes (a `period`-bar
  // warmup with no output) - closes and rsiValues are NOT index-aligned. Both
  // arrays' last element represents "now," so trim closes to rsiValues' length
  // before comparing anything by index.
  const offset = closes.length - rsiValues.length
  if (offset < 0) return null
  const alignedCloses = closes.slice(offset)

  const n = alignedCloses.length - 1
  const earliest = Math.max(0, n - scanLookback + 1)

  for (let i = n; i >= earliest; i--) {
    // Compares bar `i` against the extreme of the bars BEFORE it, excluding
    // itself. The original version included the current bar in the window
    // it compared against, which made the price condition mathematically
    // impossible to satisfy (verified empirically: 2000 random-walk trials,
    // zero non-null results) - this is why no TTF/DTF/STF alert had ever
    // fired before that fix.
    const priorWindow = Math.min(10, i)
    if (priorWindow < 3) continue

    const priorCloses = alignedCloses.slice(i - priorWindow, i)
    const priorRSI = rsiValues.slice(i - priorWindow, i)

    const priorLow = Math.min(...priorCloses)
    const priorHigh = Math.max(...priorCloses)
    const priorRSILow = Math.min(...priorRSI)
    const priorRSIHigh = Math.max(...priorRSI)

    // Bullish divergence: price makes a new low vs. the recent window, but RSI
    // does NOT confirm with a new low - momentum weakening despite the drop.
    if (alignedCloses[i] < priorLow && rsiValues[i] > priorRSILow) {
      return 'bullish'
    }

    // Bearish divergence: price makes a new high vs. the recent window, but RSI
    // does NOT confirm with a new high - momentum weakening despite the rise.
    if (alignedCloses[i] > priorHigh && rsiValues[i] < priorRSIHigh) {
      return 'bearish'
    }
  }

  return null
}

// Catches momentum turning over BEFORE the actual MACD crossover -
// detectMACDCurl's crossover is inherently the LATER of the two events,
// since the histogram has to fully collapse through zero first. A visible
// deceleration (the histogram shrinking toward zero for several
// consecutive bars, without having crossed yet) is an earlier, less
// certain tell - `bars` consecutive shrinking readings are required so
// ordinary single-bar noise doesn't read as a real turn.
export const detectHistogramDeceleration = (macdData: { histogram?: number }[], bars: number = 3): 'bullish' | 'bearish' | null => {
  if (macdData.length < bars + 1) return null

  const recent = macdData.slice(-(bars + 1)).map(d => d.histogram)
  if (recent.some(h => h === undefined)) return null
  const values = recent as number[]
  const current = values[values.length - 1]

  if (current > 0) {
    // Positive and shrinking toward zero every bar - anticipates a bearish cross.
    for (let i = 1; i < values.length; i++) {
      if (values[i] >= values[i - 1]) return null
    }
    return 'bearish'
  }

  if (current < 0) {
    // Negative and growing toward zero every bar - anticipates a bullish cross.
    for (let i = 1; i < values.length; i++) {
      if (values[i] <= values[i - 1]) return null
    }
    return 'bullish'
  }

  return null
}

// `lookback` controls how many recent bars are searched for a crossover, not
// just the latest one. A pure latest-bar check means a breakout/continuation
// minutes after the actual cross (the normal case - crosses happen once,
// moves play out over many bars after) reads as "no curl" even though MACD
// never gave back the signal. Scans newest-to-oldest so a more recent
// opposite-direction cross correctly wins over a stale one further back.
export const detectMACDCurl = (macdData: any[], lookback: number = 1): 'bullish' | 'bearish' | null => {
  if (macdData.length < 2) return null

  const earliest = Math.max(1, macdData.length - lookback)

  for (let i = macdData.length - 1; i >= earliest; i--) {
    const current = macdData[i]
    const previous = macdData[i - 1]

    if (previous.MACD < previous.signal && current.MACD > current.signal) {
      return 'bullish'
    }
    if (previous.MACD > previous.signal && current.MACD < current.signal) {
      return 'bearish'
    }
  }

  return null
}

export const detectTopBottomPattern = (closes: number[]): string | null => {
  if (closes.length < 5) return null

  const recentPrices = closes.slice(-5)

  // Simple double top detection
  const peaks = []
  for (let i = 1; i < recentPrices.length - 1; i++) {
    if (recentPrices[i] > recentPrices[i - 1] && recentPrices[i] > recentPrices[i + 1]) {
      peaks.push({ index: i, price: recentPrices[i] })
    }
  }

  if (peaks.length >= 2) {
    const priceDiff = Math.abs(peaks[0].price - peaks[1].price)
    if (priceDiff / peaks[0].price < 0.01) {
      return 'double_top'
    }
  }

  return null
}
