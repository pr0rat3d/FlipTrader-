import { Candle } from './twelvedata.js'
import { calculateCCI } from '../src/lib/technicalIndicators.js'
import { isDailyTrendAligned } from './orb.js'

// Prototype signal (2026-08-23, backtest-only via --cci-min-score in
// scripts/backtestRun.ts). Tests a specific trading-friend thesis: classic
// reversal confluence (RSI bottom + MACD cross + double-bottom, this app's
// existing DIV/TTTF family) is rare enough that waiting for it means
// chasing or buying late - CCI crossing back above -100 (bullish) / below
// +100 (bearish) after having been beyond it is used instead as an
// earlier, higher-frequency "reset" trigger, sized as a quick scalp rather
// than a full trend-reversal hold ("get in, get out... you do not need to
// hold for hero").
//
// CCI is unbounded (unlike RSI's 0-100), so unlike RSI-oversold it can sit
// beyond +-100 for an extended run during a real trend, not just a brief
// dip - the single biggest risk flagged before building this: a bullish
// "reset" firing repeatedly through a real downtrend (catching a falling
// knife), each one just getting run over. depthPoints/trendPoints below
// exist specifically so the backtest can measure whether that risk is
// real for SPY/QQQ/IWM, not to pre-judge it - --cci-min-score lets a run
// require them (or not).

const CCI_PERIOD = 20
const CCI_THRESHOLD = 100
// How much deeper than the base threshold counts as a real washout/blowoff
// ("bottoms out") rather than a shallow one-bar dip past -100/+100.
const CCI_DEEP_THRESHOLD = 150
const SCORE_BASE_POINTS = 50
const SCORE_COMPONENT_POINTS = 25
// Same volume-spike convention emaBreakout.ts/pullbackConfluence.ts/
// remora.ts already use elsewhere in this file's family - the reset bar
// itself trading above-average volume, on the theory that a reversal real
// participants are actually acting on shows up as a volume tell, not just
// a quiet drift back through the threshold.
const VOLUME_SPIKE_MULTIPLIER = 1.5
const VOLUME_AVG_BARS = 20
// CCI(20) needs 20 highs/lows/closes to produce its first value; a small
// buffer on top so the "how far back was CCI beyond the threshold" walk
// below always has real history to look at, not just the indicator's own
// first output.
const MIN_BARS_REQUIRED = 30

export interface CciResetResult {
  direction: 'bullish' | 'bearish'
  score: number
  depthPoints: number
  trendPoints: number
  volumePoints: number
  volumeRatio: number
  cciAtReset: number
  extremeCci: number
  barsBeyondThreshold: number
  entryPrice: number
  stopLoss: number
  target: number
}

// Extreme low (bullish) / high (bearish) and deepest CCI reading across the
// contiguous run of bars (immediately before the reset bar) where CCI
// stayed beyond the threshold - the structural stop and the "how real was
// this washout" reading. Mirrors remora.ts's findReversal: "the true
// extreme of the whole failed move," here the whole oversold/overbought
// run instead of a failed breakout. cciValues/candles are index-aligned
// via `offset` (see detectCciReset for why - same pattern
// detectRSIDivergence already documents).
const runExtremeAndDepth = (
  candles: Candle[], cciValues: number[], offset: number, direction: 'bullish' | 'bearish'
): { extreme: number; extremeCci: number; barsBeyond: number } | null => {
  const last = cciValues.length - 1
  let extreme: number | null = null
  let extremeCci: number | null = null
  let barsBeyond = 0

  for (let j = last - 1; j >= 0; j--) {
    const cci = cciValues[j]
    const beyond = direction === 'bullish' ? cci <= -CCI_THRESHOLD : cci >= CCI_THRESHOLD
    if (!beyond) break
    barsBeyond++
    const candle = candles[j + offset]
    const price = direction === 'bullish' ? candle.low : candle.high
    if (extreme === null || (direction === 'bullish' ? price < extreme : price > extreme)) extreme = price
    if (extremeCci === null || (direction === 'bullish' ? cci < extremeCci : cci > extremeCci)) extremeCci = cci
  }

  if (extreme === null || extremeCci === null) return null
  return { extreme, extremeCci, barsBeyond }
}

