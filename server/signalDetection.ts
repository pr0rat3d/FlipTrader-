import { SupportResistanceLevels } from './supportResistance.js'
import { Candle } from './twelvedata.js'

export type ConfluenceType = 'pdh_rejection' | 'pdl_bounce' | 'or_rejection' | 'gap_fill_target'

export interface IVSignalResult {
  confluenceType: ConfluenceType
  confluenceLevel: number
  confidence: number
}

const DEFAULT_TOLERANCE = 0.01 // 1%

const isNear = (price: number, target: number | null, tolerance: number): boolean => {
  if (target === null) return false
  return Math.abs(price - target) / target <= tolerance
}

// How close a candle's own low/high must get to the level to count as an
// actual test of it - much tighter than DEFAULT_TOLERANCE, which only
// screens whether the CURRENT price is loosely in the neighborhood.
const TOUCH_TOLERANCE = 0.0015 // 0.15%
const TOUCH_LOOKBACK_BARS = 6 // ~30min on the 5-min bars both live and the backtest use
// Current price must have moved back past the level by more than this to
// count as a genuine reclaim, not just noise sitting exactly on it.
const RECLAIM_MARGIN = 0.0005 // 0.05%

// Confirms the level was actually tested recently (a candle's low/high
// pierced or came within TOUCH_TOLERANCE of it) AND price has since moved
// back to the favorable side of it - a real bounce/rejection, not just
// "currently somewhere nearby." Found live 2026-07-15/16: the old
// proximity-only isNear check fired pdl_bounce whenever price sat anywhere
// in a wide ~1%-of-price band around PDL (e.g. $7.50 wide on a $750 stock),
// with no requirement that a bounce was actually happening, and no
// requirement price had even reclaimed the level yet. 22 of the last 24
// pdl_bounce trades stopped out regardless of confidence (0.78-0.98) -
// confidence tracked zero correlation with outcome, consistent with the
// model having no real signal to be confident about. Today's 3 stopped-out
// entries fired with price still $2-2.50 ABOVE PDL, then just kept
// drifting down through the wide proximity band into the stop - the level
// was never actually tested at all.
const testedAndReclaimed = (candles: Candle[], level: number | null, currentPrice: number, side: 'low' | 'high'): boolean => {
  if (level === null) return false
  const recent = candles.slice(-TOUCH_LOOKBACK_BARS)
  const tested = recent.some(c => side === 'low'
    ? c.low <= level * (1 + TOUCH_TOLERANCE)
    : c.high >= level * (1 - TOUCH_TOLERANCE))
  if (!tested) return false
  return side === 'low' ? currentPrice > level * (1 + RECLAIM_MARGIN) : currentPrice < level * (1 - RECLAIM_MARGIN)
}

// Early momentum signal: MACD curl + price sitting at a support/resistance level,
// with no RSI divergence required (that's what makes it "earlier" than TTTF/DTTF/STTF).
// Requires 2+ indices sharing the same MACD curl direction.
//
// `candles` is the representative symbol's session-so-far candles (same data
// already passed to detectORBBreakout/detectCandlestickPattern by both
// callers) - used only by pdl_bounce/pdh_rejection's touch-and-reclaim
// check. or_rejection and gap_fill_target keep the original proximity-only
// check: they're a different thesis (retesting today's own opening range,
// or reaching a gap-fill target) with no real-trade history yet to suggest
// the same fix is needed there.
export const detectIVSignal = (
  direction: 'bullish' | 'bearish',
  currentPrice: number,
  levels: SupportResistanceLevels,
  indicesTriggered: string[],
  candles: Candle[],
  tolerance: number = DEFAULT_TOLERANCE
): IVSignalResult | null => {
  if (indicesTriggered.length < 2) return null

  let confluenceType: ConfluenceType | null = null
  let confluenceLevel: number | null = null
  let confidence = 0

  if (direction === 'bullish') {
    if (testedAndReclaimed(candles, levels.pdl, currentPrice, 'low')) {
      confluenceType = 'pdl_bounce'
      confluenceLevel = levels.pdl
      confidence = 0.85 // Strong: confirmed bounce off PDL with bullish MACD
    } else if (isNear(currentPrice, levels.orl, tolerance)) {
      confluenceType = 'or_rejection'
      confluenceLevel = levels.orl
      confidence = 0.7 // Moderate: MACD curling up at OR low
    } else if (levels.gapDown && isNear(currentPrice, levels.pdc, tolerance)) {
      confluenceType = 'gap_fill_target'
      confluenceLevel = levels.pdc
      confidence = 0.65 // Weaker: gap fill candidate
    }
  } else {
    if (testedAndReclaimed(candles, levels.pdh, currentPrice, 'high')) {
      confluenceType = 'pdh_rejection'
      confluenceLevel = levels.pdh
      confidence = 0.85 // Strong: confirmed rejection from PDH with bearish MACD
    } else if (isNear(currentPrice, levels.orh, tolerance)) {
      confluenceType = 'or_rejection'
      confluenceLevel = levels.orh
      confidence = 0.7 // Moderate: MACD curling down at OR high
    } else if (levels.gapUp && isNear(currentPrice, levels.pdc, tolerance)) {
      confluenceType = 'gap_fill_target'
      confluenceLevel = levels.pdc
      confidence = 0.65 // Weaker: gap fill candidate
    }
  }

  if (!confluenceType || confluenceLevel === null) return null

  const indexScale = indicesTriggered.length === 3 ? 1.0 : indicesTriggered.length === 2 ? 0.9 : 0.7
  confidence *= indexScale

  return { confluenceType, confluenceLevel, confidence }
}

