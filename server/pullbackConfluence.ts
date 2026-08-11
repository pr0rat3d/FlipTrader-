import { Candle } from './twelvedata.js'
import { calculateEMA, calculateMACD } from '../src/lib/technicalIndicators.js'
import { isDailyTrendAligned, continuationTargetPrice } from './orb.js'

// Prototype signal (2026-08-11, alert-only via scan-confluence.ts /
// --pbc-min-score in scripts/backtestRun.ts). "Multi-timeframe" here means
// 5-min bars (fast/entry leg) + daily EMA50/200 (trend leg, already fetched
// via getDailyLevels) - NOT a genuine 1-minute fetch, which would collide
// with Twelve Data's already-fully-committed credit budget (see
// scan-confluence.ts's own header comments). dailyEma50/dailyEma200 are
// passed in by the caller (already fetched), same pattern orb.ts's
// isDailyTrendAligned uses - this module does no I/O of its own.

const FRACTAL_ARM_BARS = 2
const SWING_LOOKBACK_BARS = 30
const CONSOLIDATION_VOLUME_RATIO = 0.5
const CONSOLIDATION_LOOKBACK_BARS = 2
const VOLUME_AVG_BARS = 10
const VOLUME_SPIKE_MULTIPLIER = 1.5
const PULLBACK_DEPTH_MIN_PCT = 0.01
const PULLBACK_DEPTH_MAX_PCT = 0.02
const FAST_EMA_PERIOD = 9
const FAST_EMA_SLOW_PERIOD = 20
const SCORE_COMPONENT_POINTS = 25
const MIN_BARS_REQUIRED = 30

interface SwingExtreme {
  index: number
  price: number
}

// Most recent fractal swing high (bullish) / low (bearish) in the trailing
// lookback - same peak/trough technique as emaBreakout.ts's
// findNearestSwingLevels, but purpose-built here for "the single most recent
// extreme to measure a pullback against" rather than a clustered
// nearest-level lookup.
const findRecentSwingExtreme = (candles: Candle[], direction: 'bullish' | 'bearish'): SwingExtreme | null => {
  const n = candles.length
  const start = Math.max(FRACTAL_ARM_BARS, n - SWING_LOOKBACK_BARS)
  const end = n - 1 - FRACTAL_ARM_BARS

  let mostRecent: SwingExtreme | null = null

  for (let i = start; i <= end; i++) {
    const bar = candles[i]
    let isExtreme = true
    for (let k = 1; k <= FRACTAL_ARM_BARS; k++) {
      const other = direction === 'bullish' ? [candles[i - k].high, candles[i + k].high] : [candles[i - k].low, candles[i + k].low]
      const barPrice = direction === 'bullish' ? bar.high : bar.low
      if (direction === 'bullish' ? (other[0] >= barPrice || other[1] >= barPrice) : (other[0] <= barPrice || other[1] <= barPrice)) {
        isExtreme = false
        break
      }
    }
    if (isExtreme) {
      const price = direction === 'bullish' ? bar.high : bar.low
      if (!mostRecent || i > mostRecent.index) mostRecent = { index: i, price }
    }
  }

  return mostRecent
}

// The extreme reached AFTER the swing high/low was set, up to now - how far
// price has actually pulled back, and (once reclaimed) the structural stop.
const pullbackExtremeSince = (candles: Candle[], swingIndex: number, direction: 'bullish' | 'bearish'): number => {
  const after = candles.slice(swingIndex + 1)
  if (after.length === 0) return direction === 'bullish' ? candles[candles.length - 1].low : candles[candles.length - 1].high
  return direction === 'bullish' ? Math.min(...after.map(c => c.low)) : Math.max(...after.map(c => c.high))
}

export interface PullbackConfluenceResult {
  direction: 'bullish' | 'bearish'
  score: number
  fastTrendPoints: number
  dailyTrendPoints: number
  pullbackPoints: number
  bouncePoints: number
  swingExtreme: number
  pullbackExtreme: number
  vwap: number | null
  pullbackDepthPct: number
  consolidating: boolean
  macdFavorable: boolean
  volumeSpike: boolean
  priceReclaimed: boolean
  emasStacked: boolean
  entryPrice: number
  stopLoss: number
  target: number
}

