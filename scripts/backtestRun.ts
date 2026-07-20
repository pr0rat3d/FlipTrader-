// Signal-level backtest: replays historical SPY/QQQ/IWM 5-min bars through
// the EXACT same detection code the live bot uses (analyzeCandles,
// detectIVSignal, ORB, DIV, applyConfidenceModifiers), walking forward bar-
// by-bar so nothing sees future data, and scores each fired signal against
// the underlying's own target/stop the same way profit_targets already
// does live (applyPriceSample/checkExpiry, reused unchanged).
//
// Phase 1 (signal-level, `legs`) answers "does this entry/exit logic have a
// directional edge on the underlying" - ungated, every fired signal gets
// its own row regardless of whether the real bot would ever have traded it.
//
// Phase 2 (2026-07-16, `executedPositions`) replays the REAL entry gates
// from execute-alerts.ts (min_confidence, IV's 30-min gate, same-symbol
// dedup, the momentum-reset gate with ORB's high-confidence exemption, the
// opposing-signal close-all, the force-close cutoff) against a single
// shared, evolving simulated account - not independent per-signal capital.
// This is what answers "how many trades would the real gated system
// actually have taken, and what would it have made." Option premium P&L
// is a Black-Scholes MODEL, not real historical options data (unaffordable
// without the $99/mo Alpaca Algo Trader Plus plan - see
// server/backtest/blackScholes.ts's header). Read Phase 2 numbers as "does
// this look directionally profitable, and roughly how many trades," not
// "this is the exact dollar amount the bot would have made" - real
// execution/slippage/liquidity effects aren't captured by either phase.
//
// One live gate this backtest can't meaningfully replay: the 5-minute
// staleness cutoff on unclaimed profit_targets legs. That gate exists
// because live execution polls asynchronously, so a signal can sit
// unclaimed in a backlog for a while before something frees it up to
// execute. This backtest acts on every signal the instant it fires (no
// polling delay), so there's no backlog for a leg to go stale in - the
// gate has nothing to do here by construction, not because it was skipped.
//
// Deliberately evaluates EVERY 5-min bar, unlike live's scan-confluence.ts
// (which throttles to every 3rd minute outside prime time purely to stay
// under Twelve Data's credit budget - a data-cost compromise, not part of
// the strategy's actual logic). More signal density here means better
// statistics for the same historical window.
//
// Usage: npm run backtest -- --days 90
//        npm run backtest -- --start 2026-04-01 --end 2026-07-15

// NOTE: env vars (.env.local) must already be loaded into process.env
// BEFORE this module is imported - see scripts/backtest.ts, the thin
// bootstrap entry point. ES module imports are hoisted and execute before
// this file's own top-level code runs, so loading env vars here (after the
// imports below) would be too late for supabaseAdmin.ts's top-level
// credential check (imported transitively via server/supportResistance.ts).
import { mkdirSync, writeFileSync } from 'fs'
import { Candle } from '../server/twelvedata.js'
import { fetchIntradayHistory, fetchDailyHistory } from '../server/backtest/fetchHistory.js'
import { dailyLevelsAsOf, openingRangeFor, supportResistanceLevelsAsOf, sessionVWAPFor } from '../server/backtest/replayHelpers.js'
import { analyzeCandles } from '../server/indicators.js'
import { calculateATR, calculateMACD } from '../src/lib/technicalIndicators.js'
import { detectIVSignal } from '../server/signalDetection.js'
import { detectCandlestickPattern } from '../server/candlestickPatterns.js'
import { applyConfidenceModifiers } from '../server/confidenceModifiers.js'
import { detectORBBreakout, filterORBCandidates, isDailyTrendAligned, isIntradayVwapAligned, orbBaseConfidence, continuationTargetPrice } from '../server/orb.js'
import { deriveMilestonePrices, applyPriceSample, checkExpiry, ProfitTargetRow } from '../server/alertOutcomes.js'
import { nyDateKey } from '../server/marketHours.js'
import { openPosition, checkPositionAtBar, priceEntry, closeOpposing, SimPosition } from '../server/backtest/optionPnlSimulator.js'
import {
  MARKET_OPEN_MINUTES_ET, IV_ELIGIBLE_AFTER_MINUTES, FORCE_CLOSE_HOUR_ET, FORCE_CLOSE_MINUTE_ET, TierSpec,
  RUNNER_TIER_NUMBER, RUNNER_TARGET_PCT, RISK_PCT_MULTIPLIER_BY_TYPE, DEFAULT_RISK_PCT_MULTIPLIER
} from '../server/execution/optionPositionSizing.js'
import { nyMinutesSinceMidnight } from '../server/rvol.js'

const SYMBOLS = ['SPY', 'QQQ', 'IWM'] as const
type Symbol = typeof SYMBOLS[number]

const MACD_CURL_LOOKBACK_BARS = 30
const RSI_DIVERGENCE_LOOKBACK_BARS = 5
const HISTOGRAM_DECELERATION_BARS = 3
const ATR_STOP_MULTIPLIER = 1.5
const ROLLING_WINDOW_BARS = 300 // matches live's getIntradayCandles(symbol, 300) default
const VOL_WINDOW_BARS = 30 // trailing bars used for the realized-vol proxy at entry

// Entry-gate constants mirroring execute-alerts.ts's current live values
// (2026-07-16) - kept here rather than imported, since execute-alerts.ts is
// a Vercel API handler, not a library module meant to be imported from a
// script. Re-check these against execution_settings/execute-alerts.ts if
// they're ever retuned live, since nothing enforces they stay in sync.
const ORB_HIGH_CONFIDENCE_CONTINUATION_THRESHOLD = 0.85

// Per-type confidence floors mirroring execute-alerts.ts's
// MIN_CONFIDENCE_BY_TYPE (2026-07-16, revised after fixing the
// filterORBCandidates bug - see orb.ts). ORB lowest (best performer once
// actually working), TTF-family in the middle (its extra RSI-divergence
// requirement already filters better than IV's mechanism does), IV highest
// (worst performer at high volume in every variant run). DIV falls back to
// the global default - no backtest history to tune it by yet.
const GLOBAL_MIN_CONFIDENCE = 0.65
const MIN_CONFIDENCE_BY_TYPE: Record<string, number> = {
  ORB: 0.60,
  TTTF: 0.65,
  DTTF: 0.65,
  STTF: 0.65,
  IV: 0.80
}

