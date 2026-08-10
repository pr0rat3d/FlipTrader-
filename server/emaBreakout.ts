import { Candle } from './twelvedata.js'
import { calculateEMA } from '../src/lib/technicalIndicators.js'
import { continuationTargetPrice } from './orb.js'

// Prototype signal (2026-08-10, backtest-only via --emab-min-score in
// scripts/backtestRun.ts - see that flag's comment for why). Not imported by
// scan-confluence.ts or any live cron yet. Structure-based stop (nearest
// swing level) instead of ATR - the actual differentiator from every other
// signal type here, which all stop off ATR regardless of where real support/
// resistance sits.

export interface SwingLevels {
  resistance: number | null
  support: number | null
}

// Fractal peak/trough: a bar whose high (low) is strictly the highest
// (lowest) among itself and FRACTAL_ARM_BARS bars on each side - needs bars
// AFTER it to confirm, so the most recent FRACTAL_ARM_BARS bars can never
// qualify (by construction, not a special-cased exclusion).
const FRACTAL_ARM_BARS = 2
// How far back to search for a fractal at all - ~5 hours on 5-min bars, long
// enough to find real recent structure without dragging in stale levels from
// days ago.
const SWING_LOOKBACK_BARS = 60
// Nearby fractal highs/lows within this % of each other are the same level,
// not two different ones - middle of the spec's suggested 0.5-1% range.
const LEVEL_CLUSTER_TOLERANCE_PCT = 0.0075

const clusterAndPickNearest = (levels: number[], currentPrice: number, above: boolean): number | null => {
  const candidates = (above ? levels.filter(l => l > currentPrice) : levels.filter(l => l < currentPrice))
  if (candidates.length === 0) return null

  const sorted = [...candidates].sort((a, b) => a - b)
  const clusters: number[][] = []
  for (const level of sorted) {
    const currentCluster = clusters[clusters.length - 1]
    const lastInCluster = currentCluster?.[currentCluster.length - 1]
    if (lastInCluster !== undefined && Math.abs(level - lastInCluster) / lastInCluster <= LEVEL_CLUSTER_TOLERANCE_PCT) {
      currentCluster.push(level)
    } else {
      clusters.push([level])
    }
  }

  const clusterAverages = clusters.map(c => c.reduce((a, b) => a + b, 0) / c.length)
  return above
    ? clusterAverages.reduce((nearest, v) => (v < nearest ? v : nearest), Infinity)
    : clusterAverages.reduce((nearest, v) => (v > nearest ? v : nearest), -Infinity)
}

// Nearest clustered resistance above currentPrice and support below it, from
// local peaks/troughs in the trailing SWING_LOOKBACK_BARS bars. `candles`
// should already be a walk-forward-safe slice (no future bars) - this
// function does no time filtering of its own.
export const findNearestSwingLevels = (candles: Candle[], currentPrice: number): SwingLevels => {
  const n = candles.length
  const start = Math.max(FRACTAL_ARM_BARS, n - SWING_LOOKBACK_BARS)
  const end = n - 1 - FRACTAL_ARM_BARS

  const peaks: number[] = []
  const troughs: number[] = []

  for (let i = start; i <= end; i++) {
    const bar = candles[i]
    let isPeak = true
    let isTrough = true
    for (let k = 1; k <= FRACTAL_ARM_BARS; k++) {
      if (candles[i - k].high >= bar.high || candles[i + k].high >= bar.high) isPeak = false
      if (candles[i - k].low <= bar.low || candles[i + k].low <= bar.low) isTrough = false
    }
    if (isPeak) peaks.push(bar.high)
    if (isTrough) troughs.push(bar.low)
  }

  return {
    resistance: clusterAndPickNearest(peaks, currentPrice, true),
    support: clusterAndPickNearest(troughs, currentPrice, false)
  }
}

export interface EmaBreakoutResult {
  direction: 'bullish' | 'bearish'
  trendPoints: number
  entryPoints: number
  riskRewardPoints: number
  score: number
  keyLevel: number | null
  stopLoss: number | null
  target: number | null
  brokeLevel: boolean
  volumeSpike: boolean
  closedBeyond: boolean
}

