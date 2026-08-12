import { Candle } from './twelvedata.js'
import { findRecentSwingExtreme } from './pullbackConfluence.js'
import { continuationTargetPrice } from './orb.js'

// Prototype signal (2026-08-11, alert-only via scan-confluence.ts /
// --remora-min-score in scripts/backtestRun.ts). Contrarian thesis: a false
// breakout above resistance (bullish) or below support (bearish) that gets
// reversed hard, then bought back on the bounce off the now-invalidated
// level. Stateless by design - the whole breakout->reversal->bounce
// sequence is scanned fresh from the candle window on every call (same
// approach emaBreakout.ts/pullbackConfluence.ts use), not a persisted
// state machine - this app's cron jobs are stateless Vercel functions with
// no memory between invocations, only what's in the candles array itself.

const TIMES_TESTED_LOOKBACK_BARS = 20
const TIMES_TESTED_TOLERANCE_PCT = 0.0075
const BREAKOUT_SEARCH_MAX_BARS = 15
const BREAKOUT_VOLUME_MULTIPLIER = 1.5
const BREAKOUT_VOLUME_AVG_BARS = 20
const REVERSAL_MAX_CANDLES = 5
const REVERSAL_BODY_MIN_PCT = 0.005
const BOUNCE_MAX_CANDLES = 5
const BOUNCE_TOLERANCE_PCT = 0.004
const BOUNCE_VOLUME_MULTIPLIER = 1.5
const BOUNCE_VOLUME_AVG_BARS = 10
const SCORE_COMPONENT_POINTS = 25
const MIN_BARS_REQUIRED = 30

// How many bars before the resistance/support point already came within
// tolerance of it - a level tested multiple times is more structurally
// real than a single random spike. Diagnostic/reporting only, not a gate -
// the spec's own "2+ times OR highest in 30" requirement is already
// implicitly satisfied by findRecentSwingExtreme (a fractal peak is by
// definition the highest/lowest point in its lookback).
const countRecentTests = (candles: Candle[], swingIndex: number, level: number): number => {
  const window = candles.slice(Math.max(0, swingIndex - TIMES_TESTED_LOOKBACK_BARS), swingIndex)
  return window.filter(c =>
    Math.abs(c.high - level) / level <= TIMES_TESTED_TOLERANCE_PCT ||
    Math.abs(c.low - level) / level <= TIMES_TESTED_TOLERANCE_PCT
  ).length
}

interface BreakoutInfo {
  index: number
  volumeRatio: number
}

// First candle (within BREAKOUT_SEARCH_MAX_BARS after the level was set)
// that closes beyond it with a volume spike on that SAME candle - both
// conditions must land on one bar, matching the spec's "breaks out AND
// confirms with volume" framing.
const findBreakout = (candles: Candle[], startIndex: number, level: number, direction: 'bullish' | 'bearish'): BreakoutInfo | null => {
  const searchEnd = Math.min(candles.length - 1, startIndex + BREAKOUT_SEARCH_MAX_BARS)
  for (let i = startIndex; i <= searchEnd; i++) {
    const bar = candles[i]
    const brokeOut = direction === 'bullish' ? bar.close > level : bar.close < level
    if (!brokeOut) continue
    const avgVolWindow = candles.slice(Math.max(0, i - BREAKOUT_VOLUME_AVG_BARS), i).map(c => c.volume)
    const avgVol = avgVolWindow.length > 0 ? avgVolWindow.reduce((a, b) => a + b, 0) / avgVolWindow.length : null
    if (avgVol !== null && avgVol > 0 && bar.volume > BREAKOUT_VOLUME_MULTIPLIER * avgVol) {
      return { index: i, volumeRatio: bar.volume / avgVol }
    }
  }
  return null
}

interface ReversalInfo {
  index: number
  price: number
  bodyPct: number
}

// Within REVERSAL_MAX_CANDLES after the breakout, the first candle that
// closes back on the OTHER side of the level with a real body (not a
// doji) - price is the lowest low (bullish) / highest high (bearish)
// across every bar from the breakout through the reversal, the true
// extreme of the whole failed move, used as the structural stop.
const findReversal = (candles: Candle[], breakoutIndex: number, level: number, direction: 'bullish' | 'bearish', reversalBodyMinPct: number): ReversalInfo | null => {
  const searchEnd = Math.min(candles.length - 1, breakoutIndex + REVERSAL_MAX_CANDLES)
  for (let i = breakoutIndex + 1; i <= searchEnd; i++) {
    const bar = candles[i]
    const reversedBack = direction === 'bullish' ? bar.close < level : bar.close > level
    if (!reversedBack) continue
    const bodyPct = Math.abs(bar.close - bar.open) / bar.open
    if (bodyPct <= reversalBodyMinPct) continue
    const sinceBreakout = candles.slice(breakoutIndex + 1, i + 1)
    const extreme = direction === 'bullish'
      ? Math.min(...sinceBreakout.map(c => c.low))
      : Math.max(...sinceBreakout.map(c => c.high))
    return { index: i, price: extreme, bodyPct }
  }
  return null
}

interface BounceInfo {
  index: number
  price: number
}