// Single shared, evolving simulated account - NOT independent per-signal
// capital (that was the first Phase 2 draft's known gap). Every position
// draws from and returns capital to this same pool, the same way a real
// account's buying power actually works. Starting scale matches the live
// account's current rough size/settings (2026-07-16) so the sizing math
// uses real numbers, not arbitrary ones. MARGIN_MULTIPLIER mirrors the
// live account's ~2x margin configuration.
const SIM_STARTING_EQUITY = 2000
const MARGIN_MULTIPLIER = 2
const SIM_RISK_PCT = 0.10
// Was 500, mirroring the live execution_settings.min_account_equity value -
// found live 2026-07-17 the SAME catch-22 exists at the lower bound: the
// corrected (unlimited-ceiling) baseline still crossed below $500 on
// 2026-06-16 after a brutal losing stretch and went completely silent for
// the last month of the 90-day window, with no way to recover without a
// trade it could no longer place. A hard floor with no recovery path isn't
// a risk control, it's a dead end - the daily-loss circuit breaker (see
// dailyLossLimitPct below) is the intentional, recoverable version of this
// same protection. Dropped to a nominal $1 sanity check (rejects truly
// nonsensical/negative equity, not a real barrier in practice), matching
// the live value.
const SIM_MIN_EQUITY = 1
// Was 5000, mirroring the live execution_settings.max_account_equity value -
// found live 2026-07-17 that computeContractCount's upper-band check has no
// recovery mechanism: once equity crosses the ceiling, EVERY future entry
// gets rejected as 'equity_out_of_band' forever (equity can't come back down
// without trades, and trades can't happen without equity coming back down).
// Confirmed in a real 90-day backtest: the baseline run crossed $5000 on
// 2026-05-11 and went completely silent for the remaining ~2 months of the
// window - every "positive" backtest result up to this point was actually
// "made enough to hit the ceiling by some date, then sat idle," not a true
// 90-day read. Raised to effectively unlimited live and here, matching.
const SIM_MAX_EQUITY = 100_000_000

const stopLossFor = (direction: 'bullish' | 'bearish', entryPrice: number, atr: number | null): number | null => {
  if (atr === null) return null
  return direction === 'bullish' ? entryPrice - ATR_STOP_MULTIPLIER * atr : entryPrice + ATR_STOP_MULTIPLIER * atr
}

interface BacktestLeg extends ProfitTargetRow {
  id: number
  ttfStatus: string
  symbol: Symbol
  direction: 'bullish' | 'bearish'
  confidence: number
  entryTimeIso: string
  status: 'open' | 'target_hit' | 'stopped_out' | 'expired'
}

interface PerSymbolBar {
  symbol: Symbol
  rsiDivergence: string | null
  macdCurl: string | null
  histogramDeceleration: string | null
  entryPrice: number
  target50EMA: number
  atr: number | null
  sessionCandlesSoFar: Candle[]
  globalIndex: number
}

// Fixed-percentage exit ladder, no runner - sells exactly 1 contract per
// 10% increment, scaled by contract count, fully exiting the position by
// the last tier every time. Tests the hypothesis (proposed 2026-07-16,
// after the live tier plan + a 75% IV confidence floor STILL produced a
// losing 90-day backtest) that giving up the open-ended +100% runner for
// guaranteed, earlier, more frequent profit-taking produces a more
// consistently profitable - if lower-ceiling - result. NOT live - a
// backtest-only variant, opt-in via --tier-plan fixed-ladder, compared
// against the real live plan (tierPlanFor) over the same window.
const FIXED_LADDER_PCTS: Record<number, number[]> = {
  2: [0.10, 0.20],
  3: [0.10, 0.20, 0.30],
  4: [0.10, 0.20, 0.30, 0.40],
  5: [0.10, 0.20, 0.30, 0.40, 0.50]
}
const fixedLadderNoRunnerTierPlan = (contracts: number): TierSpec[] =>
  (FIXED_LADDER_PCTS[contracts] ?? []).map((targetPct, i) => ({ tierNumber: i + 1, isRunner: false, targetPct }))

// Hybrid plan proposed 2026-07-16: no runner at 2/3/4 contracts (full fixed
// exit, same spirit as fixed-ladder above but with a steeper final step -
// 2 contracts skips straight to 25% instead of 20%), but 5 contracts keeps
// a real runner as the last piece (+100% target / +50% post-3pm lock,
// unchanged mechanics) rather than going fully fixed like fixed-ladder's
// 5-contract plan does. NOT live - opt-in via --tier-plan hybrid-runner5.
const HYBRID_RUNNER5_PCTS: Record<number, number[]> = {
  2: [0.15, 0.25],
  3: [0.10, 0.20, 0.30],
  4: [0.10, 0.20, 0.30, 0.40],
  5: [0.10, 0.20, 0.30, 0.40]
}
const hybridRunner5TierPlan = (contracts: number): TierSpec[] => {
  const pcts = HYBRID_RUNNER5_PCTS[contracts] ?? []
  const fixed = pcts.map((targetPct, i) => ({ tierNumber: i + 1, isRunner: false, targetPct }))
  return contracts === 5 ? [...fixed, { tierNumber: RUNNER_TIER_NUMBER, isRunner: true, targetPct: RUNNER_TARGET_PCT }] : fixed
}

// "Scalper" plan proposed 2026-07-16, after live's tier-fill mechanism moved
// to resting broker-side limit orders (each tier gets its own real order at
// entry - see execute-alerts.ts/monitor-executions.ts) but SPY/QQQ calls
// still ran up well past their old 10/20/30% tiers and reversed all the way
// into the hard stop, netting a loss on trades that were profitable
// mid-flight. Hypothesis: much tighter, closer-together tiers (5-point
// steps instead of 10) bank real profit sooner and more often, treating
// this like a scalper's market rather than a swing/runner one. No runner at
// any contract count - always fully exits by the last tier, same spirit as
// fixed-ladder above. NOT live - opt-in via --tier-plan scalper.
const SCALPER_LADDER_PCTS: Record<number, number[]> = {
  2: [0.10, 0.15],
  3: [0.10, 0.15, 0.20],
  4: [0.10, 0.15, 0.20, 0.25],
  5: [0.10, 0.15, 0.20, 0.25, 0.30]
}
const scalperLadderTierPlan = (contracts: number): TierSpec[] =>
  (SCALPER_LADDER_PCTS[contracts] ?? []).map((targetPct, i) => ({ tierNumber: i + 1, isRunner: false, targetPct }))

