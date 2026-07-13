// Pure, unit-testable position sizing - returns a valid plan or a typed
// rejection reason, never a qty that gets used regardless of whether the
// inputs made sense. Two reason "classes" matter to the caller:
//   - quiet-skip reasons -> status skipped_bad_data/skipped_stale-style, no
//     alert - either bad upstream data, or a legitimate, expected outcome
//     (e.g. a small account can't afford this leg's share price) that will
//     recur often and isn't worth a human's attention each time.
//   - flag reasons -> skip AND set needs_manual_review (account state is
//     suspicious enough - not just "small" - to want a human look)
export type OrderPlanRejectReason =
  | 'invalid_prices'
  | 'direction_mismatch'
  | 'risk_too_small'
  | 'equity_out_of_band'
  | 'qty_zero'
  | 'qty_too_large'
  | 'insufficient_buying_power'

const QUIET_SKIP_REASONS = new Set<OrderPlanRejectReason>([
  'invalid_prices', 'direction_mismatch', 'risk_too_small', 'qty_zero', 'insufficient_buying_power'
])

export const isQuietSkipReason = (reason: OrderPlanRejectReason): boolean => QUIET_SKIP_REASONS.has(reason)

export interface OrderPlanInput {
  direction: 'bullish' | 'bearish'
  entryPrice: number
  stopLossPrice: number | null
  milestone10Price: number | null
  milestone20Price: number | null
  milestone30Price: number | null
  accountEquity: number
  buyingPower: number
}

export interface OrderPlanSettings {
  riskPct: number
  minQty: number
  maxQty: number
  minAccountEquity: number
  maxAccountEquity: number
}

export interface OrderPlan {
  ok: true
  qty: number
  entryPrice: number
  stopLossPrice: number
  tierPrices: { tier1: number; tier2: number; tier3: number }
  notional: number
  accountEquity: number
}

export type OrderPlanResult = OrderPlan | { ok: false; reason: OrderPlanRejectReason }

// A risk-per-share below this floor (whichever is larger: an absolute cent
// amount, or a fraction of entry price) would blow up the risk-based qty
// division into an unreasonably large size off what's likely bad ATR/stop data.
const MIN_RISK_ABSOLUTE = 0.02
const MIN_RISK_PCT_OF_PRICE = 0.001

// Leaves headroom against a slightly worse market-order fill and existing
// open positions eating into buying power between the check and the order.
const BUYING_POWER_SAFETY_MARGIN = 0.95

export interface ScaleOutAllocation {
  tier1: number
  tier2: number
  tier3: number
  runner: number
}

// Splits a small integer qty (2-10) into 30/30/30/10 scale-out tiers. At this
// size, an exact 30/30/30/10 split often isn't representable in whole shares
// (e.g. qty=2 -> floor(2*0.3)=0 for every tier) - tiers that would round to 0
// are simply not placed, and their share folds into the runner. This means a
// small position can end up as "runner only, no scale-out tiers" - a real
// consequence of trading size this small, not a bug.
export const allocateScaleOutQty = (qty: number): ScaleOutAllocation => {
  const tier1 = Math.floor(qty * 0.3)
  const tier2 = Math.floor(qty * 0.3)
  const tier3 = Math.floor(qty * 0.3)
  const runner = qty - tier1 - tier2 - tier3
  return { tier1, tier2, tier3, runner }
}

export const computeOrderPlan = (input: OrderPlanInput, settings: OrderPlanSettings): OrderPlanResult => {
  const { direction, entryPrice, stopLossPrice, milestone10Price, milestone20Price, milestone30Price, accountEquity, buyingPower } = input

  if (
    !Number.isFinite(entryPrice) || entryPrice <= 0 ||
    stopLossPrice === null || !Number.isFinite(stopLossPrice) || stopLossPrice <= 0 ||
    milestone10Price === null || milestone20Price === null || milestone30Price === null ||
    !Number.isFinite(milestone10Price) || !Number.isFinite(milestone20Price) || !Number.isFinite(milestone30Price)
  ) {
    return { ok: false, reason: 'invalid_prices' }
  }

  const isBullish = direction === 'bullish'
  if (isBullish ? stopLossPrice >= entryPrice : stopLossPrice <= entryPrice) {
    return { ok: false, reason: 'direction_mismatch' }
  }

  const riskPerShare = Math.abs(entryPrice - stopLossPrice)
  const minRisk = Math.max(MIN_RISK_ABSOLUTE, entryPrice * MIN_RISK_PCT_OF_PRICE)
  if (riskPerShare < minRisk) {
    return { ok: false, reason: 'risk_too_small' }
  }

  if (!Number.isFinite(accountEquity) || accountEquity < settings.minAccountEquity || accountEquity > settings.maxAccountEquity) {
    return { ok: false, reason: 'equity_out_of_band' }
  }

  const rawQty = Math.floor((accountEquity * settings.riskPct) / riskPerShare)
  if (rawQty < settings.minQty) {
    // Below the minimum tradeable size - quietly skip rather than bump the
    // qty up, which would silently take on more risk than the 1%-of-equity
    // target computed for this leg.
    return { ok: false, reason: 'qty_zero' }
  }
  if (rawQty > settings.maxQty) {
    // Do NOT clamp to max - that would silently mask a bad entry/stop input
    // and still place a real order sized off garbage. Skip and flag instead.
    return { ok: false, reason: 'qty_too_large' }
  }
  const qty = rawQty

  const notional = qty * entryPrice
  // Real constraint, not a garbage-data signal: risk-based sizing off equity
  // can compute a qty this small account genuinely can't afford at this
  // ticker's share price (e.g. SPY/QQQ at $500+/share against a ~$2k
  // account) - expected to happen often, so it's a quiet skip, not a flag.
  if (notional > buyingPower * BUYING_POWER_SAFETY_MARGIN) {
    return { ok: false, reason: 'insufficient_buying_power' }
  }

  return {
    ok: true,
    qty,
    entryPrice,
    stopLossPrice,
    tierPrices: { tier1: milestone10Price, tier2: milestone20Price, tier3: milestone30Price },
    notional,
    accountEquity
  }
}