const EMA_FAST_PERIOD = 9
const EMA_SLOW_PERIOD = 21
const TREND_POINTS = 50
const BREAKOUT_POINTS = 15
const VOLUME_POINTS = 15
const CLOSE_BEYOND_POINTS = 10
const RISK_REWARD_POINTS = 10
const VOLUME_SPIKE_MULTIPLIER = 1.5
const VOLUME_AVG_BARS = 20
// EMA21 needs 21 closes to be meaningful at all; same floor analyzeCandles
// already uses elsewhere in this codebase for its own MACD/RSI warmup, kept
// here too so this never scores off a too-short window.
const MIN_BARS_REQUIRED = 26

// Three-part deterministic score (0-100): trend (EMA9/21 stack, 50pts),
// entry trigger (breakout + volume + close-beyond, 40pts), risk/reward
// (stop:target >= 2:1, 10pts). Pure arithmetic - no LLM call, see this
// file's header comment for why. Returns null when the trend leg itself is
// ambiguous (EMAs tangled or price hasn't cleared EMA9) - the original
// spec's "0 points, SKIP" case, nothing else is worth computing then.
export const scoreEmaBreakout = (candles: Candle[]): EmaBreakoutResult | null => {
  if (candles.length < MIN_BARS_REQUIRED) return null

  const closes = candles.map(c => c.close)
  const ema9 = calculateEMA(closes, EMA_FAST_PERIOD)
  const ema21 = calculateEMA(closes, EMA_SLOW_PERIOD)
  const price = closes[closes.length - 1]

  let direction: 'bullish' | 'bearish' | null = null
  if (price > ema9 && ema9 > ema21) direction = 'bullish'
  else if (price < ema9 && ema9 < ema21) direction = 'bearish'
  if (!direction) return null

  const levels = findNearestSwingLevels(candles, price)
  const keyLevel = direction === 'bullish' ? levels.resistance : levels.support
  const oppositeLevel = direction === 'bullish' ? levels.support : levels.resistance

  const latest = candles[candles.length - 1]
  const brokeLevel = keyLevel !== null && (direction === 'bullish' ? price > keyLevel : price < keyLevel)
  // The FULL candle (not just the close) cleared the level - no wick still
  // hanging on the wrong side, i.e. a decisive close rather than a level tag
  // that happened to close a hair past it.
  const closedBeyond = keyLevel !== null && (direction === 'bullish' ? latest.low > keyLevel : latest.high < keyLevel)

  const volumeWindow = candles.slice(-1 - VOLUME_AVG_BARS, -1).map(c => c.volume)
  const avgVolume = volumeWindow.length > 0 ? volumeWindow.reduce((a, b) => a + b, 0) / volumeWindow.length : null
  const volumeSpike = avgVolume !== null && avgVolume > 0 && latest.volume > VOLUME_SPIKE_MULTIPLIER * avgVolume

  const entryPoints = (brokeLevel ? BREAKOUT_POINTS : 0) + (volumeSpike ? VOLUME_POINTS : 0) + (closedBeyond ? CLOSE_BEYOND_POINTS : 0)

  // Stop is the opposite-side swing level (structure, not ATR) - target
  // reuses the same 2R-off-the-stop construction ORB/IV/ADXC already use, so
  // R:R is exactly 2:1 by construction whenever a stop resolves at all.
  const stopLoss = oppositeLevel
  const target = stopLoss !== null ? continuationTargetPrice(direction, price, stopLoss) : null
  const riskRewardPoints = stopLoss !== null && Math.abs(price - stopLoss) > 0 ? RISK_REWARD_POINTS : 0

  return {
    direction,
    trendPoints: TREND_POINTS,
    entryPoints,
    riskRewardPoints,
    score: TREND_POINTS + entryPoints + riskRewardPoints,
    keyLevel,
    stopLoss,
    target,
    brokeLevel,
    volumeSpike,
    closedBeyond
  }
}