const parseArgs = () => {
  const args = process.argv.slice(2)
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag)
    return i >= 0 ? args[i + 1] : undefined
  }
  const days = get('--days')
  const end = get('--end') ?? new Date().toISOString().slice(0, 10)
  const start = get('--start') ?? (() => {
    const d = new Date(end)
    d.setDate(d.getDate() - parseInt(days ?? '90', 10))
    return d.toISOString().slice(0, 10)
  })()
  const hardStopPct = get('--hard-stop-pct')
  const tierPlanArg = get('--tier-plan') // 'live' (default), 'fixed-ladder', 'hybrid-runner5', or 'scalper'
  const maxDailyEntries = get('--max-daily-entries')
  const chopStart = get('--chop-start') // "HH:MM" ET, e.g. "10:00"
  const chopEnd = get('--chop-end')
  const orbIntradayVwapGate = args.includes('--orb-intraday-vwap-gate')
  const orbStopPct = get('--orb-stop-pct') // e.g. "0.25" - wider stop for ORB only, everything else keeps the flat hard-stop-pct
  const maxDailyCapital = get('--max-daily-capital') // dollars, e.g. "2000" - replaces max-daily-entries entirely when set
  const dailyLossLimit = get('--daily-loss-limit-pct') // e.g. "0.15" - pause new entries once today's realized loss hits this fraction of the day's starting equity
  const orbMinConfidence = get('--orb-min-confidence') // e.g. "0.75" - overrides ORB's 0.60 floor specifically, everything else unchanged
  const divMinConfidence = get('--div-min-confidence') // e.g. "0.55" - overrides DIV's fallback-to-global 0.65 floor specifically, everything else unchanged
  const quietOpenUntil = get('--quiet-open-until') // "HH:MM" ET, e.g. "10:30" - blocks new IV/ORB entries before this time, everything else unchanged
  const quarterHourDiscount = get('--quarter-hour-confidence-discount') // e.g. "0.05" - lowers min confidence by this much for entries firing exactly on :00/:30, ALL types
  const orbQuarterHourDiscountArg = get('--orb-quarter-hour-discount') // e.g. "0.10" - same discount, ORB only, IV/others unaffected
  const rebalanceCapitalPriorityArg = args.includes('--rebalance-capital-priority') // halves ORB/IV position size (RISK_PCT_MULTIPLIER_BY_TYPE), DIV/TTTF/DTTF/STTF unaffected
  const disableTypesArg = get('--disable-types') // e.g. "ORB,IV" - removes these signal types from the rotation entirely
  const quarterHourFilter = get('--quarter-hour-entry-filter-minutes') // e.g. "3" - hard filter, only allow entries within N minutes of a :00/:30 mark
  const toMinutes = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m }
  const tierPlanFn = tierPlanArg === 'fixed-ladder' ? fixedLadderNoRunnerTierPlan
    : tierPlanArg === 'hybrid-runner5' ? hybridRunner5TierPlan
    : tierPlanArg === 'scalper' ? scalperLadderTierPlan
    : undefined
  return {
    start, end,
    hardStopPctOverride: hardStopPct ? parseFloat(hardStopPct) : undefined,
    tierPlanFn,
    tierPlanLabel: tierPlanArg ?? 'live',
    maxDailyEntries: maxDailyEntries ? parseInt(maxDailyEntries, 10) : Infinity,
    chopZoneStartMinutes: chopStart ? toMinutes(chopStart) : undefined,
    chopZoneEndMinutes: chopEnd ? toMinutes(chopEnd) : undefined,
    orbIntradayVwapGate,
    hardStopPctByType: orbStopPct ? { ORB: parseFloat(orbStopPct) } : undefined,
    orbStopPctLabel: orbStopPct ?? 'same-as-global',
    maxDailyCapitalBudget: maxDailyCapital ? parseFloat(maxDailyCapital) : undefined,
    dailyLossLimitPct: dailyLossLimit ? parseFloat(dailyLossLimit) : undefined,
    orbMinConfidenceOverride: orbMinConfidence ? parseFloat(orbMinConfidence) : undefined,
    divMinConfidenceOverride: divMinConfidence ? parseFloat(divMinConfidence) : undefined,
    quietOpenUntilMinutes: quietOpenUntil ? toMinutes(quietOpenUntil) : undefined,
    quietOpenUntilLabel: quietOpenUntil ?? 'off',
    quarterHourConfidenceDiscount: quarterHourDiscount ? parseFloat(quarterHourDiscount) : undefined,
    orbQuarterHourDiscount: orbQuarterHourDiscountArg ? parseFloat(orbQuarterHourDiscountArg) : undefined,
    rebalanceCapitalPriority: rebalanceCapitalPriorityArg,
    disabledTypes: disableTypesArg ? new Set(disableTypesArg.split(',').map(s => s.trim())) : undefined,
    disabledTypesLabel: disableTypesArg ?? 'none',
    quarterHourEntryFilterMinutes: quarterHourFilter ? parseInt(quarterHourFilter, 10) : undefined,
    chopLabel: (chopStart && chopEnd) ? `${chopStart}-${chopEnd}` : 'live(11:30-13:30)'
  }
}