// Deliberately NOT detectIVSignal reused with indicesTriggered=[symbol] -
// that function hard-requires 2+ agreeing indices (indicesTriggered.length
// < 2 returns null) because SPY/QQQ/IWM's confluence thesis is that
// structural correlation across the trio is itself part of the signal.
// Individual stocks (Mag7 scanner, added 2026-07-20) don't share that
// correlation - AAPL and TSLA can easily move in opposite directions the
// same day - so porting the "N of M agree" requirement wouldn't mean the
// same thing here. This evaluates ONE symbol entirely on its own technical
// levels, with no cross-symbol corroboration to lean on - by design, that
// makes it a less-corroborated read than the SPY/QQQ/IWM version, so it's
// capped at the SAME confidence ceiling used for the weakest (single-index)
// tier there (0.7x scale) rather than assuming full 1.0x reliability just
// because the underlying level-touch logic is identical.
const SINGLE_SYMBOL_CONFIDENCE_SCALE = 0.7

export const detectSingleSymbolIVSignal = (
  direction: 'bullish' | 'bearish',
  currentPrice: number,
  levels: SupportResistanceLevels,
  candles: Candle[],
  tolerance: number = DEFAULT_TOLERANCE
): IVSignalResult | null => {
  let confluenceType: ConfluenceType | null = null
  let confluenceLevel: number | null = null
  let confidence = 0

  if (direction === 'bullish') {
    if (testedAndReclaimed(candles, levels.pdl, currentPrice, 'low')) {
      confluenceType = 'pdl_bounce'
      confluenceLevel = levels.pdl
      confidence = 0.85
    } else if (isNear(currentPrice, levels.orl, tolerance)) {
      confluenceType = 'or_rejection'
      confluenceLevel = levels.orl
      confidence = 0.7
    } else if (levels.gapDown && isNear(currentPrice, levels.pdc, tolerance)) {
      confluenceType = 'gap_fill_target'
      confluenceLevel = levels.pdc
      confidence = 0.65
    }
  } else {
    if (testedAndReclaimed(candles, levels.pdh, currentPrice, 'high')) {
      confluenceType = 'pdh_rejection'
      confluenceLevel = levels.pdh
      confidence = 0.85
    } else if (isNear(currentPrice, levels.orh, tolerance)) {
      confluenceType = 'or_rejection'
      confluenceLevel = levels.orh
      confidence = 0.7
    } else if (levels.gapUp && isNear(currentPrice, levels.pdc, tolerance)) {
      confluenceType = 'gap_fill_target'
      confluenceLevel = levels.pdc
      confidence = 0.65
    }
  }

  if (!confluenceType || confluenceLevel === null) return null

  confidence *= SINGLE_SYMBOL_CONFIDENCE_SCALE

  return { confluenceType, confluenceLevel, confidence }
}
