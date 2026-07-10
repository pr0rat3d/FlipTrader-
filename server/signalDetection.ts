import { SupportResistanceLevels } from './supportResistance.js'

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

// Early momentum signal: MACD curl + price sitting at a support/resistance level,
// with no RSI divergence required (that's what makes it "earlier" than TTF/DTF/STF).
// Requires 2+ indices sharing the same MACD curl direction.
export const detectIVSignal = (
  direction: 'bullish' | 'bearish',
  currentPrice: number,
  levels: SupportResistanceLevels,
  indicesTriggered: string[],
  tolerance: number = DEFAULT_TOLERANCE
): IVSignalResult | null => {
  if (indicesTriggered.length < 2) return null

  let confluenceType: ConfluenceType | null = null
  let confluenceLevel: number | null = null
  let confidence = 0

  if (direction === 'bullish') {
    if (isNear(currentPrice, levels.pdl, tolerance)) {
      confluenceType = 'pdl_bounce'
      confluenceLevel = levels.pdl
      confidence = 0.85 // Strong: bouncing off PDL with bullish MACD
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
    if (isNear(currentPrice, levels.pdh, tolerance)) {
      confluenceType = 'pdh_rejection'
      confluenceLevel = levels.pdh
      confidence = 0.85 // Strong: rejecting from PDH with bearish MACD
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