// targetRMultiple defaults to 1 (not this app's usual 2R elsewhere) - the
// friend's thesis is explicitly a quick scalp ("get in, get out... you do
// not need to hold for hero"), not a full trend-continuation hold, so the
// target construction intentionally does not reuse orb.ts's
// continuationTargetPrice/its hardcoded 2R. Overridable for sweeping.
//
// requireVolumeConfirmation (2026-08-23): hard gate rather than folded
// into the score threshold, same reasoning as tttfMomentumResetGate/
// divJointResetGate in scripts/backtestRun.ts - a boolean opt-in lets a
// backtest run isolate this ONE variable's effect (on vs off, same score
// threshold) instead of it being entangled with depth/trend inside one
// number. volumePoints/volumeRatio are still computed either way so a run
// that leaves this off can still see the diagnostic in the output.
export const detectCciReset = (
  candles: Candle[],
  direction: 'bullish' | 'bearish',
  dailyEma50: number | null,
  dailyEma200: number | null,
  targetRMultiple: number = 1,
  requireVolumeConfirmation: boolean = false
): CciResetResult | null => {
  if (candles.length < MIN_BARS_REQUIRED) return null

  const highs = candles.map(c => c.high)
  const lows = candles.map(c => c.low)
  const closes = candles.map(c => c.close)
  const cciValues = calculateCCI(highs, lows, closes, CCI_PERIOD)
  if (cciValues.length < 2) return null

  // cciValues is shorter than candles (CCI_PERIOD-bar warmup, no output) -
  // both arrays' LAST element is "now," so offset converts a cciValues
  // index to a candles index.
  const offset = candles.length - cciValues.length
  const last = cciValues.length - 1

  const prevCci = cciValues[last - 1]
  const currentCci = cciValues[last]

  // Must be the LATEST bar - "ending right now," same pattern
  // remora.ts's evaluateBounce/emaBreakout.ts use, not "did a reset happen
  // anywhere recently" (which would fire stale for several bars after).
  const triggered = direction === 'bullish'
    ? prevCci <= -CCI_THRESHOLD && currentCci > -CCI_THRESHOLD
    : prevCci >= CCI_THRESHOLD && currentCci < CCI_THRESHOLD
  if (!triggered) return null

  const run = runExtremeAndDepth(candles, cciValues, offset, direction)
  if (!run) return null

  const depthPoints = (direction === 'bullish' ? run.extremeCci <= -CCI_DEEP_THRESHOLD : run.extremeCci >= CCI_DEEP_THRESHOLD)
    ? SCORE_COMPONENT_POINTS : 0
  const trendPoints = isDailyTrendAligned(direction, dailyEma50, dailyEma200) ? SCORE_COMPONENT_POINTS : 0

  const resetBar = candles[candles.length - 1]
  const avgVolWindow = candles.slice(Math.max(0, candles.length - 1 - VOLUME_AVG_BARS), candles.length - 1).map(c => c.volume)
  const avgVolume = avgVolWindow.length > 0 ? avgVolWindow.reduce((a, b) => a + b, 0) / avgVolWindow.length : null
  const volumeRatio = avgVolume !== null && avgVolume > 0 ? resetBar.volume / avgVolume : 0
  const volumeConfirmed = avgVolume !== null && avgVolume > 0 && resetBar.volume > VOLUME_SPIKE_MULTIPLIER * avgVolume
  if (requireVolumeConfirmation && !volumeConfirmed) return null
  const volumePoints = volumeConfirmed ? SCORE_COMPONENT_POINTS : 0

  const entryPrice = closes[closes.length - 1]
  const stopLoss = run.extreme
  const riskPerShare = Math.abs(entryPrice - stopLoss)
  const target = direction === 'bullish'
    ? entryPrice + targetRMultiple * riskPerShare
    : entryPrice - targetRMultiple * riskPerShare

  return {
    direction,
    score: SCORE_BASE_POINTS + depthPoints + trendPoints + volumePoints,
    depthPoints,
    trendPoints,
    volumePoints,
    volumeRatio,
    cciAtReset: currentCci,
    extremeCci: run.extremeCci,
    barsBeyondThreshold: run.barsBeyond,
    entryPrice,
    stopLoss,
    target
  }
}