// Returns null only when there's no directional setup to measure at all -
// no fast-EMA/daily-trend alignment (spec's hard "if uptrend1m && uptrend5m"
// gate), or no swing extreme found in the lookback window. Once a real
// pullback structure exists, always returns a full scored result (even a
// weak one) so backtesting can see near-misses, not just the 75+ winners -
// same "return null only when there's nothing to score" shape as
// emaBreakout.ts's scoreEmaBreakout.
// vwap is caller-supplied (like dailyEma50/dailyEma200) rather than computed
// internally - server/vwap.ts's calculateSessionVWAP hardcodes "today" as
// nyDateKey(new Date()), the REAL current date, which silently returns null
// for every bar in a historical backtest replay (same bug class already
// found/fixed for ORB's opening range - see server/backtest/replayHelpers.ts's
// sessionVWAPFor, the replay-safe equivalent the backtest caller uses instead).
export const detectPullbackConfluence = (
  candles: Candle[],
  direction: 'bullish' | 'bearish',
  dailyEma50: number | null,
  dailyEma200: number | null,
  vwap: number | null
): PullbackConfluenceResult | null => {
  if (candles.length < MIN_BARS_REQUIRED) return null

  const closes = candles.map(c => c.close)
  const entryPrice = closes[closes.length - 1]
  const latest = candles[candles.length - 1]

  const ema9 = calculateEMA(closes, FAST_EMA_PERIOD)
  const ema20 = calculateEMA(closes, FAST_EMA_SLOW_PERIOD)
  const emasStacked = direction === 'bullish' ? ema9 > ema20 : ema9 < ema20
  const fastTrendPoints = emasStacked ? SCORE_COMPONENT_POINTS : 0

  const dailyTrendPoints = isDailyTrendAligned(direction, dailyEma50, dailyEma200) ? SCORE_COMPONENT_POINTS : 0

  if (fastTrendPoints === 0 || dailyTrendPoints === 0) return null

  const swing = findRecentSwingExtreme(candles, direction)
  if (!swing) return null

  const pullbackExtreme = pullbackExtremeSince(candles, swing.index, direction)
  const pullbackDepthPct = Math.abs(swing.price - pullbackExtreme) / swing.price
  const heldVwap = vwap !== null && (direction === 'bullish' ? entryPrice > vwap : entryPrice < vwap)
  const depthInRange = pullbackDepthPct >= PULLBACK_DEPTH_MIN_PCT && pullbackDepthPct <= PULLBACK_DEPTH_MAX_PCT
  const pullbackPoints = depthInRange && heldVwap ? SCORE_COMPONENT_POINTS : 0

  const recentVolumes = candles.slice(-CONSOLIDATION_LOOKBACK_BARS).map(c => c.volume)
  const avgVolumeWindow = candles.slice(-1 - VOLUME_AVG_BARS, -1).map(c => c.volume)
  const avgVolume = avgVolumeWindow.length > 0 ? avgVolumeWindow.reduce((a, b) => a + b, 0) / avgVolumeWindow.length : null
  const consolidating = avgVolume !== null && avgVolume > 0 && recentVolumes.every(v => v < avgVolume * CONSOLIDATION_VOLUME_RATIO)

  const macdData = calculateMACD(closes)
  const macdLatestValue = macdData[macdData.length - 1]?.MACD
  const macdPrevValue = macdData[macdData.length - 2]?.MACD
  const macdFavorable = macdLatestValue !== undefined && (
    direction === 'bullish'
      ? macdLatestValue > 0 || (macdPrevValue !== undefined && macdLatestValue > macdPrevValue)
      : macdLatestValue < 0 || (macdPrevValue !== undefined && macdLatestValue < macdPrevValue)
  )

  const volumeSpike = avgVolume !== null && avgVolume > 0 && latest.volume > VOLUME_SPIKE_MULTIPLIER * avgVolume
  const priceReclaimed = direction === 'bullish' ? entryPrice > pullbackExtreme : entryPrice < pullbackExtreme

  const bouncePoints = (consolidating && macdFavorable && volumeSpike && priceReclaimed && emasStacked) ? SCORE_COMPONENT_POINTS : 0

  const stopLoss = pullbackExtreme
  const target = continuationTargetPrice(direction, entryPrice, stopLoss)

  return {
    direction,
    score: fastTrendPoints + dailyTrendPoints + pullbackPoints + bouncePoints,
    fastTrendPoints, dailyTrendPoints, pullbackPoints, bouncePoints,
    swingExtreme: swing.price,
    pullbackExtreme,
    vwap,
    pullbackDepthPct,
    consolidating,
    macdFavorable,
    volumeSpike,
    priceReclaimed,
    emasStacked,
    entryPrice,
    stopLoss,
    target
  }
}
