import { blackScholesPrice, realizedVolatility, RISK_FREE_RATE, ZERO_DTE_IV_MARKUP, OptionType } from './blackScholes.js'
import { suggestOptionStrike } from '../../src/lib/optionSuggestion.js'
import {
  tierPlanFor, computeContractCount, ContractSizeSettings, TierSpec,
  RUNNER_TARGET_PCT, RUNNER_TIME_LOCK_MIN_PCT, RUNNER_TIME_LOCK_HOUR_ET, RUNNER_TIME_LOCK_MINUTE_ET,
  FORCE_CLOSE_HOUR_ET, FORCE_CLOSE_MINUTE_ET, HARD_STOP_PCT_DEFAULT, BREAKEVEN_PROTECTION_STOP_PCT
} from '../execution/optionPositionSizing.js'
import { nyMinutesSinceMidnight } from '../rvol.js'

// Incremental, bar-by-bar position model - mirrors monitor-executions.ts's
// actual per-poll structure (not a pre-resolve-the-whole-future function
// like the first Phase 2 draft) specifically so an entry-gating layer can
// interleave real portfolio state (shared capital, dedup, opposing-signal
// close-all) between bars, the same way live interleaves execute-alerts.ts
// and monitor-executions.ts as two separate crons touching the same DB
// rows. See blackScholes.ts's header for what this model can and can't
// tell you.

export interface SimPosition {
  id: number
  ttfStatus: string
  symbol: string
  direction: 'bullish' | 'bearish'
  contractType: OptionType
  strike: number
  contracts: number
  remaining: number
  entryPremium: number
  entryTimeIso: string
  sigma: number
  stopPct: number
  tiers: TierSpec[]
  filledTierCount: number
  fills: SimulatedFill[]
  status: 'open' | 'closed'
  closedAtIso: string | null
  realizedPnl: number
}

export interface SimulatedFill {
  atIso: string
  premium: number
  contractsSold: number
  reason: 'tier' | 'hard_stop' | 'runner_target' | 'runner_time_lock' | 'force_close' | 'opposing_close'
}

export type EntryPriceOutcome =
  | { ok: true; contractType: OptionType; strike: number; entryPremium: number; contracts: number; sigma: number }
  | { ok: false; reason: string }

// Entry-time pricing + sizing - same real functions live uses
// (suggestOptionStrike, computeContractCount), just fed a modeled premium
// instead of a real quote's ask.
export const priceEntry = (
  direction: 'bullish' | 'bearish',
  entryUnderlyingPrice: number,
  targetUnderlyingPrice: number,
  entryTimeIso: string,
  trailingCloses: number[],
  sizing: { equity: number; buyingPower: number; riskPct: number; minEquity: number; maxEquity: number }
): EntryPriceOutcome => {
  const suggestion = suggestOptionStrike(direction, entryUnderlyingPrice, targetUnderlyingPrice)
  const contractType: OptionType = direction === 'bullish' ? 'call' : 'put'
  const strike = suggestion.entryStrike

  const sigma = Math.max(realizedVolatility(trailingCloses), 0.01) * ZERO_DTE_IV_MARKUP
  const T = minutesToCloseAt(entryTimeIso) / (60 * 24 * 365)
  const entryPremium = blackScholesPrice(entryUnderlyingPrice, strike, T, RISK_FREE_RATE, sigma, contractType)

  const sizeSettings: ContractSizeSettings = { minAccountEquity: sizing.minEquity, maxAccountEquity: sizing.maxEquity }
  const sizeResult = computeContractCount(
    { accountEquity: sizing.equity, buyingPower: sizing.buyingPower, riskPct: sizing.riskPct, premiumAsk: entryPremium },
    sizeSettings
  )
  if (!sizeResult.ok) return { ok: false, reason: sizeResult.reason }

  return { ok: true, contractType, strike, entryPremium, contracts: sizeResult.contracts, sigma }
}

const MARKET_CLOSE_MINUTES_ET = 16 * 60
const minutesToCloseAt = (iso: string) => Math.max(0, MARKET_CLOSE_MINUTES_ET - nyMinutesSinceMidnight(new Date(iso)))