// Must be the LATEST bar in the array, within BOUNCE_MAX_CANDLES of the
// reversal - "ending right now," same "evaluate what the current bar
// qualifies as" pattern emaBreakout.ts/pullbackConfluence.ts already use,
// not "did a bounce happen anywhere in the last 5 bars" (which could fire
// stale for several bars after the fact). Volume/VWAP confirmation are
// scored separately in the orchestrator, not required here - this only
// checks the PRICE retest condition.
const evaluateBounce = (candles: Candle[], reversalIndex: number, level: number, reversalPrice: number, direction: 'bullish' | 'bearish'): BounceInfo | null => {
  const latestIndex = candles.length - 1
  if (latestIndex <= reversalIndex || latestIndex > reversalIndex + BOUNCE_MAX_CANDLES) return null
  const bar = candles[latestIndex]
  const distancePct = Math.abs(bar.close - level) / level
  if (distancePct > BOUNCE_TOLERANCE_PCT) return null
  const closingFavorably = direction === 'bullish'
    ? (bar.close >= level && bar.close > reversalPrice)
    : (bar.close <= level && bar.close < reversalPrice)
  if (!closingFavorably) return null
  return { index: latestIndex, price: bar.close }
}

export interface RemoraResult {
  direction: 'bullish' | 'bearish'
  score: number
  bouncePoints: number
  vwapPoints: number
  resistanceLevel: number
  timesTestedRecently: number
  breakoutPrice: number
  breakoutVolumeRatio: number
  reversalPrice: number
  reversalBodyPct: number
  bouncePrice: number
  bounceVolumeRatio: number
  vwap: number | null
  entryPrice: number
  stopLoss: number
  target: number
}

// vwap is caller-supplied (like pullbackConfluence.ts's detectPullbackConfluence)
// rather than computed internally - server/vwap.ts's calculateSessionVWAP
// hardcodes "today" as nyDateKey(new Date()), which silently breaks every
// backtest replay - see that fix's comment for the full explanation.
//
// Breakout -> reversal -> price-retest are treated as hard sequential
// gates (return null if any stage is missing - there's nothing to score
// without a complete sequence, and each stage causally depends on the one
// before it, unlike EMAB/PBC's independent parallel checks). Volume
// confirmation on the bounce and VWAP-hold are then two independent 25-pt
// scored bonuses on top of a confirmed price retest, giving real score
// variance (50/75/100) for backtest tuning instead of an always-100 result.
export const detectRemoraSetup = (
  candles: Candle[],
  direction: 'bullish' | 'bearish',
  vwap: number | null,
  // Override for tuning/backtesting only - live callers omit this and get
  // the original spec-derived default. Found live-data testing 2026-08-11:
  // the default (0.5% single-5min-candle body) never once fired across 90
  // real days on SPY/QQQ/IWM - too strict for these three tickers at this
  // resolution to ever be satisfied, not evidence the underlying "false
  // breakout, then bounce" thesis is wrong.
  reversalBodyMinPctOverride?: number
): RemoraResult | null => {
  if (candles.length < MIN_BARS_REQUIRED) return null

  const swing = findRecentSwingExtreme(candles, direction)
  if (!swing) return null

  const timesTestedRecently = countRecentTests(candles, swing.index, swing.price)

  const breakout = findBreakout(candles, swing.index + 1, swing.price, direction)
  if (!breakout) return null

  const reversal = findReversal(candles, breakout.index, swing.price, direction, reversalBodyMinPctOverride ?? REVERSAL_BODY_MIN_PCT)
  if (!reversal) return null

  const bounce = evaluateBounce(candles, reversal.index, swing.price, reversal.price, direction)
  if (!bounce) return null

  const bounceBar = candles[bounce.index]
  const avgVolWindow = candles.slice(Math.max(0, bounce.index - BOUNCE_VOLUME_AVG_BARS), bounce.index).map(c => c.volume)
  const avgVol = avgVolWindow.length > 0 ? avgVolWindow.reduce((a, b) => a + b, 0) / avgVolWindow.length : null
  const bounceVolumeRatio = avgVol !== null && avgVol > 0 ? bounceBar.volume / avgVol : 0
  const bouncePoints = (avgVol !== null && avgVol > 0 && bounceBar.volume > BOUNCE_VOLUME_MULTIPLIER * avgVol) ? SCORE_COMPONENT_POINTS : 0

  const vwapHeld = vwap !== null && (direction === 'bullish' ? bounce.price > vwap : bounce.price < vwap)
  const vwapPoints = vwapHeld ? SCORE_COMPONENT_POINTS : 0

  const stopLoss = reversal.price
  const entryPrice = bounce.price
  const target = continuationTargetPrice(direction, entryPrice, stopLoss)

  return {
    direction,
    score: SCORE_COMPONENT_POINTS + SCORE_COMPONENT_POINTS + bouncePoints + vwapPoints,
    bouncePoints,
    vwapPoints,
    resistanceLevel: swing.price,
    timesTestedRecently,
    breakoutPrice: candles[breakout.index].close,
    breakoutVolumeRatio: breakout.volumeRatio,
    reversalPrice: reversal.price,
    reversalBodyPct: reversal.bodyPct,
    bouncePrice: bounce.price,
    bounceVolumeRatio,
    vwap,
    entryPrice,
    stopLoss,
    target
  }
}