const main = async () => {
  const { start, end, hardStopPctOverride, tierPlanFn, tierPlanLabel, maxDailyEntries, chopZoneStartMinutes, chopZoneEndMinutes, chopLabel, orbIntradayVwapGate, hardStopPctByType, orbStopPctLabel, maxDailyCapitalBudget, dailyLossLimitPct, orbMinConfidenceOverride, divMinConfidenceOverride, quietOpenUntilMinutes, quietOpenUntilLabel, quarterHourConfidenceDiscount, quarterHourEntryFilterMinutes, orbQuarterHourDiscount, rebalanceCapitalPriority, disabledTypes, disabledTypesLabel } = parseArgs()
  console.log(`Backtesting ${SYMBOLS.join('/')} from ${start} to ${end}...`)
  console.log(`ORB intraday VWAP gate: ${orbIntradayVwapGate ? 'ON (daily-trend OR intraday-vwap)' : 'OFF (daily-trend only, live default)'}`)
  console.log(`ORB stop-pct override: ${orbStopPctLabel}`)
  console.log(`ORB min-confidence override: ${orbMinConfidenceOverride !== undefined ? orbMinConfidenceOverride : 'default (0.60)'}`)
  console.log(`DIV min-confidence override: ${divMinConfidenceOverride !== undefined ? divMinConfidenceOverride : 'default (fallback to global 0.65)'}`)
  console.log(`Quiet-open window (blocks new IV/ORB entries before this time): ${quietOpenUntilLabel}`)
  console.log(`Quarter-hour (:00/:30) confidence discount: ${quarterHourConfidenceDiscount !== undefined ? quarterHourConfidenceDiscount : 'off'}`)
  console.log(`Quarter-hour (:00/:30) hard entry filter: ${quarterHourEntryFilterMinutes !== undefined ? `within ${quarterHourEntryFilterMinutes}min` : 'off'}`)
  console.log(`Capital priority rebalance (ORB/IV half-size): ${rebalanceCapitalPriority ? 'ON' : 'OFF'}`)
  console.log(`Disabled signal types: ${disabledTypesLabel}`)
  console.log(`Daily cap mode: ${maxDailyCapitalBudget !== undefined ? `capital-based ($${maxDailyCapitalBudget})` : `count-based (${maxDailyEntries === Infinity ? 'unlimited' : maxDailyEntries})`}`)
  console.log(`Daily loss circuit breaker: ${dailyLossLimitPct !== undefined ? `ON (${(dailyLossLimitPct * 100).toFixed(0)}% of day's starting equity)` : 'OFF'}`)
  console.log(`Strategy: hard-stop=${((hardStopPctOverride ?? 0.25) * 100).toFixed(0)}% | tier-plan=${tierPlanLabel} | max-daily-entries=${maxDailyEntries === Infinity ? 'unlimited' : maxDailyEntries} | chop-zone=${chopLabel}`)

  // Extra lookback before `start` so daily EMA200 and the intraday rolling
  // window both have real history from day 1 of the actual scored range,
  // instead of a long warm-up period of null EMAs / short windows.
  const dailyFetchStart = new Date(new Date(start).getTime() - 400 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const intradayFetchStart = new Date(new Date(start).getTime() - 10 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

  const dailyCandles: Record<Symbol, Candle[]> = { SPY: [], QQQ: [], IWM: [] }
  const intradayCandles: Record<Symbol, Candle[]> = { SPY: [], QQQ: [], IWM: [] }

  for (const symbol of SYMBOLS) {
    console.log(`Fetching history for ${symbol}...`)
    dailyCandles[symbol] = await fetchDailyHistory(symbol, `${dailyFetchStart}T00:00:00Z`, `${end}T23:59:59Z`)
    intradayCandles[symbol] = await fetchIntradayHistory(symbol, `${intradayFetchStart}T00:00:00Z`, `${end}T23:59:59Z`)
    console.log(`  ${symbol}: ${dailyCandles[symbol].length} daily bars, ${intradayCandles[symbol].length} 5-min bars`)
  }

  // Index by exact ISO timestamp for O(1) cross-symbol lookup at each tick.
  const indexByTime: Record<Symbol, Map<string, number>> = { SPY: new Map(), QQQ: new Map(), IWM: new Map() }
  for (const symbol of SYMBOLS) {
    intradayCandles[symbol].forEach((c, i) => indexByTime[symbol].set(c.datetime, i))
  }

  // Daily-candle "as of" index: how many daily bars are strictly before a
  // given NY trading day, per symbol - used by dailyLevelsAsOf.
  const dailyIndexByDateKey: Record<Symbol, Map<string, number>> = { SPY: new Map(), QQQ: new Map(), IWM: new Map() }
  for (const symbol of SYMBOLS) {
    dailyCandles[symbol].forEach((c, i) => dailyIndexByDateKey[symbol].set(nyDateKey(c.datetime), i))
  }

  // Session (day) boundaries per symbol, for the today-only slice used by
  // opening-range/ORB/candlestick detection.
  const dayStartIndex: Record<Symbol, Map<string, number>> = { SPY: new Map(), QQQ: new Map(), IWM: new Map() }
  for (const symbol of SYMBOLS) {
    intradayCandles[symbol].forEach((c, i) => {
      const key = nyDateKey(c.datetime)
      if (!dayStartIndex[symbol].has(key)) dayStartIndex[symbol].set(key, i)
    })
  }

  // SPY as the wall clock - walk its bars in the SCORED range only (the
  // extra lookback fetched above is warm-up context, not evaluated).
  const scoredStartMs = new Date(`${start}T00:00:00Z`).getTime()
  const clockBars = intradayCandles.SPY.filter(c => new Date(c.datetime).getTime() >= scoredStartMs)

  // --- Phase 1 state (ungated signal tracking) ---
  const legs: BacktestLeg[] = []
  const openLegsBySymbol: Record<Symbol, BacktestLeg[]> = { SPY: [], QQQ: [], IWM: [] }
  let nextLegId = 1

  const makeLeg = (
    ttfStatus: string, symbol: Symbol, direction: 'bullish' | 'bearish', confidence: number,
    entryTime: Date, entryPrice: number, target50EMA: number, atr: number | null
  ): BacktestLeg => {
    const stopLossPrice = stopLossFor(direction, entryPrice, atr)
    const milestones = deriveMilestonePrices(entryPrice, target50EMA)
    return {
      id: nextLegId++, ttfStatus, symbol, direction, confidence, entryTimeIso: entryTime.toISOString(), status: 'open',
      entry_price: entryPrice, target_50ema_price: target50EMA, stop_loss_price: stopLossPrice,
      milestone_10_price: milestones.milestone10, milestone_10_hit_at: null,
      milestone_20_price: milestones.milestone20, milestone_20_hit_at: null,
      milestone_30_price: milestones.milestone30, milestone_30_hit_at: null,
      max_favorable_pct: null, target_hit_at: null, stopped_out_at: null
    }
  }

  // --- Phase 2 state (gated, portfolio-aware execution) ---
  let simEquity = SIM_STARTING_EQUITY
  let committedCapital = 0
  const openPositions: SimPosition[] = []
  const openPositionBySymbolDirection = new Map<string, SimPosition>()
  const lastCloseTimeBySymbolDirection = new Map<string, string>()
  const histogramHistoryBySymbol: Record<Symbol, { timeIso: string; histogram: number }[]> = { SPY: [], QQQ: [], IWM: [] }
  const executedPositions: SimPosition[] = []
  const skippedByReason = new Map<string, number>()
  const entriesByDay = new Map<string, number>()
  let nextPositionId = 1
  let peakConcurrentPositions = 0

  // Daily-loss circuit breaker, proposed 2026-07-17 after a 43% single-day
  // drawdown with no mechanism to pause new entries once a bad stretch was
  // already underway - flagged as a gap since the very first live session
  // (2026-07-15) and never built. startOfDayEquityByDay captures simEquity
  // the first time a day is seen (before that day's first entry can touch
  // it); the gate then compares CURRENT simEquity against that day's own
  // starting point - a realized-P&L-only measure (simEquity only moves on
  // actual fills, not mark-to-market of open positions), which is the
  // cheaply-available, conservative choice: it reacts to closed losses, not
  // paper swings. Opt-in via --daily-loss-limit-pct <fraction>, e.g. 0.15.
  const startOfDayEquityByDay = new Map<string, number>()
  const dailyLossLimitHitByDay = new Set<string>()

  const skip = (reason: string) => skippedByReason.set(reason, (skippedByReason.get(reason) ?? 0) + 1)

  // Applies exactly the NEW fills (since previousFillCount) to the shared
  // account - frees each sold contract's original cost basis back to
  // buying power and realizes its P&L into equity. Called after every
  // checkPositionAtBar/closeOpposing call so capital effects land at the
  // instant they actually happened, not all at once when a position fully
  // closes (a position can free capital across several tier fills over
  // time, same as live).
  const applyFillEffects = (position: SimPosition, previousFillCount: number) => {
    for (let i = previousFillCount; i < position.fills.length; i++) {
      const f = position.fills[i]
      committedCapital -= f.contractsSold * position.entryPremium * 100
      simEquity += (f.premium - position.entryPremium) * 100 * f.contractsSold
    }
  }

  const removeClosedPosition = (position: SimPosition, closedAtIso: string) => {
    const idx = openPositions.indexOf(position)
    if (idx >= 0) openPositions.splice(idx, 1)
    openPositionBySymbolDirection.delete(`${position.symbol}:${position.direction}`)
    lastCloseTimeBySymbolDirection.set(`${position.symbol}:${position.direction}`, closedAtIso)
    executedPositions.push(position)
  }

  const hasMomentumReset = (symbol: Symbol, direction: 'bullish' | 'bearish', sinceIso: string): boolean => {
    const history = histogramHistoryBySymbol[symbol].filter(h => h.timeIso > sinceIso)
    if (history.length === 0) return false
    return direction === 'bullish' ? history.some(h => h.histogram <= 0) : history.some(h => h.histogram >= 0)
  }

  // Cumulative $ committed today (contracts * entry premium * 100 at open,
  // summed across every entry - NOT decremented when a position later
  // closes and frees its capital back). Proposed 2026-07-17, live: a flat
  // trade-COUNT cap (maxDailyEntries) treats a 5-contract $0.12 entry
  // (~$60 committed) identically to a 2-contract $2.31 entry (~$460
  // committed) - a cluster of cheap, fast-stopping entries can burn the
  // whole day's count allowance before 10:30am with very little capital
  // actually having been at risk, then block a genuinely good later setup
  // with zero room left. This gates on total $ deployed today instead, so
  // many small entries can still fit under one cheap-entry's-worth of
  // exposure while capping overall daily capital throughput. Opt-in via
  // --max-daily-capital <dollars> - when set, maxDailyEntries is ignored
  // entirely (mutually exclusive modes, not combined).
  const dailyCapitalCommittedByDay = new Map<string, number>()

  // Mirrors execute-alerts.ts's real entry gates, in the same order, against
  // the shared simulated account. Called once per fired leg, right after
  // Phase 1's ungated makeLeg for the same signal.
  const attemptGatedEntry = (
    ttfStatus: string, symbol: Symbol, direction: 'bullish' | 'bearish', confidence: number,
    entryTime: Date, entryPrice: number, target50EMA: number, globalIndex: number
  ) => {
    const t = entryTime.toISOString()
    const minutesNow = nyMinutesSinceMidnight(entryTime)
    const dayKey = nyDateKey(t)

    if (minutesNow >= FORCE_CLOSE_HOUR_ET * 60 + FORCE_CLOSE_MINUTE_ET) return skip('past_force_close')
    // Harder version of the capital-priority rebalance: instead of halving
    // ORB/IV's position size (found 2026-07-17 that the shared-capital-pool
    // just reabsorbed the freed buying power as MORE ORB/IV entries,
    // leaving total P&L unchanged), remove them from the rotation entirely.
    // Opt-in via --disable-types SYMBOL,SYMBOL.
    if (disabledTypes?.has(ttfStatus)) return skip('type_disabled')
    if (dailyLossLimitPct !== undefined) {
      const startOfDay = startOfDayEquityByDay.get(dayKey) ?? simEquity
      if (simEquity <= startOfDay * (1 - dailyLossLimitPct)) {
        dailyLossLimitHitByDay.add(dayKey)
        return skip('daily_loss_limit')
      }
    }
    if (maxDailyCapitalBudget === undefined && (entriesByDay.get(dayKey) ?? 0) >= maxDailyEntries) return skip('max_daily_entries')
    // Found live 2026-07-17: both IV and ORB show the identical shape at
    // scale - their highest-volume entry hour (10am ET, right as IV's own
    // eligibility gate opens and shortly after ORB's opening-range window
    // closes) is also consistently their WORST hour, while 3pm is
    // consistently their best. ~50% of trades in both signals get zero
    // favorable movement before stopping out - a "caught the tail end of
    // the open's whipsaw" pattern, not a signal-quality issue specific to
    // either one. Opt-in via --quiet-open-until, scoped to IV/ORB only
    // (the two types that showed this pattern) - everything else unchanged.
    if (quietOpenUntilMinutes !== undefined && (ttfStatus === 'IV' || ttfStatus === 'ORB') && minutesNow < quietOpenUntilMinutes) {
      return skip('quiet_open_window')
    }
    // Harder version of the same idea: instead of a confidence discount,
    // require entries to fire within N minutes of a :00/:30 mark at all -
    // everything outside that window gets skipped regardless of
    // confidence. Mutually exclusive with the discount variant in
    // practice (test one or the other), both opt-in.
    if (quarterHourEntryFilterMinutes !== undefined) {
      const distanceToMark = Math.min(minutesNow % 30, 30 - (minutesNow % 30))
      if (distanceToMark > quarterHourEntryFilterMinutes) return skip('outside_quarter_hour_window')
    }
    const baseMinConfidence = (ttfStatus === 'ORB' && orbMinConfidenceOverride !== undefined) ? orbMinConfidenceOverride
      : (ttfStatus === 'DIV' && divMinConfidenceOverride !== undefined) ? divMinConfidenceOverride
      : (MIN_CONFIDENCE_BY_TYPE[ttfStatus] ?? GLOBAL_MIN_CONFIDENCE)
    // Found live 2026-07-17: bars starting exactly on the half-hour (:30)
    // average 20% more range than a random minute, and top-of-hour (:00)
    // about 10% more - consistent with institutional VWAP/TWAP execution
    // schedules and other scheduled order flow conventionally sliced to
    // those marks specifically (quarter-hours :15/:45 showed no
    // measurable difference from any other minute - not part of this).
    // Hypothesis: a signal firing exactly at one of these marks is more
    // likely riding real, scheduled flow rather than noise, so it can
    // earn a small confidence discount rather than needing the full bar.
    //
    // Two opt-in variants: --quarter-hour-confidence-discount applies to
    // EVERY type equally (found 2026-07-17 this flips ORB positive,
    // +$191 vs -$2,426, but tanks IV, -$1,978 vs -$16, via the same
    // shared-capital-cascade effect seen all day). --orb-quarter-hour-
    // discount scopes the same discount to ORB only, leaving IV (and
    // everything else) at its normal bar everywhere - avoids feeding
    // freed-up capital into a type that gets worse with more room to fire.
    const onHalfHourMark = minutesNow % 30 === 0
    const applicableDiscount = (ttfStatus === 'ORB' && orbQuarterHourDiscount !== undefined) ? orbQuarterHourDiscount
      : quarterHourConfidenceDiscount !== undefined ? quarterHourConfidenceDiscount
      : undefined
    const minConfidence = (onHalfHourMark && applicableDiscount !== undefined) ? Math.max(0, baseMinConfidence - applicableDiscount) : baseMinConfidence
    if (confidence < minConfidence) return skip('below_min_confidence')
    if (ttfStatus === 'IV' && minutesNow < MARKET_OPEN_MINUTES_ET + IV_ELIGIBLE_AFTER_MINUTES) return skip('iv_too_early')

    const key = `${symbol}:${direction}`
    if (openPositionBySymbolDirection.has(key)) return skip('same_symbol_direction_open')

    // Mirrors execute-alerts.ts's momentum-reset gate (2026-07-17: DIV added
    // - it's a pre-confirmation tier without a completed MACD crossover, so
    // it doesn't get TTF-family's "genuinely new price extreme required to
    // fire" protection, and was found live re-firing repeatedly on the same
    // symbol during tight chop with no real price structure behind it).
    const orbHighConfidenceContinuation = ttfStatus === 'ORB' && confidence >= ORB_HIGH_CONFIDENCE_CONTINUATION_THRESHOLD
    if ((ttfStatus === 'IV' || ttfStatus === 'ORB' || ttfStatus === 'DIV') && !orbHighConfidenceContinuation) {
      const lastClose = lastCloseTimeBySymbolDirection.get(key)
      if (lastClose && nyDateKey(lastClose) === nyDateKey(t) && !hasMomentumReset(symbol, direction, lastClose)) {
        return skip('momentum_not_reset')
      }
    }

    // Opposing-signal close-all: a fresh signal clearing every gate in the
    // OPPOSITE direction flattens any open position (any symbol) on the
    // other side, freeing its capital before this entry is sized.
    for (const position of [...openPositions]) {
      if (position.direction === direction) continue
      const posGi = indexByTime[position.symbol as Symbol].get(t)
      if (posGi === undefined) continue
      const posClose = intradayCandles[position.symbol as Symbol][posGi].close
      const prevFillCount = position.fills.length
      closeOpposing(position, posClose, t)
      applyFillEffects(position, prevFillCount)
      removeClosedPosition(position, t)
    }

    const volWindow = intradayCandles[symbol].slice(Math.max(0, globalIndex - VOL_WINDOW_BARS + 1), globalIndex + 1).map(c => c.close)
    const buyingPower = simEquity * MARGIN_MULTIPLIER - committedCapital
    const riskPctMultiplier = rebalanceCapitalPriority ? (RISK_PCT_MULTIPLIER_BY_TYPE[ttfStatus] ?? DEFAULT_RISK_PCT_MULTIPLIER) : 1.0
    const priced = priceEntry(direction, entryPrice, target50EMA, t, volWindow, {
      equity: simEquity, buyingPower, riskPct: SIM_RISK_PCT * riskPctMultiplier, minEquity: SIM_MIN_EQUITY, maxEquity: SIM_MAX_EQUITY
    })
    if (!priced.ok) return skip(priced.reason)

    const entryCost = priced.contracts * priced.entryPremium * 100
    if (maxDailyCapitalBudget !== undefined) {
      const spentToday = dailyCapitalCommittedByDay.get(dayKey) ?? 0
      if (spentToday + entryCost > maxDailyCapitalBudget) return skip('max_daily_capital')
      dailyCapitalCommittedByDay.set(dayKey, spentToday + entryCost)
    }

    const position = openPosition(nextPositionId++, ttfStatus, symbol, direction, priced, t, { tierPlanFn, hardStopPct: hardStopPctOverride, hardStopPctByType })
    committedCapital += entryCost
    openPositions.push(position)
    openPositionBySymbolDirection.set(key, position)
    entriesByDay.set(dayKey, (entriesByDay.get(dayKey) ?? 0) + 1)
    peakConcurrentPositions = Math.max(peakConcurrentPositions, openPositions.length)
  }

  let barsEvaluated = 0

  for (const clockBar of clockBars) {
    const t = clockBar.datetime
    const now = new Date(t)
    barsEvaluated++

    const todayKey = nyDateKey(t)
    if (!startOfDayEquityByDay.has(todayKey)) startOfDayEquityByDay.set(todayKey, simEquity)

    // --- 1a. Update every currently-open leg (Phase 1) against this bar's close ---
    for (const symbol of SYMBOLS) {
      const gi = indexByTime[symbol].get(t)
      if (gi === undefined) continue
      const close = intradayCandles[symbol][gi].close

      openLegsBySymbol[symbol] = openLegsBySymbol[symbol].filter(leg => {
        if (checkExpiry(new Date(leg.entryTimeIso), now)) {
          leg.status = 'expired'
          return false
        }
        const update = applyPriceSample(leg, leg.direction, close, now)
        if (update) Object.assign(leg, update)
        if (leg.status === 'target_hit' || leg.status === 'stopped_out') return false
        return true
      })
    }

    // --- 1b. Update every currently-open position (Phase 2) against this bar's close ---
    for (const symbol of SYMBOLS) {
      const gi = indexByTime[symbol].get(t)
      if (gi === undefined) continue
      const close = intradayCandles[symbol][gi].close

      for (const position of [...openPositions]) {
        if (position.symbol !== symbol) continue
        const prevFillCount = position.fills.length
        const closed = checkPositionAtBar(position, close, t)
        applyFillEffects(position, prevFillCount)
        if (closed) removeClosedPosition(position, t)
      }
    }

    // --- 2. Compute this bar's per-symbol signal for whichever symbols have data ---
    const perSymbolSignals: PerSymbolBar[] = []
    for (const symbol of SYMBOLS) {
      const gi = indexByTime[symbol].get(t)
      if (gi === undefined) continue

      const windowStart = Math.max(0, gi - ROLLING_WINDOW_BARS + 1)
      const window = intradayCandles[symbol].slice(windowStart, gi + 1)
      const closes = window.map(c => c.close)
      if (closes.length < 26) continue

      const signal = analyzeCandles(closes, MACD_CURL_LOOKBACK_BARS, RSI_DIVERGENCE_LOOKBACK_BARS, HISTOGRAM_DECELERATION_BARS)

      // Histogram history for the momentum-reset gate - tracked regardless
      // of whether a signal fired this bar, same as live's
      // indicator_snapshots (recorded every scan, not just on a fire).
      const macdData = calculateMACD(closes)
      const latestHistogram = macdData[macdData.length - 1]?.histogram
      if (latestHistogram !== undefined) {
        histogramHistoryBySymbol[symbol].push({ timeIso: t, histogram: latestHistogram })
      }

      if (!signal) continue

      const atrValues = calculateATR(window.map(c => c.high), window.map(c => c.low), closes, 14)
      const dayKey = nyDateKey(t)
      const dayStart = dayStartIndex[symbol].get(dayKey) ?? gi
      const sessionCandlesSoFar = intradayCandles[symbol].slice(dayStart, gi + 1)

      perSymbolSignals.push({
        symbol,
        rsiDivergence: signal.rsiDivergence,
        macdCurl: signal.macdCurl,
        histogramDeceleration: signal.histogramDeceleration,
        entryPrice: signal.entryPrice,
        target50EMA: signal.target50EMA,
        atr: atrValues[atrValues.length - 1] ?? null,
        sessionCandlesSoFar,
        globalIndex: gi
      })
    }

    if (perSymbolSignals.length === 0) continue

    const dailyAsOf = (symbol: Symbol) => dailyIndexByDateKey[symbol].get(nyDateKey(t)) ?? 0

    // --- 3. Full confluence (TTTF/DTTF/STTF) ---
    const signalResults = perSymbolSignals.filter(s => s.rsiDivergence && s.rsiDivergence === s.macdCurl)
    const triggeredIndices = signalResults.map(r => r.symbol)
    let fullConfluenceFired = false

    if (signalResults.length > 0) {
      fullConfluenceFired = true
      const ttfStatus = triggeredIndices.length === 3 ? 'TTTF' : triggeredIndices.length === 2 ? 'DTTF' : 'STTF'
      const baseConfidence = ttfStatus === 'TTTF' ? 0.95 : ttfStatus === 'DTTF' ? 0.75 : 0.55
      const representative = signalResults[0]
      const dailyLevels = dailyLevelsAsOf(dailyCandles[representative.symbol], dailyAsOf(representative.symbol))
      const patternMatch = detectCandlestickPattern(representative.sessionCandlesSoFar)
      const openingRange = openingRangeFor(representative.sessionCandlesSoFar)
      const orbDirection = detectORBBreakout(representative.sessionCandlesSoFar, openingRange?.orh ?? null, openingRange?.orl ?? null)
      const confidence = applyConfidenceModifiers(baseConfidence, {
        direction: representative.rsiDivergence as 'bullish' | 'bearish',
        dailyEma50: dailyLevels?.dailyEma50 ?? null,
        dailyEma200: dailyLevels?.dailyEma200 ?? null,
        candlestickDirection: patternMatch?.direction ?? null,
        orbBreakoutDirection: orbDirection,
        vixChangePct: null,
        now,
        chopZoneStartMinutes, chopZoneEndMinutes
      })

      for (const r of signalResults) {
        const direction = r.rsiDivergence as 'bullish' | 'bearish'
        const leg = makeLeg(ttfStatus, r.symbol, direction, confidence, now, r.entryPrice, r.target50EMA, r.atr)
        legs.push(leg)
        openLegsBySymbol[r.symbol].push(leg)
        attemptGatedEntry(ttfStatus, r.symbol, direction, confidence, now, r.entryPrice, r.target50EMA, r.globalIndex)
      }
    }

    // --- 4. DIV ---
    if (!fullConfluenceFired) {
      for (const direction of ['bullish', 'bearish'] as const) {
        const divergent = perSymbolSignals.filter(s => s.rsiDivergence === direction && s.histogramDeceleration === direction)
        if (divergent.length < 1) continue

        const representative = divergent.find(s => s.symbol === 'SPY') || divergent[0]
        const dailyLevels = dailyLevelsAsOf(dailyCandles[representative.symbol], dailyAsOf(representative.symbol))
        const patternMatch = detectCandlestickPattern(representative.sessionCandlesSoFar)
        const openingRange = openingRangeFor(representative.sessionCandlesSoFar)
        const orbDirection = detectORBBreakout(representative.sessionCandlesSoFar, openingRange?.orh ?? null, openingRange?.orl ?? null)
        const baseConfidence = divergent.length === 3 ? 0.80 : divergent.length === 2 ? 0.65 : 0.50
        const confidence = applyConfidenceModifiers(baseConfidence, {
          direction,
          dailyEma50: dailyLevels?.dailyEma50 ?? null,
          dailyEma200: dailyLevels?.dailyEma200 ?? null,
          candlestickDirection: patternMatch?.direction ?? null,
          orbBreakoutDirection: orbDirection,
          vixChangePct: null,
          now,
          chopZoneStartMinutes, chopZoneEndMinutes
        })

        for (const s of divergent) {
          const leg = makeLeg('DIV', s.symbol, direction, confidence, now, s.entryPrice, s.target50EMA, s.atr)
          legs.push(leg)
          openLegsBySymbol[s.symbol].push(leg)
          attemptGatedEntry('DIV', s.symbol, direction, confidence, now, s.entryPrice, s.target50EMA, s.globalIndex)
        }
      }
    }

    // --- 5. IV ---
    if (!fullConfluenceFired) {
      for (const direction of ['bullish', 'bearish'] as const) {
        const directional = perSymbolSignals.filter(s => s.macdCurl === direction)
        if (directional.length < 2) continue

        const representative = directional.find(s => s.symbol === 'SPY') || directional[0]
        const levels = supportResistanceLevelsAsOf(dailyCandles[representative.symbol], dailyAsOf(representative.symbol), representative.sessionCandlesSoFar)
        const ivResult = detectIVSignal(direction, representative.entryPrice, levels, directional.map(s => s.symbol), representative.sessionCandlesSoFar)
        if (!ivResult) continue

        const patternMatch = detectCandlestickPattern(representative.sessionCandlesSoFar)
        const orbDirection = detectORBBreakout(representative.sessionCandlesSoFar, levels.orh, levels.orl)
        const confidence = applyConfidenceModifiers(ivResult.confidence, {
          direction,
          dailyEma50: levels.dailyEma50,
          dailyEma200: levels.dailyEma200,
          candlestickDirection: patternMatch?.direction ?? null,
          orbBreakoutDirection: orbDirection,
          vixChangePct: null,
          now,
          chopZoneStartMinutes, chopZoneEndMinutes
        })

        for (const s of directional) {
          const legStop = stopLossFor(direction, s.entryPrice, s.atr)
          const legTarget = continuationTargetPrice(direction, s.entryPrice, legStop)
          const leg = makeLeg('IV', s.symbol, direction, confidence, now, s.entryPrice, legTarget, s.atr)
          legs.push(leg)
          openLegsBySymbol[s.symbol].push(leg)
          attemptGatedEntry('IV', s.symbol, direction, confidence, now, s.entryPrice, legTarget, s.globalIndex)
        }
      }
    }

    // --- 6. ORB ---
    if (!fullConfluenceFired) {
      for (const direction of ['bullish', 'bearish'] as const) {
        const candidateSignals = perSymbolSignals.map(s => ({ symbol: s.symbol, macdCurl: s.macdCurl, candles: s.sessionCandlesSoFar }))
        const qualifyingSymbols = filterORBCandidates(candidateSignals, direction, openingRangeFor)
        if (qualifyingSymbols.length < 1) continue

        const candidates = perSymbolSignals.filter(s => qualifyingSymbols.includes(s.symbol))
        const representative = candidates.find(s => s.symbol === 'SPY') || candidates[0]
        const dailyLevels = dailyLevelsAsOf(dailyCandles[representative.symbol], dailyAsOf(representative.symbol))
        const dailyAligned = isDailyTrendAligned(direction, dailyLevels?.dailyEma50 ?? null, dailyLevels?.dailyEma200 ?? null)
        const intradayAligned = orbIntradayVwapGate &&
          isIntradayVwapAligned(direction, representative.entryPrice, sessionVWAPFor(representative.sessionCandlesSoFar))
        if (!dailyAligned && !intradayAligned) continue

        const patternMatch = detectCandlestickPattern(representative.sessionCandlesSoFar)
        const confidence = applyConfidenceModifiers(orbBaseConfidence(qualifyingSymbols.length), {
          direction,
          dailyEma50: null,
          dailyEma200: null,
          candlestickDirection: patternMatch?.direction ?? null,
          orbBreakoutDirection: null,
          vixChangePct: null,
          now,
          chopZoneStartMinutes, chopZoneEndMinutes
        })

        for (const s of candidates) {
          const legStop = stopLossFor(direction, s.entryPrice, s.atr)
          const legTarget = continuationTargetPrice(direction, s.entryPrice, legStop)
          const leg = makeLeg('ORB', s.symbol, direction, confidence, now, s.entryPrice, legTarget, s.atr)
          legs.push(leg)
          openLegsBySymbol[s.symbol].push(leg)
          attemptGatedEntry('ORB', s.symbol, direction, confidence, now, s.entryPrice, legTarget, s.globalIndex)
        }
      }
    }
  }

  // Anything still open at the end of the backtest window is unresolved -
  // counted separately, not folded into win rate/P&L.
  for (const symbol of SYMBOLS) {
    for (const leg of openLegsBySymbol[symbol]) leg.status = 'open'
  }
  for (const position of openPositions) executedPositions.push(position) // status stays 'open'

  console.log(`\nEvaluated ${barsEvaluated} bars, generated ${legs.length} ungated signal legs (Phase 1).\n`)

  // --- Phase 1: ungated signal-level table ---
  const byType = new Map<string, BacktestLeg[]>()
  for (const leg of legs) {
    if (!byType.has(leg.ttfStatus)) byType.set(leg.ttfStatus, [])
    byType.get(leg.ttfStatus)!.push(leg)
  }

  console.log('--- Phase 1: signal-level (ungated, no entry gates or capital constraints) ---')
  const rows: string[] = []
  rows.push('Type     Legs   TargetHit  StoppedOut  Expired  Open  WinRate  AvgConfidence')
  for (const [type, typeLegs] of [...byType.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const hit = typeLegs.filter(l => l.status === 'target_hit').length
    const stopped = typeLegs.filter(l => l.status === 'stopped_out').length
    const expired = typeLegs.filter(l => l.status === 'expired').length
    const open = typeLegs.filter(l => l.status === 'open').length
    const resolved = hit + stopped
    const winRate = resolved > 0 ? ((hit / resolved) * 100).toFixed(1) + '%' : '—'
    const avgConf = (typeLegs.reduce((a, l) => a + l.confidence, 0) / typeLegs.length).toFixed(2)
    rows.push(`${type.padEnd(8)} ${String(typeLegs.length).padEnd(6)} ${String(hit).padEnd(10)} ${String(stopped).padEnd(11)} ${String(expired).padEnd(8)} ${String(open).padEnd(5)} ${winRate.padEnd(8)} ${avgConf}`)
  }
  console.log(rows.join('\n'))

  // --- Phase 2: gated, portfolio-aware execution table ---
  console.log('\n--- Phase 2: gated execution against a shared simulated account (modeled premiums) ---')
  const byTypeExecuted = new Map<string, SimPosition[]>()
  for (const position of executedPositions) {
    if (!byTypeExecuted.has(position.ttfStatus)) byTypeExecuted.set(position.ttfStatus, [])
    byTypeExecuted.get(position.ttfStatus)!.push(position)
  }

  const pnlRows: string[] = []
  pnlRows.push('Type     Entries  Closed  Open  TotalPnL     AvgPnL/entry  WinRate($)')
  let grandTotalPnl = 0
  for (const [type, positions] of [...byTypeExecuted.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const closed = positions.filter(p => p.status === 'closed')
    const open = positions.filter(p => p.status === 'open')
    const totalPnl = closed.reduce((sum, p) => sum + p.realizedPnl, 0)
    const avgPnl = closed.length > 0 ? totalPnl / closed.length : 0
    const winners = closed.filter(p => p.realizedPnl > 0).length
    const dollarWinRate = closed.length > 0 ? ((winners / closed.length) * 100).toFixed(1) + '%' : '—'
    grandTotalPnl += totalPnl
    pnlRows.push(`${type.padEnd(8)} ${String(positions.length).padEnd(8)} ${String(closed.length).padEnd(7)} ${String(open.length).padEnd(5)} $${totalPnl.toFixed(0).padEnd(11)} $${avgPnl.toFixed(0).padEnd(12)} ${dollarWinRate}`)
  }
  console.log(pnlRows.join('\n'))

  console.log(`\nTotal entries executed: ${executedPositions.length} | peak concurrent positions: ${peakConcurrentPositions}`)
  console.log(`Realized P&L: $${grandTotalPnl.toFixed(0)} | Final simulated equity: $${simEquity.toFixed(0)} (started at $${SIM_STARTING_EQUITY})`)

  console.log('\nEntries skipped by gate:')
  for (const [reason, count] of [...skippedByReason.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${reason}: ${count}`)
  }

  if (dailyLossLimitPct !== undefined) {
    console.log(`\nDaily loss circuit breaker tripped on ${dailyLossLimitHitByDay.size} of ${new Set(clockBars.map(c => nyDateKey(c.datetime))).size} trading days`)
  }

  const capTag = maxDailyCapitalBudget !== undefined ? `capUSD${maxDailyCapitalBudget}` : `cap${maxDailyEntries === Infinity ? 'none' : maxDailyEntries}`
  const strategyTag = `hs${((hardStopPctOverride ?? 0.25) * 100).toFixed(0)}_${tierPlanLabel}_${capTag}${orbIntradayVwapGate ? '_orbvwap' : ''}${hardStopPctByType?.ORB ? `_orbstop${(hardStopPctByType.ORB * 100).toFixed(0)}` : ''}${dailyLossLimitPct !== undefined ? `_dll${(dailyLossLimitPct * 100).toFixed(0)}` : ''}${orbMinConfidenceOverride !== undefined ? `_orbconf${(orbMinConfidenceOverride * 100).toFixed(0)}` : ''}${divMinConfidenceOverride !== undefined ? `_divconf${(divMinConfidenceOverride * 100).toFixed(0)}` : ''}${quietOpenUntilMinutes !== undefined ? `_quiet${quietOpenUntilLabel.replace(':', '')}` : ''}${quarterHourConfidenceDiscount !== undefined ? `_qhdiscount${(quarterHourConfidenceDiscount * 100).toFixed(0)}` : ''}${quarterHourEntryFilterMinutes !== undefined ? `_qhfilter${quarterHourEntryFilterMinutes}` : ''}${orbQuarterHourDiscount !== undefined ? `_orbqhdiscount${(orbQuarterHourDiscount * 100).toFixed(0)}` : ''}${rebalanceCapitalPriority ? '_rebalance' : ''}${disabledTypes ? `_disable${[...disabledTypes].join('')}` : ''}`

  mkdirSync('backtest_out', { recursive: true })
  const outFile = `backtest_out/${start}_to_${end}_${strategyTag}.json`
  writeFileSync(outFile, JSON.stringify({
    start, end, barsEvaluated, legs, executedPositions,
    strategy: { hardStopPct: hardStopPctOverride ?? 0.25, tierPlan: tierPlanLabel, maxDailyEntries: maxDailyEntries === Infinity ? null : maxDailyEntries },
    summary: { grandTotalPnl, finalEquity: simEquity, peakConcurrentPositions, skippedByReason: Object.fromEntries(skippedByReason) }
  }, null, 1))
  console.log(`\nFull detail written to ${outFile}`)
}

export const run = main
