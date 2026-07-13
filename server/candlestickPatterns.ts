import {
  morningstar, eveningstar, threewhitesoldiers, threeblackcrows,
  bullishengulfingpattern, bearishengulfingpattern,
  piercingline, darkcloudcover,
  bullishharami, bearishharami,
  hammerpattern, shootingstar
} from 'technicalindicators'

export type CandlestickDirection = 'bullish' | 'bearish' | 'neutral'

export interface CandlestickMatch {
  pattern: string
  direction: CandlestickDirection
}

interface OHLCInput {
  open: number[]
  high: number[]
  low: number[]
  close: number[]
}

interface Detector {
  pattern: string
  direction: CandlestickDirection
  fn: (data: OHLCInput) => boolean
}

// Checked in priority order - stronger, more specific reversal patterns first, so a
// textbook morning star is reported as that rather than being masked by a weaker
// match (each detector call is independent - order only affects which single match
// wins when more than one happens to be true for the same bars).
//
// Doji is deliberately excluded: the library's open==close tolerance is 0.1% of
// price, which on a $700+ stock is inside a ~$0.75 band - trivially satisfied by
// countless ordinary quiet 5-min bars, not a meaningful signal. It also resolves to
// a 'neutral' direction that applyConfidenceModifiers already ignores, so it was
// pure display noise with no effect on confidence - removing it rather than just
// hiding it in one view, since the same noise would show in the data table too.
const DETECTORS: Detector[] = [
  { pattern: 'Morning Star', direction: 'bullish', fn: morningstar },
  { pattern: 'Evening Star', direction: 'bearish', fn: eveningstar },
  { pattern: 'Three White Soldiers', direction: 'bullish', fn: threewhitesoldiers },
  { pattern: 'Three Black Crows', direction: 'bearish', fn: threeblackcrows },
  { pattern: 'Bullish Engulfing', direction: 'bullish', fn: bullishengulfingpattern },
  { pattern: 'Bearish Engulfing', direction: 'bearish', fn: bearishengulfingpattern },
  { pattern: 'Piercing Line', direction: 'bullish', fn: piercingline },
  { pattern: 'Dark Cloud Cover', direction: 'bearish', fn: darkcloudcover },
  { pattern: 'Bullish Harami', direction: 'bullish', fn: bullishharami },
  { pattern: 'Bearish Harami', direction: 'bearish', fn: bearishharami },
  { pattern: 'Hammer', direction: 'bullish', fn: hammerpattern },
  { pattern: 'Shooting Star', direction: 'bearish', fn: shootingstar }
]

// Each detector internally looks only at the last N bars it needs (2-3, depending
// on the pattern) regardless of how much history is passed in - safe to pass the
// full candle history straight through.
export const detectCandlestickPattern = (
  candles: Array<{ open: number; high: number; low: number; close: number }>
): CandlestickMatch | null => {
  const input: OHLCInput = {
    open: candles.map(c => c.open),
    high: candles.map(c => c.high),
    low: candles.map(c => c.low),
    close: candles.map(c => c.close)
  }

  for (const detector of DETECTORS) {
    try {
      if (detector.fn(input)) return { pattern: detector.pattern, direction: detector.direction }
    } catch {
      // Some detectors are strict about input shape on very short series - skip.
    }
  }
  return null
}
