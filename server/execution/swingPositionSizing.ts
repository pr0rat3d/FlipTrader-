// First-draft exit-rule spec for swing execution (2026-08-25) - NOT live,
// NOT yet backtested. Written the same way the original 0DTE bot's spec was
// (server/execution/optionPositionSizing.ts) - explicit numbered constants,
// reasoned up front, meant to be validated against real data before a
// single dollar (even paper) touches it. Every number here is a starting
// point for the backtest to confirm or correct, not a locked-in decision -
// same treatment every other signal/strategy idea in this project has
// gotten (see project memory: EMAB/PBC/REM/CCI all started as a proposed
// spec, then got backtested before a shipping decision was made).
//
// Why this can't just reuse optionPositionSizing.ts's numbers: that spec is
// built entirely around SAME-DAY expiration pressure (tier ladder timed to
// bank profit before 3:45pm, hard stop tuned for 0DTE's fast/tight premium
// moves). A multi-week swing hold has none of that pressure and a very
// different premium-noise profile - reusing 0DTE numbers here would be
// exactly the kind of "felt right, never tested" mistake this project has
// already burned itself on more than once (see the 2026-07-20 ORB section
// and 2026-08-20 OTM-strike section in project memory).

// No tier ladder - swing position sizes land small (1-3 contracts, given
// multi-week premiums cost real time value, not 0DTE's few-dollar
// premiums), too small to meaningfully scale out of the way day-trading's
// 2-5 contract sizing does. Single full-exit target/stop instead. Revisit
// tiering only if real capital/results ever justify sizing above ~3
// contracts routinely.
export const PROFIT_TARGET_PCT = 0.30
// Wider than the 0DTE bot's 25% hard stop, deliberately - a multi-day hold
// sees much more day-to-day premium noise without the thesis actually being
// invalidated (a single volatile session can move a multi-week option's
// premium 15-20% on IV alone, not just directional movement). A stop this
// tight on a swing hold would mostly be exiting on noise, not a real signal
// the trade is wrong - needs real backtest data to confirm/correct this
// number, this is a reasoned guess, not a measured one yet.
export const STOP_LOSS_PCT = 0.35

// Close out regardless of target/stop once this few TRADING days remain
// before the contract's own expiration, to get out ahead of the theta/
// gamma cliff near expiry rather than let a still-open swing position ride
// into 0DTE-like risk it was never sized or monitored for. Chosen as
// roughly "still enough real time value left to exit at a reasonable
// price," not tested yet.
export const DAYS_TO_EXPIRY_FORCE_CLOSE = 3

// Analogous to the 0DTE bot's max_daily_entries, but scoped to CONCURRENT
// open positions instead of a daily count - swing entries aren't a
// daily-reset activity (a position can still be open days after it opened),
// so "how many did we open today" isn't the right cap. This is instead a
// simple diversification/capital-concentration ceiling for a smaller, newer
// capital pool - not derived from any real data yet.
export const MAX_CONCURRENT_SWING_POSITIONS = 4

// Swing contracts have no MIN=2 floor the way 0DTE does - that floor exists
// specifically because the 0DTE tier-ladder strategy needs at least 2
// contracts to scale out of at all. With no tier ladder here, 1 contract is
// a completely valid, normal position size, not a degraded fallback.
const MIN_CONTRACTS = 1
const MAX_CONTRACTS = 3

// Same riskPct-of-buying-power shape as computeContractCount in
// optionPositionSizing.ts (that file's own comment explains why
// equity-based sizing produced a budget too small to ever matter) - kept
// deliberately separate rather than importing/sharing that function, since
// this account's buying power, contract-count bounds, and premium scale are
// all genuinely different numbers, not just a parameter swap.
export const SWING_RISK_PCT = 0.15

export type SwingContractSizeRejectReason =
  | 'invalid_premium'
  | 'insufficient_buying_power'
  | 'max_concurrent_positions_reached'

export interface SwingContractSizeInput {
  buyingPower: number
  riskPct: number
  premiumAsk: number
  currentOpenPositions: number
}

export type SwingContractSizeResult =
  | { ok: true; contracts: number }
  | { ok: false; reason: SwingContractSizeRejectReason }

export const computeSwingContractCount = (input: SwingContractSizeInput): SwingContractSizeResult => {
  const { buyingPower, riskPct, premiumAsk, currentOpenPositions } = input

  if (currentOpenPositions >= MAX_CONCURRENT_SWING_POSITIONS) {
    return { ok: false, reason: 'max_concurrent_positions_reached' }
  }
  if (!Number.isFinite(premiumAsk) || premiumAsk <= 0) {
    return { ok: false, reason: 'invalid_premium' }
  }

  const costPerContract = premiumAsk * 100
  const riskBudget = buyingPower * riskPct
  const desired = Math.floor(riskBudget / costPerContract)
  const clamped = Math.min(MAX_CONTRACTS, Math.max(MIN_CONTRACTS, desired))

  const affordable = Math.floor((buyingPower * 0.95) / costPerContract)
  const contracts = Math.min(clamped, affordable)

  if (contracts < MIN_CONTRACTS) {
    return { ok: false, reason: 'insufficient_buying_power' }
  }

  return { ok: true, contracts }
}
