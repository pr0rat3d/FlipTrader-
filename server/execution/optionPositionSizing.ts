// Contract count drives which scale-out tier plan applies (not a fixed
// 30/30/30/10 split like the old shares model) - each count from 2-5 has its
// own explicit ladder, matched to how far the runner needs to be able to run.
//
// 2 contracts is the one exception with no runner at all: too small a
// position to dedicate a whole contract to an open-ended +100% ride. Both
// contracts fully exit by +30% at the latest - tier 1 at +15%, tier 2 at
// +30% - with contract 2 protected at breakeven the moment tier 1 fires
// (the existing stop_pct-ratchet-to-0-on-any-tier-fill behavior in
// monitor-executions.ts already covers this, no separate mechanism needed).
const TIER_PLANS: Record<number, { pcts: number[]; hasRunner: boolean }> = {
  2: { pcts: [0.15, 0.30], hasRunner: false },
  3: { pcts: [0.10, 0.20], hasRunner: true },
  4: { pcts: [0.10, 0.20, 0.30], hasRunner: true },
  5: { pcts: [0.10, 0.20, 0.30, 0.50], hasRunner: true }
}

export const RUNNER_TIER_NUMBER = 99
export const RUNNER_TARGET_PCT = 1.00

// Mirrors execution_settings.hard_stop_pct's current live value (2026-07-16) -
// the DB row is the actual source of truth for live trading, this constant
// exists so the backtest (which has no DB row to read) can size/simulate
// against the same number without it drifting out of sync if someone forgets
// to update one when tuning the other.
export const HARD_STOP_PCT_DEFAULT = 0.25

// Protects entry+5%, not exact breakeven, once a tier fills - found live
// 2026-07-15: QQQ 715C's stop_pct=0 (exact breakeven) trigger didn't fire
// until price had ALREADY drifted 5.1% past it between polls, landing the
// fill below entry instead of at it. A negative value here means "sell once
// price falls to entry * (1 + |value|)" - same adverseMove >= stopPct
// comparison the hard stop uses, just with a threshold ahead of breakeven
// instead of at it, to absorb that ~5% of poll-interval drift without
// giving back into a loss. Shared by monitor-executions.ts (live) and the
// backtest P&L simulator, so both use the exact same ratchet target.
export const BREAKEVEN_PROTECTION_STOP_PCT = -0.05

// IV is a reversal-at-a-level signal, and the first half hour of the session
// is exactly when levels get tested and violated repeatedly as the opening
// auction resolves - noisier, less reliable reversals than later in the day.
// ORB doesn't need an equivalent gate: its own 15-min opening-range window is
// already a natural "wait" built into the signal itself, and a breakout
// confirmation right after that window closes is a legitimate, intended case,
// not noise to filter out.
export const MARKET_OPEN_MINUTES_ET = 9 * 60 + 30
export const IV_ELIGIBLE_AFTER_MINUTES = 30

// After 3:00pm ET, a runner that's made it to at least +50% gets sold at
// market rather than risked on reaching +100% before the 3:45 force-close -
// one that hasn't reached +50% yet is left alone (no forced action) to settle
// wherever it lands (between breakeven and +50%) in that last 45 minutes.
export const RUNNER_TIME_LOCK_HOUR_ET = 15
export const RUNNER_TIME_LOCK_MINUTE_ET = 0
export const RUNNER_TIME_LOCK_MIN_PCT = 0.50
export const FORCE_CLOSE_HOUR_ET = 15
export const FORCE_CLOSE_MINUTE_ET = 45

const MIN_CONTRACTS = 2
const MAX_CONTRACTS = 5

export interface TierSpec {
  tierNumber: number
  isRunner: boolean
  targetPct: number
}

// The fixed-pct tiers for this contract count, plus the runner as the final
// entry if this plan has one - e.g. 3 contracts -> [{1, 10%}, {2, 20%},
// {runner, 100%}]; 2 contracts -> [{1, 15%}, {2, 30%}], no runner.
export const tierPlanFor = (contracts: number): TierSpec[] => {
  const plan = TIER_PLANS[contracts]
  if (!plan) return []
  const fixed = plan.pcts.map((targetPct, i) => ({ tierNumber: i + 1, isRunner: false, targetPct }))
  return plan.hasRunner ? [...fixed, { tierNumber: RUNNER_TIER_NUMBER, isRunner: true, targetPct: RUNNER_TARGET_PCT }] : fixed
}

export type ContractSizeRejectReason =
  | 'invalid_premium'
  | 'equity_out_of_band'
  | 'insufficient_buying_power'

export interface ContractSizeInput {
  accountEquity: number
  buyingPower: number
  riskPct: number
  premiumAsk: number
}

export interface ContractSizeSettings {
  minAccountEquity: number
  maxAccountEquity: number
}

export type ContractSizeResult =
  | { ok: true; contracts: number }
  | { ok: false; reason: ContractSizeRejectReason }

// Budget is riskPct of BUYING POWER, not equity - found live 2026-07-15 that
// equity*riskPct (1%) produced a budget ($20 on a $2000 account) smaller than
// almost any real option's cost (premium x 100), so `desired` was always ~0
// and every single entry was just hitting the MIN_CONTRACTS floor - the
// "risk-based" sizing was never actually driving anything. riskPct is meant
// to be reconfigured to something like 0.10 (10% of buying power) to match:
// e.g. $4,000 BP -> $400 budget -> as many contracts as fit under $400,
// capped at 5. "At least 2" is a hard floor from the tiering strategy itself
// (you can't scale out of 1 contract), not a risk-derived number, so a cheap
// premium that would risk-size to 0-1 contracts still gets bumped up to 2 as
// long as it's affordable; an expensive premium that would risk-size above 5
// gets capped down rather than taking on a bigger bet than intended.
export const computeContractCount = (input: ContractSizeInput, settings: ContractSizeSettings): ContractSizeResult => {
  const { accountEquity, buyingPower, riskPct, premiumAsk } = input

  if (!Number.isFinite(premiumAsk) || premiumAsk <= 0) {
    return { ok: false, reason: 'invalid_premium' }
  }
  if (!Number.isFinite(accountEquity) || accountEquity < settings.minAccountEquity || accountEquity > settings.maxAccountEquity) {
    return { ok: false, reason: 'equity_out_of_band' }
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
