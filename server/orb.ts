import { Candle } from './twelvedata.js'
import { calculateOpeningRange } from './supportResistance.js'

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

export interface ORBCandidateSignal {
  symbol: string
  macdCurl: string | null
  candles: Candle[]
}

// A symbol qualifies as an ORB candidate only with BOTH a same-direction
// breakout AND MACD curl agreement - a bare candle-close breakout alone isn't
// enough confirmation. The daily-trend gate is checked separately (once, via
// a representative symbol) since trend is a session-level condition, not a
// per-symbol one.
export const filterORBCandidates = (
  signals: ORBCandidateSignal[],
  direction: 'bullish' | 'bearish'
): string[] => {
  return signals
    .filter(s => s.macdCurl === direction)
    .filter(s => {
      const or = calculateOpeningRange(s.candles)
      return detectORBBreakout(s.candles, or?.orh ?? null, or?.orl ?? null) === direction
    })
    .map(s => s.symbol)
}

// The "especially on supertrend days" requirement, made concrete: a hard gate
// to fire at all, not a soft modifier - null EMAs (not enough daily history
// yet) fail closed rather than firing on unknown trend.
export const isDailyTrendAligned = (
  direction: 'bullish' | 'bearish',
  dailyEma50: number | null,
  dailyEma200: number | null
): boolean => {
  if (dailyEma50 === null || dailyEma200 === null) return false
  const dailyTrendBullish = dailyEma50 > dailyEma200
  return (direction === 'bullish') === dailyTrendBullish
}

// Mirrors TTF/DTF/STF and IV's existing index-count-scaling convention - a
// starting point between IV's tiers and full TTF, adjustable once real data
// comes in via the Confidence Calibration page.
export const orbBaseConfidence = (qualifyingCount: number): number => {
  if (qualifyingCount >= 3) return 0.80
  if (qualifyingCount === 2) return 0.65
  return 0.55
}
