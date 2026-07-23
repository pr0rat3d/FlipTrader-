import { nyMinutesSinceMidnight } from './rvol.js'
import { CandlestickDirection } from './candlestickPatterns.js'

// All tunable, none load-bearing - these adjust the base tier/type confidence
// already computed (0.55-0.95 for TTTF/DTTF/STTF, 0.585-0.85 for IV), they don't
// replace it. Final result is clamped so a modifier can't push a weak signal
// above a strong one's floor, or crush a strong signal to near-zero.
const TREND_ALIGNED_MULTIPLIER = 1.15
const TREND_OPPOSED_MULTIPLIER = 0.80
const PATTERN_ALIGNED_MULTIPLIER = 1.10
const PATTERN_OPPOSED_MULTIPLIER = 0.90
const ORB_ALIGNED_MULTIPLIER = 1.10
const ORB_OPPOSED_MULTIPLIER = 0.90
const PRIME_TIME_MULTIPLIER = 1.05
const CHOP_ZONE_MULTIPLIER = 0.90
const MIN_CONFIDENCE = 0.3
const MAX_CONFIDENCE = 0.98

// VIXY (a VIX-futures ETF, not the spot index - see the comment on
// vixChangePct below for why) moving DOWN on the day is a risk-on read that
// confirms a bullish trade; moving UP is risk-off and confirms bearish. Same
// weight class as the pattern/ORB modifiers, not the primary trend gate -
// this is a supplementary macro-sentiment check, not a hard requirement.
const VIX_ALIGNED_MULTIPLIER = 1.10
const VIX_OPPOSED_MULTIPLIER = 0.90
// Below this, today's VIXY move is treated as noise rather than a real
// risk-on/risk-off signal - avoids the modifier flipping on trivial chop.
const VIX_NEUTRAL_THRESHOLD_PCT = 0.3

// Multi-timeframe RSI confirmation (2026-07-23, opt-in via
// --mtf-rsi-modifier in the backtest, not yet wired into any live cron).
// Inspired by a TradingView multi-TF RSI study the user shared: a
// convergence check across timeframes for ONE symbol, distinct from
// TTF/DIV's existing cross-SYMBOL confluence on a single (5-min) timeframe.
// Found live 2026-07-23: a cluster of bullish DIV alerts (0.96-0.98
// confidence, boosted by the daily-trend modifier below since SPY/QQQ/IWM's
// multi-month trend is bullish) fired into a real gap-down-and-continue
// morning and all 10 real entries stopped out - the daily EMA50/200 trend
// is too coarse a "does this actually apply right now" check for a same-day
// reversal thesis. A higher (but still intraday) timeframe RSI is a nearer,
// more relevant second opinion: if the 1hr RSI is ALSO oversold/overbought
// in the signal's favor, that's real corroborating momentum; if it's still
// firmly on the opposite side, the 5-min divergence is more likely noise
// fighting an intact larger move - exactly today's failure mode.
const MTF_RSI_ALIGNED_MULTIPLIER = 1.10
const MTF_RSI_OPPOSED_MULTIPLIER = 0.90
const MTF_RSI_OVERBOUGHT = 70
const MTF_RSI_OVERSOLD = 30

const MARKET_OPEN_MINUTES = 9 * 60 + 30
const MARKET_CLOSE_MINUTES = 16 * 60
const PRIME_TIME_WINDOW_MINUTES = 45
const CHOP_ZONE_START_MINUTES = 11 * 60 + 30
const CHOP_ZONE_END_MINUTES = 13 * 60 + 30

// Midday (~11:30am-1:30pm ET) is classic chop/whipsaw territory; the first/last
// 45 minutes of the session tend to have the most genuine volume and follow-
// through. Mutually exclusive - a given minute is at most one of these.
// Optional override args default to the live constants above (exact
// unchanged live behavior when omitted) - added 2026-07-16 so the backtest
// can test a shifted chop window without touching live behavior. Found
// live: real 90-day backtest data showed the worst hours were actually
// 10-11am/11am-12pm (right after the prime-time bonus window ends, before
// the current chop window even starts at 11:30), while 1-2pm - inside the
// CURRENT chop window - was the single BEST hour in the dataset. The
// window may be misaligned with where the real chop actually is.
export const isChopZone = (now: Date, startMinutes: number = CHOP_ZONE_START_MINUTES, endMinutes: number = CHOP_ZONE_END_MINUTES): boolean => {
  const minutes = nyMinutesSinceMidnight(now)
  return minutes >= startMinutes && minutes <= endMinutes
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
  orbBreakoutDirection: 'bullish' | 'bearish' | null
  // Today's %-change on VIXY (Finnhub's `dp`), a VIX-futures ETF - not the spot
  // VIX index itself, which isn't available on either data provider's free
  // tier (checked both: Twelve Data's /indices returns nothing for VIX,
  // Finnhub's ^VIX requires a paid subscription). VIXY tracks VIX-direction
  // closely enough for a risk-on/risk-off read. Fetched via Finnhub rather
  // than Twelve Data specifically so this doesn't compete with the existing
  // per-minute Twelve Data credit budget (already fully committed between
  // scan-confluence/scan-day-trades/scan-swings) - Finnhub is a separate quota.
  vixChangePct: number | null
  now?: Date
  chopZoneStartMinutes?: number
  chopZoneEndMinutes?: number
  // Optional/experimental - undefined or null means "not computed," which
  // no-ops exactly like the other optional inputs above. Only the backtest
  // currently passes a real value (opt-in via --mtf-rsi-modifier); no live
  // cron computes or passes this yet.
  higherTimeframeRsi?: number | null
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

  if (inputs.orbBreakoutDirection) {
    const aligned = inputs.orbBreakoutDirection === inputs.direction
    confidence *= aligned ? ORB_ALIGNED_MULTIPLIER : ORB_OPPOSED_MULTIPLIER
  }

  if (inputs.vixChangePct !== null && Math.abs(inputs.vixChangePct) >= VIX_NEUTRAL_THRESHOLD_PCT) {
    const vixDirection = inputs.vixChangePct < 0 ? 'bullish' : 'bearish'
    const aligned = vixDirection === inputs.direction
    confidence *= aligned ? VIX_ALIGNED_MULTIPLIER : VIX_OPPOSED_MULTIPLIER
  }

  if (isChopZone(now, inputs.chopZoneStartMinutes, inputs.chopZoneEndMinutes)) confidence *= CHOP_ZONE_MULTIPLIER
  else if (isPrimeTime(now)) confidence *= PRIME_TIME_MULTIPLIER

  if (inputs.higherTimeframeRsi !== undefined && inputs.higherTimeframeRsi !== null) {
    const rsi = inputs.higherTimeframeRsi
    if (rsi <= MTF_RSI_OVERSOLD || rsi >= MTF_RSI_OVERBOUGHT) {
      const higherTfBullish = rsi <= MTF_RSI_OVERSOLD
      const aligned = (inputs.direction === 'bullish') === higherTfBullish
      confidence *= aligned ? MTF_RSI_ALIGNED_MULTIPLIER : MTF_RSI_OPPOSED_MULTIPLIER
    }
    // Between 30-70: the higher timeframe isn't at an extreme either way -
    // treated as no real opinion, same as the VIX modifier's neutral-move
    // deadband above, rather than inventing a crossing-through-50 detector.
  }

  return Math.min(MAX_CONFIDENCE, Math.max(MIN_CONFIDENCE, confidence))
}
