// Signal-level backtest: replays historical SPY/QQQ/IWM 5-min bars through
// the EXACT same detection code the live bot uses (analyzeCandles,
// detectIVSignal, ORB, DIV, applyConfidenceModifiers), walking forward bar-
// by-bar so nothing sees future data, and scores each fired signal against
// the underlying's own target/stop the same way profit_targets already
// does live (applyPriceSample/checkExpiry, reused unchanged).
//
// This is a SIGNAL backtest, not a P&L backtest - it answers "does this
// entry/exit logic have a directional edge on the underlying," not "what
// dollar P&L would the options bot have made." Real option premium P&L
// depends on execution/slippage/liquidity effects this can't capture (see
// report_out/2026-07-15.md's risk findings for why those matter a lot in
// practice). A second phase approximating option P&L is a separate,
// future piece of work.
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
import { dailyLevelsAsOf, openingRangeFor, supportResistanceLevelsAsOf } from '../server/backtest/replayHelpers.js'
import { analyzeCandles } from '../server/indicators.js'
import { calculateATR } from '../src/lib/technicalIndicators.js'
import { detectIVSignal } from '../server/signalDetection.js'
import { detectCandlestickPattern } from '../server/candlestickPatterns.js'
import { applyConfidenceModifiers } from '../server/confidenceModifiers.js'
import { detectORBBreakout, filterORBCandidates, isDailyTrendAligned, orbBaseConfidence, continuationTargetPrice } from '../server/orb.js'
import { deriveMilestonePrices, applyPriceSample, checkExpiry, ProfitTargetRow } from '../server/alertOutcomes.js'
import { nyDateKey } from '../server/marketHours.js'

const SYMBOLS = ['SPY', 'QQQ', 'IWM'] as const
type Symbol = typeof SYMBOLS[number]

const MACD_CURL_LOOKBACK_BARS = 30
const RSI_DIVERGENCE_LOOKBACK_BARS = 5
const HISTOGRAM_DECELERATION_BARS = 3
const ATR_STOP_MULTIPLIER = 1.5
const ROLLING_WINDOW_BARS = 300 // matches live's getIntradayCandles(symbol, 300) default

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
  return { start, end }
}

const main = async () => {
  const { start, end } = parseArgs()
  console.log(`Backtesting ${SYMBOLS.join('/')} from ${start} to ${end}...`)

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

  let barsEvaluated = 0

  for (const clockBar of clockBars) {
    const t = clockBar.datetime
    const now = new Date(t)
    barsEvaluated++

    // --- 1. Update every currently-open leg against this bar's close, per symbol ---
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
        now
      })

      for (const r of signalResults) {
        const leg = makeLeg(ttfStatus, r.symbol, r.rsiDivergence as 'bullish' | 'bearish', confidence, now, r.entryPrice, r.target50EMA, r.atr)
        legs.push(leg)
        openLegsBySymbol[r.symbol].push(leg)
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
          now
        })

        for (const s of divergent) {
          const leg = makeLeg('DIV', s.symbol, direction, confidence, now, s.entryPrice, s.target50EMA, s.atr)
          legs.push(leg)
          openLegsBySymbol[s.symbol].push(leg)
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
        const ivResult = detectIVSignal(direction, representative.entryPrice, levels, directional.map(s => s.symbol))
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
          now
        })

        for (const s of directional) {
          const legStop = stopLossFor(direction, s.entryPrice, s.atr)
          const legTarget = continuationTargetPrice(direction, s.entryPrice, legStop)
          const leg = makeLeg('IV', s.symbol, direction, confidence, now, s.entryPrice, legTarget, s.atr)
          legs.push(leg)
          openLegsBySymbol[s.symbol].push(leg)
        }
      }
    }

    // --- 6. ORB ---
    if (!fullConfluenceFired) {
      for (const direction of ['bullish', 'bearish'] as const) {
        const candidateSignals = perSymbolSignals.map(s => ({ symbol: s.symbol, macdCurl: s.macdCurl, candles: s.sessionCandlesSoFar }))
        const qualifyingSymbols = filterORBCandidates(candidateSignals, direction)
        if (qualifyingSymbols.length < 1) continue

        const candidates = perSymbolSignals.filter(s => qualifyingSymbols.includes(s.symbol))
        const representative = candidates.find(s => s.symbol === 'SPY') || candidates[0]
        const dailyLevels = dailyLevelsAsOf(dailyCandles[representative.symbol], dailyAsOf(representative.symbol))
        if (!isDailyTrendAligned(direction, dailyLevels?.dailyEma50 ?? null, dailyLevels?.dailyEma200 ?? null)) continue

        const patternMatch = detectCandlestickPattern(representative.sessionCandlesSoFar)
        const confidence = applyConfidenceModifiers(orbBaseConfidence(qualifyingSymbols.length), {
          direction,
          dailyEma50: null,
          dailyEma200: null,
          candlestickDirection: patternMatch?.direction ?? null,
          orbBreakoutDirection: null,
          vixChangePct: null,
          now
        })

        for (const s of candidates) {
          const legStop = stopLossFor(direction, s.entryPrice, s.atr)
          const legTarget = continuationTargetPrice(direction, s.entryPrice, legStop)
          const leg = makeLeg('ORB', s.symbol, direction, confidence, now, s.entryPrice, legTarget, s.atr)
          legs.push(leg)
          openLegsBySymbol[s.symbol].push(leg)
        }
      }
    }
  }

  // Anything still open at the end of the backtest window is unresolved -
  // counted separately, not folded into win rate.
  for (const symbol of SYMBOLS) {
    for (const leg of openLegsBySymbol[symbol]) leg.status = 'open'
  }

  console.log(`\nEvaluated ${barsEvaluated} bars, generated ${legs.length} legs.\n`)

  // --- Aggregate and print ---
  const byType = new Map<string, BacktestLeg[]>()
  for (const leg of legs) {
    if (!byType.has(leg.ttfStatus)) byType.set(leg.ttfStatus, [])
    byType.get(leg.ttfStatus)!.push(leg)
  }

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

  mkdirSync('backtest_out', { recursive: true })
  const outFile = `backtest_out/${start}_to_${end}.json`
  writeFileSync(outFile, JSON.stringify({ start, end, barsEvaluated, legs }, null, 1))
  console.log(`\nFull detail written to ${outFile}`)
}

export const run = main
