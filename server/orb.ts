import { Candle } from './twelvedata.js'
import { calculateOpeningRange } from './supportResistance.js'

type OpeningRangeFn = (candles: Candle[]) => { orh: number; orl: number } | null

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
//
// `openingRangeFn` defaults to the live calculateOpeningRange (unchanged
// live behavior) but can be overridden - found live 2026-07-16 that the
// backtest was calling this with historical replay candles while
// calculateOpeningRange internally hardcodes "today" as
// nyDateKey(new Date()), the REAL current date. For any historical day
// that isn't literally today, that filter matches nothing, so
// calculateOpeningRange always returned null and this function always
// returned zero candidates - looked exactly like "ORB never qualifies in
// 90 days of real data," which was actually just this bug, not a real
// finding about the market. The backtest now injects
// server/backtest/replayHelpers.ts's openingRangeFor instead.
export const filterORBCandidates = (
  signals: ORBCandidateSignal[],
  direction: 'bullish' | 'bearish',
  openingRangeFn: OpeningRangeFn = calculateOpeningRange
): string[] => {
  return signals
    .filter(s => s.macdCurl === direction)
    .filter(s => {
      const or = openingRangeFn(s.candles)
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

// Alternative trend gate proposed 2026-07-16, after a live session where
// SPY/QQQ/IWM spent from 12:05pm ET onward in a persistent stair-step
// decline - a real, clean bearish ORB continuation candidate existed
// almost the entire stretch (breakout below the opening range + bearish
// MACD curl agreement) and was blocked every single time by
// isDailyTrendAligned, since the DAILY EMA50/200 reflected a firm
// multi-month uptrend having nothing to do with today's realized move.
// isDailyTrendAligned isn't wrong - the "especially on supertrend days"
// thesis is real - but it's the only path in, so a session that reverses
// against the longer trend gets no ORB continuation trade at all, no
// matter how clean the intraday structure looks.
//
// This checks today's realized trend instead: session VWAP, the standard
// intraday "fair value" reference (already used live in scan-confluence.ts/
// scan-day-trades.ts, not a new concept introduced just for this). Meant to
// be OR'd with isDailyTrendAligned, not replace it - either a supertrend day
// OR a genuine intraday trend day should qualify.
export const isIntradayVwapAligned = (
  direction: 'bullish' | 'bearish',
  currentPrice: number,
  sessionVwap: number | null
): boolean => {
  if (sessionVwap === null) return false
  return direction === 'bullish' ? currentPrice > sessionVwap : currentPrice < sessionVwap
}

// Mirrors TTTF/DTTF/STTF and IV's existing index-count-scaling convention - a
// starting point between IV's tiers and full TTTF, adjustable once real data
// comes in via the Confidence Calibration page.
export const orbBaseConfidence = (qualifyingCount: number): number => {
  if (qualifyingCount >= 3) return 0.80
  if (qualifyingCount === 2) return 0.65
  return 0.55
}

// ORB and IV are both continuation/rejection plays - they need a target
// further along in the signal's OWN direction, NOT the 50 EMA reversion
// target that only makes sense for TTTF/DTTF/STTF's genuine RSI-divergence
// mean-reversion thesis. The 50 EMA is a lagging average with no natural
// reason to sit on the correct side of entry for either of these: it's
// frequently BEHIND price on the trend days ORB is designed to fire on
// ("especially on supertrend days"), and IV's "reject off a level and
// continue" thesis (confluence_type e.g. pdh_rejection) isn't a reversion
// play either despite the field being named target_50ema.
//
// Found live for ORB first (2026-07-14: SPY entry $751.61, 50EMA target
// $751.00 - a bullish trade "targeting" a lower price), fixed there, but
// the same bug was still live for IV - confirmed empirically 2026-07-15:
// 72 of 99 of that day's IV legs had target_50ema_price on the wrong side
// of entry. This was worse than cosmetic: profit_targets' own stop-hit
// tracking (applyPriceSample) infers trade direction by comparing
// target_50ema_price to entry_price (no direction column to check
// instead), so a wrong-side target made it think a bearish trade was
// bullish - the correctly-computed bearish stop (above entry) then looked
// like an already-crossed bullish stop, and legs were false-flagged
// stopped_out within fractions of a second of being created. It also fed
// the options bot's strike selection a stale confluence_level with no
// target-side guard, and backwards 10/20/30% milestones into the old
// shares-model's scale-out limit orders (same failure mode as ORB's
// original bug) before that model was replaced.
//
// A fixed R-multiple of the same ATR-based stop distance is used instead
// for both ORB and IV: symmetric with the R:R already shown in the UI, and
// guaranteed to land on the correct side of entry by construction.
const CONTINUATION_TARGET_R_MULTIPLE = 2

export const continuationTargetPrice = (
  direction: 'bullish' | 'bearish',
  entryPrice: number,
  stopLossPrice: number | null
): number => {
  if (stopLossPrice === null) return entryPrice
  const riskPerShare = Math.abs(entryPrice - stopLossPrice)
  return direction === 'bullish'
    ? entryPrice + CONTINUATION_TARGET_R_MULTIPLE * riskPerShare
    : entryPrice - CONTINUATION_TARGET_R_MULTIPLE * riskPerShare
}