export const modeledPremiumAt = (position: Pick<SimPosition, 'strike' | 'contractType' | 'sigma'>, underlyingClose: number, timeIso: string): number => {
  const T = minutesToCloseAt(timeIso) / (60 * 24 * 365)
  return blackScholesPrice(underlyingClose, position.strike, T, RISK_FREE_RATE, position.sigma, position.contractType)
}

export const openPosition = (
  id: number, ttfStatus: string, symbol: string, direction: 'bullish' | 'bearish', entry: Extract<EntryPriceOutcome, { ok: true }>, entryTimeIso: string
): SimPosition => ({
  id, ttfStatus, symbol, direction,
  contractType: entry.contractType, strike: entry.strike, contracts: entry.contracts, remaining: entry.contracts,
  entryPremium: entry.entryPremium, entryTimeIso, sigma: entry.sigma, stopPct: HARD_STOP_PCT_DEFAULT,
  tiers: tierPlanFor(entry.contracts), filledTierCount: 0, fills: [], status: 'open', closedAtIso: null, realizedPnl: 0
})

// One bar's worth of position management - the exact same checks
// monitor-executions.ts runs per poll (force-close, hard stop, tier fills,
// runner target/time-lock), just against a modeled premium instead of a
// real quote. Mutates `position` in place and returns whether it closed
// this bar.
export const checkPositionAtBar = (position: SimPosition, underlyingClose: number, timeIso: string): boolean => {
  if (position.status !== 'open') return false

  const minutesNow = nyMinutesSinceMidnight(new Date(timeIso))
  const pastForceClose = minutesNow >= FORCE_CLOSE_HOUR_ET * 60 + FORCE_CLOSE_MINUTE_ET
  const pastTimeLock = minutesNow >= RUNNER_TIME_LOCK_HOUR_ET * 60 + RUNNER_TIME_LOCK_MINUTE_ET
  const premium = modeledPremiumAt(position, underlyingClose, timeIso)

  if (pastForceClose) {
    closeAll(position, premium, timeIso, 'force_close')
    return true
  }

  const adverseMove = (position.entryPremium - premium) / position.entryPremium
  if (adverseMove >= position.stopPct) {
    closeAll(position, premium, timeIso, 'hard_stop')
    return true
  }

  const currentPct = (premium - position.entryPremium) / position.entryPremium
  const unfilledFixed = position.tiers.filter(t => !t.isRunner)
  const runner = position.tiers.find(t => t.isRunner)
  let tierFilledThisBar = false

  for (const tier of unfilledFixed.slice(position.filledTierCount)) {
    if (currentPct < tier.targetPct) break
    if (runner && position.remaining <= 1) break

    position.fills.push({ atIso: timeIso, premium, contractsSold: 1, reason: 'tier' })
    position.remaining -= 1
    position.filledTierCount++
    tierFilledThisBar = true
  }

  if (runner && position.remaining >= 1 && position.filledTierCount >= unfilledFixed.length) {
    const hitTarget = currentPct >= runner.targetPct
    const timeLockEligible = pastTimeLock && currentPct >= RUNNER_TIME_LOCK_MIN_PCT
    if (hitTarget || timeLockEligible) {
      closeAll(position, premium, timeIso, hitTarget ? 'runner_target' : 'runner_time_lock')
      return true
    }
  }

  if (tierFilledThisBar) position.stopPct = BREAKEVEN_PROTECTION_STOP_PCT
  return false
}

// Forced closure independent of the position's own tier/stop/runner state -
// the opposing-signal close-all (a fresh signal in the other direction
// clears entry gates while this position is still open).
export const closeOpposing = (position: SimPosition, underlyingClose: number, timeIso: string): void => {
  const premium = modeledPremiumAt(position, underlyingClose, timeIso)
  closeAll(position, premium, timeIso, 'opposing_close')
}

const closeAll = (position: SimPosition, premium: number, timeIso: string, reason: SimulatedFill['reason']): void => {
  if (position.remaining > 0) {
    position.fills.push({ atIso: timeIso, premium, contractsSold: position.remaining, reason })
  }
  position.realizedPnl = position.fills.reduce((sum, f) => sum + (f.premium - position.entryPremium) * 100 * f.contractsSold, 0)
  position.remaining = 0
  position.status = 'closed'
  position.closedAtIso = timeIso
}

export const volatilityAt = (closes: number[]): number => realizedVolatility(closes)
