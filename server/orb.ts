import { Candle } from './twelvedata.js'

// Full candle CLOSE outside the opening range (not a wick) - the latest bar
// having already closed beyond orh/orl. "Continuation" isn't a separate
// multi-bar streak check here - it's captured by the confidence modifier's
// own alignment logic (server/confidenceModifiers.ts), which only rewards
// this when it agrees with the signal's own direction.
export const detectORBBreakout = (
  candles: Candle[],
  orh: number | null,
  orl: number | null
): 'bullish' | 'bearish' | null => {
  if (orh === null || orl === null || candles.length === 0) return null

  const latestClose = candles[candles.length - 1].close
  if (latestClose > orh) return 'bullish'
  if (latestClose < orl) return 'bearish'
  return null
}
