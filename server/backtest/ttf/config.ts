// TTF (Triple Time Frame reversal) backtest config - 2026-10-27. Backtest-
// only; nothing under server/backtest/ttf is imported by live code.
//
// Spec decisions made with the user (not in the original spec):
//  - RSI/MACD/EMA50/ATR are computed on Heikin Ashi closes (per spec), but
//    swing points, trendlines, line touches, the EMA50 touch, stops and every
//    fill use REAL 1m OHLC - HA prices aren't tradeable.
//  - Phase 2 prices both 1- and 2-strike-OTM 0DTE contracts from real
//    Alpaca option trade bars, entering/exiting at the next 1m option bar's
//    open after the triggering underlying bar, minus a per-side haircut
//    (no bid/ask in the historical data, so the spread is a guess).
//
// Choices the spec left open, each a flag so it can be flipped (reported
// in the summary, never silent):
//  - macdFlatEps: "flat" = MACD slope within +-eps; default 0 (slope >= 0
//    counts as flat/positive for the bullish curl).
//  - macdExitBeforeTarget: the spec's MACD-flip exit is listed under
//    "Remainder", so by default it only applies after the half-off at
//    EMA50. true = it also exits the full position before that.
//  - Variant A has no trendline, so its only stop is the % stop.
//  - divergenceFilter (index-divergence skip) defaults ON.
//  - requireRejection (2026-10-27, NOT in the spec - opt-in): a B/C line
//    touch only counts if that same bar closes back on the reversal side of
//    the line in the trade's direction (bullish: green candle closing above
//    the line; bearish: red candle closing below it). Added after the 12-mo
//    run showed C's losers were price GRINDING along the line, not rejecting.
export interface TtfConfig {
  rsiPeriod: number
  rsiOversold: number
  rsiOverbought: number
  ttfActiveBars: number
  pivotStrength: number
  touchTolAtr: number
  minAnchorSpacing: number
  macdFlatEps: number
  macdExitBeforeTarget: boolean
  divergenceFilter: boolean
  requireRejection: boolean
  stopPct: number
  maxAttemptsPerSymbolDay: number
  lastEntryMinutes: number // ET minutes-since-midnight; no new entries at/after
  forceExitMinutes: number
  contractsPerTrade: number
  optionHaircuts: number[] // $/share per side
  optionMaxEntryDelayMin: number
}

export const DEFAULT_TTF_CONFIG: TtfConfig = {
  rsiPeriod: 14,
  rsiOversold: 30,
  rsiOverbought: 70,
  ttfActiveBars: 15,
  pivotStrength: 3,
  touchTolAtr: 0.15,
  minAnchorSpacing: 10,
  macdFlatEps: 0,
  macdExitBeforeTarget: false,
  divergenceFilter: true,
  requireRejection: false,
  stopPct: 0.0025,
  maxAttemptsPerSymbolDay: 3,
  lastEntryMinutes: 15 * 60 + 30,
  forceExitMinutes: 15 * 60 + 55,
  contractsPerTrade: 2,
  optionHaircuts: [0, 0.02],
  optionMaxEntryDelayMin: 3
}

export type Variant = 'A' | 'B' | 'C'
export const VARIANTS: Variant[] = ['A', 'B', 'C']
export const START_TIMES = [10 * 60, 10 * 60 + 30]
export const SYMBOLS = ['SPY', 'QQQ', 'IWM'] as const
export type Direction = 'bullish' | 'bearish'
