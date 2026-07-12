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
  if (closes.length < 3 || rsiValues.length < 3) return null

  const n = closes.length - 1
  const priceLowIdx = closes.lastIndexOf(Math.min(...closes.slice(-3)))
  const priceHighIdx = closes.lastIndexOf(Math.max(...closes.slice(-3)))

  const rsiLowIdx = rsiValues.lastIndexOf(Math.min(...rsiValues.slice(-3)))
  const rsiHighIdx = rsiValues.lastIndexOf(Math.max(...rsiValues.slice(-3)))

  // Bullish divergence: price lower low, RSI higher low
  if (closes[n] < closes[priceLowIdx] && rsiValues[n] > rsiValues[rsiLowIdx]) {
    return 'bullish'
  }

  // Bearish divergence: price higher high, RSI lower high
  if (closes[n] > closes[priceHighIdx] && rsiValues[n] < rsiValues[rsiHighIdx]) {
    return 'bearish'
  }

  return null
}

export const detectMACDCurl = (macdData: any[]): 'bullish' | 'bearish' | null => {
  if (macdData.length < 2) return null

  const current = macdData[macdData.length - 1]
  const previous = macdData[macdData.length - 2]

  // Bullish: MACD crosses above signal line
  if (previous.MACD < previous.signal && current.MACD > current.signal) {
    return 'bullish'
  }

  // Bearish: MACD crosses below signal line
  if (previous.MACD > previous.signal && current.MACD < current.signal) {
    return 'bearish'
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
