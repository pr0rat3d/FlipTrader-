import { blackScholesPrice, realizedVolatility, RISK_FREE_RATE, ZERO_DTE_IV_MARKUP, OptionType } from './blackScholes.js'
import { suggestOptionStrike } from '../../src/lib/optionSuggestion.js'
import {
  tierPlanFor, computeContractCount, ContractSizeSettings,
  RUNNER_TARGET_PCT, RUNNER_TIME_LOCK_MIN_PCT, RUNNER_TIME_LOCK_HOUR_ET, RUNNER_TIME_LOCK_MINUTE_ET,
  FORCE_CLOSE_HOUR_ET, FORCE_CLOSE_MINUTE_ET, HARD_STOP_PCT_DEFAULT, BREAKEVEN_PROTECTION_STOP_PCT
} from '../execution/optionPositionSizing.js'
import { nyMinutesSinceMidnight } from '../rvol.js'

const MARKET_CLOSE_MINUTES_ET = 16 * 60

export interface SimulatedFill {
  atIso: string
  premium: number
  contractsSold: number
  reason: 'tier' | 'hard_stop' | 'runner_target' | 'runner_time_lock' | 'force_close' | 'end_of_data'
}

export interface OptionPnlResult {
  contractType: OptionType
  strike: number
  contracts: number
  entryPremium: number
  fills: SimulatedFill[]
  realizedPnl: number
}

export type OptionPnlOutcome = OptionPnlResult | { skipped: true; reason: string }

export interface PathPoint {
  timestamp: string
  close: number
}

export interface SizingInputs {
  equity: number
  buyingPower: number
  riskPct: number
  minEquity: number
  maxEquity: number
}

// Simulates the REAL tiered exit logic (optionPositionSizing.ts, unchanged
// from what's live) against a Black-Scholes-modeled premium path instead of
// a real quote feed. `forwardPath` must start at the entry bar (index 0,
// used for the entry premium/sizing) and run through the rest of the
// session - the simulator doesn't fetch anything itself, it's a pure
// function of whatever price path it's given, same "no lookahead" contract
// the rest of the backtest already follows (the caller is responsible for
// not handing it data from beyond the point being evaluated).
export const simulateOptionPnl = (
  direction: 'bullish' | 'bearish',
  targetUnderlyingPrice: number,
  forwardPath: PathPoint[],
  volAtEntry: number,
  sizing: SizingInputs
): OptionPnlOutcome => {
  if (forwardPath.length < 2) return { skipped: true, reason: 'insufficient forward path' }

  const entry = forwardPath[0]
  const entryPrice = entry.close
  const suggestion = suggestOptionStrike(direction, entryPrice, targetUnderlyingPrice)
  const contractType: OptionType = direction === 'bullish' ? 'call' : 'put'
  const strike = suggestion.entryStrike

  const sigma = Math.max(volAtEntry, 0.01) * ZERO_DTE_IV_MARKUP

  const minutesToCloseAt = (iso: string) => Math.max(0, MARKET_CLOSE_MINUTES_ET - nyMinutesSinceMidnight(new Date(iso)))
  const timeToExpiryYears = (iso: string) => minutesToCloseAt(iso) / (60 * 24 * 365)

  const entryPremium = blackScholesPrice(entryPrice, strike, timeToExpiryYears(entry.timestamp), RISK_FREE_RATE, sigma, contractType)

  const sizeSettings: ContractSizeSettings = { minAccountEquity: sizing.minEquity, maxAccountEquity: sizing.maxEquity }
  const sizeResult = computeContractCount(
    { accountEquity: sizing.equity, buyingPower: sizing.buyingPower, riskPct: sizing.riskPct, premiumAsk: entryPremium },
    sizeSettings
  )
  if (!sizeResult.ok) return { skipped: true, reason: sizeResult.reason }

  const contracts = sizeResult.contracts
  const tiers = tierPlanFor(contracts)
  const unfilledFixed = tiers.filter(t => !t.isRunner)
  const runner = tiers.find(t => t.isRunner)

  let remaining = contracts
  let stopPct = HARD_STOP_PCT_DEFAULT
  let filledTierCount = 0
  const fills: SimulatedFill[] = []

  for (let i = 1; i < forwardPath.length && remaining > 0; i++) {
    const point = forwardPath[i]
    const minutesNow = nyMinutesSinceMidnight(new Date(point.timestamp))
    const pastForceClose = minutesNow >= FORCE_CLOSE_HOUR_ET * 60 + FORCE_CLOSE_MINUTE_ET
    const pastTimeLock = minutesNow >= RUNNER_TIME_LOCK_HOUR_ET * 60 + RUNNER_TIME_LOCK_MINUTE_ET

    const premium = blackScholesPrice(point.close, strike, timeToExpiryYears(point.timestamp), RISK_FREE_RATE, sigma, contractType)

    if (pastForceClose) {
      fills.push({ atIso: point.timestamp, premium, contractsSold: remaining, reason: 'force_close' })
      remaining = 0
      break
    }

    const adverseMove = (entryPremium - premium) / entryPremium
    if (adverseMove >= stopPct) {
      fills.push({ atIso: point.timestamp, premium, contractsSold: remaining, reason: 'hard_stop' })
      remaining = 0
      break
    }

    const currentPct = (premium - entryPremium) / entryPremium
    let tierFilledThisBar = false

    for (const tier of unfilledFixed.slice(filledTierCount)) {
      if (currentPct < tier.targetPct) break
      if (runner && remaining <= 1) break

      fills.push({ atIso: point.timestamp, premium, contractsSold: 1, reason: 'tier' })
      remaining -= 1
      filledTierCount++
      tierFilledThisBar = true
    }

    if (runner && remaining >= 1 && filledTierCount >= unfilledFixed.length) {
      const hitTarget = currentPct >= runner.targetPct
      const timeLockEligible = pastTimeLock && currentPct >= RUNNER_TIME_LOCK_MIN_PCT
      if (hitTarget || timeLockEligible) {
        fills.push({ atIso: point.timestamp, premium, contractsSold: remaining, reason: hitTarget ? 'runner_target' : 'runner_time_lock' })
        remaining = 0
        break
      }
    }

    if (tierFilledThisBar) stopPct = BREAKEVEN_PROTECTION_STOP_PCT
  }

  if (remaining > 0) {
    // Ran out of forward path data without resolving (e.g. entry very late
    // in the session) - close it out at the last known modeled premium
    // rather than leave it dangling, same spirit as a real "still open at
    // backtest end" leg.
    const last = forwardPath[forwardPath.length - 1]
    const premium = blackScholesPrice(last.close, strike, timeToExpiryYears(last.timestamp), RISK_FREE_RATE, sigma, contractType)
    fills.push({ atIso: last.timestamp, premium, contractsSold: remaining, reason: 'end_of_data' })
  }

  const realizedPnl = fills.reduce((sum, f) => sum + (f.premium - entryPremium) * 100 * f.contractsSold, 0)

  return { contractType, strike, contracts, entryPremium, fills, realizedPnl }
}

export const volatilityAt = (closes: number[]): number => realizedVolatility(closes)
