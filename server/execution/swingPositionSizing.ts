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
// 35% -> 50% (user-specified, 2026-08-26) - explicitly wider than the
// backtested 35% (scripts/swingBacktestRun.ts's CALL-side edge was
// measured against 35%, not this number) - user's own live-trading
// judgment that a swing hold should tolerate more drawdown before being
// cut than the backtest assumed. Worth re-running the backtest against
// 50% if this ever needs re-validating, since the edge was measured at a
// different number.
export const STOP_LOSS_PCT = 0.50

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
// so "how many did we open today" isn't the right cap. User-specified cap
// (2026-08-25), not derived from backtest data - a diversification/
// capital-concentration ceiling for a smaller, newer capital pool.
export const MAX_CONCURRENT_SWING_POSITIONS = 3

// Swing contracts have no MIN=2 floor the way 0DTE does - that floor exists
// specifically because the 0DTE tier-ladder strategy needs at least 2
// contracts to scale out of at all. With no tier ladder here, 1 contract is
// a completely valid, normal position size, not a degraded fallback.
const MIN_CONTRACTS = 1

// Replaces the original riskPct-of-buying-power sizing (2026-08-26, user-
// specified): a flat dollar cap per position instead of a percentage of
// account buying power - simpler and more predictable for a fresh, smaller
// capital pool than a percentage that moves with equity. User's own
// example: a $0.94 premium contract (=$94/contract) should size to "about
// 5" under this cap - the exact floor-division math below actually gives 6
// ($564, still under $600; 7 would be $658, over) - worth knowing this
// constant produces 6 in that exact scenario, one more than the illustrative
// example, in case that matters to you.
export const MAX_POSITION_DOLLARS = 600

export type SwingContractSizeRejectReason =
  | 'invalid_premium'
  | 'insufficient_buying_power'
  | 'max_concurrent_positions_reached'

export interface SwingContractSizeInput {
  buyingPower: number
  premiumAsk: number
  currentOpenPositions: number
}

export type SwingContractSizeResult =
  | { ok: true; contracts: number }
  | { ok: false; reason: SwingContractSizeRejectReason }

export const computeSwingContractCount = (input: SwingContractSizeInput): SwingContractSizeResult => {
  const { buyingPower, premiumAsk, currentOpenPositions } = input

  if (currentOpenPositions >= MAX_CONCURRENT_SWING_POSITIONS) {
    return { ok: false, reason: 'max_concurrent_positions_reached' }
  }
  if (!Number.isFinite(premiumAsk) || premiumAsk <= 0) {
    return { ok: false, reason: 'invalid_premium' }
  }

  const costPerContract = premiumAsk * 100
  const desired = Math.floor(MAX_POSITION_DOLLARS / costPerContract)
  const affordable = Math.floor((buyingPower * 0.95) / costPerContract)
  const contracts = Math.min(Math.max(MIN_CONTRACTS, desired), affordable)

  if (contracts < MIN_CONTRACTS) {
    return { ok: false, reason: 'insufficient_buying_power' }
  }

  return { ok: true, contracts }
}
