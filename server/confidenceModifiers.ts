import { nyMinutesSinceMidnight } from './rvol.js'
import { CandlestickDirection } from './candlestickPatterns.js'

// All tunable, none load-bearing - these adjust the base tier/type confidence
// already computed (0.55-0.95 for TTF/DTF/STF, 0.585-0.85 for IV), they don't
// replace it. Final result is clamped so a modifier can't push a weak signal
// above a strong one's floor, or crush a strong signal to near-zero.
const TREND_ALIGNED_MULTIPLIER = 1.15
const TREND_OPPOSED_MULTIPLIER = 0.80
const PATTERN_ALIGNED_MULTIPLIER = 1.10
const PATTERN_OPPOSED_MULTIPLIER = 0.90
const PRIME_TIME_MULTIPLIER = 1.05
const CHOP_ZONE_MULTIPLIER = 0.90
const MIN_CONFIDENCE = 0.3
const MAX_CONFIDENCE = 0.98

const MARKET_OPEN_MINUTES = 9 * 60 + 30
const MARKET_CLOSE_MINUTES = 16 * 60
const PRIME_TIME_WINDOW_MINUTES = 45
const CHOP_ZONE_START_MINUTES = 11 * 60 + 30
const CHOP_ZONE_END_MINUTES = 13 * 60 + 30

// Midday (~11:30am-1:30pm ET) is classic chop/whipsaw territory; the first/last
// 45 minutes of the session tend to have the most genuine volume and follow-
// through. Mutually exclusive - a given minute is at most one of these.
export const isChopZone = (now: Date): boolean => {
  const minutes = nyMinutesSinceMidnight(now)
  return minutes >= CHOP_ZONE_START_MINUTES && minutes <= CHOP_ZONE_END_MINUTES
}

export const isPrimeTime = (now: Date): boolean => {
  const minutes = nyMinutesSinceMidnight(now)
  return (minutes - MARKET_OPEN_MINUTES <= PRIME_TIME_WINDOW_MINUTES && minutes >= MARKET_OPEN_MINUTES) ||
    (MARKET_CLOSE_MINUTES - minutes <= PRIME_TIME_WINDOW_MINUTES && minutes <= MARKET_CLOSE_MINUTES)
}

export interface ConfidenceModifierInputs {
  direction: 'bullish' | 'bearish'
  dailyEma50: number | null
  dailyEma200: number | null
  candlestickDirection: CandlestickDirection | null
  now?: Date
}

// Layers three modifiers onto an already-computed base confidence: does the
// signal agree with the daily-timeframe trend (EMA50 vs EMA200), does it agree
// with a same-bar candlestick pattern, and is it firing during a historically
// reliable or chop-prone part of the session.
export const applyConfidenceModifiers = (baseConfidence: number, inputs: ConfidenceModifierInputs): number => {
  let confidence = baseConfidence
  const now = inputs.now ?? new Date()

  if (inputs.dailyEma50 !== null && inputs.dailyEma200 !== null) {
    const dailyTrendBullish = inputs.dailyEma50 > inputs.dailyEma200
    const aligned = (inputs.direction === 'bullish') === dailyTrendBullish
    confidence *= aligned ? TREND_ALIGNED_MULTIPLIER : TREND_OPPOSED_MULTIPLIER
  }

  if (inputs.candlestickDirection && inputs.candlestickDirection !== 'neutral') {
    const aligned = inputs.candlestickDirection === inputs.direction
    confidence *= aligned ? PATTERN_ALIGNED_MULTIPLIER : PATTERN_OPPOSED_MULTIPLIER
  }

  if (isChopZone(now)) confidence *= CHOP_ZONE_MULTIPLIER
  else if (isPrimeTime(now)) confidence *= PRIME_TIME_MULTIPLIER

  return Math.min(MAX_CONFIDENCE, Math.max(MIN_CONFIDENCE, confidence))
}
