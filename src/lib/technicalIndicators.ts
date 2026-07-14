import { RSI, MACD, ATR } from 'technicalindicators'

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

export const calculateEMA = (closes: number[], period: number): number => {
  if (closes.length < period) return closes[closes.length - 1]

  let ema = closes.slice(0, period).reduce((a, b) => a + b) / period
  const multiplier = 2 / (period + 1)

  for (let i = period; i < closes.length; i++) {
    ema = (closes[i] - ema) * multiplier + ema
  }

  return ema
}

export const detectRSIDivergence = (closes: number[], rsiValues: number[]): 'bullish' | 'bearish' | null => {
  // RSI.calculate() returns fewer values than the input closes (a `period`-bar
  // warmup with no output) - closes and rsiValues are NOT index-aligned. Both
  // arrays' last element represents "now," so trim closes to rsiValues' length
  // before comparing anything by index.
  const offset = closes.length - rsiValues.length
  if (offset < 0) return null
  const alignedCloses = closes.slice(offset)

  const n = alignedCloses.length - 1
  const lookback = Math.min(10, n)
  if (lookback < 3) return null

  // Compares the CURRENT bar against the extreme of the bars BEFORE it,
  // excluding itself. The previous version included the current bar in the
  // window it compared against, which made the price condition mathematically
  // impossible to satisfy (verified empirically: 2000 random-walk trials, zero
  // non-null results) - this is why no TTF/DTF/STF alert had ever fired.
  const priorCloses = alignedCloses.slice(n - lookback, n)
  const priorRSI = rsiValues.slice(n - lookback, n)

  const priorLow = Math.min(...priorCloses)
  const priorHigh = Math.max(...priorCloses)
  const priorRSILow = Math.min(...priorRSI)
  const priorRSIHigh = Math.max(...priorRSI)

  // Bullish divergence: price makes a new low vs. the recent window, but RSI
  // does NOT confirm with a new low - momentum weakening despite the drop.
  if (alignedCloses[n] < priorLow && rsiValues[n] > priorRSILow) {
    return 'bullish'
  }

  // Bearish divergence: price makes a new high vs. the recent window, but RSI
  // does NOT confirm with a new high - momentum weakening despite the rise.
  if (alignedCloses[n] > priorHigh && rsiValues[n] < priorRSIHigh) {
    return 'bearish'
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
