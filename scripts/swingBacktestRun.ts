// Backtest for the NOT-YET-LIVE swing execution spec (server/execution/
// swingPositionSizing.ts) - validates the exit-rule numbers proposed there
// (30% target / 35% stop / exit 3 days before expiry) against real
// historical price data before any of it becomes live code, same
// discipline every other signal/strategy in this project has gotten
// (scripts/backtestRun.ts for day-trading, this file's swing equivalent).
//
// Option premium is MODELED via Black-Scholes (server/optionsGreeks.ts's
// bsPrice/greeksAt, the same functions live Greeks computation uses), not
// real historical options data - this account has no paid historical
// options feed (same constraint documented throughout this project for the
// 0DTE backtest). IV input is a realized-volatility proxy (trailing 20-day
// daily-return stdev, annualized, x a modest markup for the typical IV-
// over-realized-vol premium) since there's no real historical IV to solve
// against either. Read results as "does this exit-rule shape look
// directionally sound," not "this is the exact dollar P&L a real fill
// would have produced" - same read-the-numbers caveat backtestRun.ts's own
// header already gives for the 0DTE side.
//
// Usage: npx tsx scripts/swingBacktestRun.ts [--days 730] [--rsi-oversold 30] [--rsi-overbought 70]

import { readFileSync } from 'fs'
try {
  const env = readFileSync('.env.local', 'utf8')
  for (const line of env.split(/\r?\n/)) {
    if (!line.includes('=')) continue
    const i = line.indexOf('=')
    const key = line.slice(0, i).trim()
    let value = line.slice(i + 1).trim()
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
    if (key && !(key in process.env)) process.env[key] = value
  }
} catch {}

const { supabase } = await import('../server/supabaseAdmin.js')
const { fetchDailyHistory } = await import('../server/backtest/fetchHistory.js')
const { calculateRSI } = await import('../src/lib/technicalIndicators.js')
const { greeksAt, bsPrice, RISK_FREE_RATE } = await import('../server/optionsGreeks.js')

// --- Spec under test (mirrors server/execution/swingPositionSizing.ts -
// not imported directly since that file's constants are meant for live
// dollar-based position sizing, this backtest works in %-of-premium terms
// per contract, same separation Phase 1 vs Phase 2 already uses in
// backtestRun.ts) ---
const PROFIT_TARGET_PCT = 0.30
const STOP_LOSS_PCT = 0.35
const DAYS_TO_EXPIRY_FORCE_CLOSE = 3
const TARGET_DAYS_OUT = 17
const DELTA_BAND = { min: 0.30, max: 0.50 }
const RSI_PERIOD = 14
const REALIZED_VOL_WINDOW_DAYS = 20
// Typical options trade at a premium to trailing realized vol (a real,
// well-documented market effect - the "volatility risk premium") - this
// is a reasoned approximation, not a measured one, same caveat as the rest
// of this file's IV-proxy approach.
const IV_MARKUP = 1.20

const args = process.argv.slice(2)
const daysArg = args.includes('--days') ? parseInt(args[args.indexOf('--days') + 1], 10) : 730
// Live thresholds (scan-swings.ts) are 30/70 - overridable here to test
// looser oversold/overbought bands without touching the live scanner.
const RSI_OVERSOLD = args.includes('--rsi-oversold') ? parseInt(args[args.indexOf('--rsi-oversold') + 1], 10) : 30
const RSI_OVERBOUGHT = args.includes('--rsi-overbought') ? parseInt(args[args.indexOf('--rsi-overbought') + 1], 10) : 70

const nearestFriday = (from: Date, targetDaysOut: number): Date => {
  const target = new Date(from.getTime() + targetDaysOut * 24 * 60 * 60 * 1000)
  const day = target.getDay() // 0=Sun..6=Sat
  const diffToFriday = (5 - day + 7) % 7
  target.setDate(target.getDate() + diffToFriday)
  return target
}

const realizedVol = (closes: number[], endIndex: number): number | null => {
  const start = endIndex - REALIZED_VOL_WINDOW_DAYS
  if (start < 0) return null
  const returns: number[] = []
  for (let i = start + 1; i <= endIndex; i++) {
    returns.push(Math.log(closes[i] / closes[i - 1]))
  }
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length
  const variance = returns.reduce((a, b) => a + (b - mean) * (b - mean), 0) / returns.length
  return Math.sqrt(variance) * Math.sqrt(252) * IV_MARKUP
}

interface Position {
  symbol: string
  direction: 'bullish' | 'bearish'
  entryIndex: number
  entryDate: string
  entryPremium: number
  strike: number
  expirationDate: Date
}

interface ClosedTrade extends Position {
  exitDate: string
  exitPremium: number
  pctMove: number
  status: 'target' | 'stop' | 'time_exit' | 'open_at_end'
}

const closedTrades: ClosedTrade[] = []

const { data: universeRows } = await supabase.from('sector_universe').select('symbol')
const symbols = (universeRows ?? []).map(r => r.symbol)
console.log(`Backtesting swing exit rules over ${symbols.length} symbols, ${daysArg} days, RSI oversold<${RSI_OVERSOLD}/overbought>${RSI_OVERBOUGHT}`)

const end = new Date().toISOString().slice(0, 10)
const start = new Date(Date.now() - daysArg * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

let symbolsProcessed = 0
for (const symbol of symbols) {
  const candles = await fetchDailyHistory(symbol, `${start}T00:00:00Z`, `${end}T23:59:59Z`)
  if (candles.length < RSI_PERIOD + REALIZED_VOL_WINDOW_DAYS + 5) continue

  const closes = candles.map(c => c.close)
  const rsiValues = calculateRSI(closes, RSI_PERIOD)
  const rsiOffset = closes.length - rsiValues.length

  let openPosition: Position | null = null
  let prevDirection: 'bullish' | 'bearish' | null = null

  for (let i = rsiOffset; i < closes.length; i++) {
    const rsiIndex = i - rsiOffset
    const rsi = rsiValues[rsiIndex]
    const direction: 'bullish' | 'bearish' | null = rsi < RSI_OVERSOLD ? 'bullish' : rsi > RSI_OVERBOUGHT ? 'bearish' : null
    const dateStr = candles[i].datetime
    const spot = closes[i]

    // --- Manage any open position first (same-bar entry/exit never
    // double-counts a bar, mirrors the day-trading backtest's own
    // walk-forward convention of resolving existing state before new
    // signals) ---
    if (openPosition) {
      const daysToExpiry = Math.round((openPosition.expirationDate.getTime() - new Date(dateStr).getTime()) / (24 * 60 * 60 * 1000))
      const sigma = realizedVol(closes, i)
      const T = Math.max(daysToExpiry, 1) / 365
      if (sigma !== null) {
        const type = openPosition.direction === 'bullish' ? 'call' : 'put'
        const currentPremium = bsPrice(spot, openPosition.strike, T, RISK_FREE_RATE, sigma, type)
        const pctMove = (currentPremium - openPosition.entryPremium) / openPosition.entryPremium

        let status: ClosedTrade['status'] | null = null
        if (pctMove >= PROFIT_TARGET_PCT) status = 'target'
        else if (pctMove <= -STOP_LOSS_PCT) status = 'stop'
        else if (daysToExpiry <= DAYS_TO_EXPIRY_FORCE_CLOSE) status = 'time_exit'

        if (status) {
          closedTrades.push({ ...openPosition, exitDate: dateStr, exitPremium: currentPremium, pctMove, status })
          openPosition = null
        }
      }
    }

    // --- New entry: only on the FIRST day crossing into oversold/
    // overbought (mirrors scan-swings.ts's own "only notify on new
    // occurrence" gate, extended here to gate a real entry) ---
    if (!openPosition && direction && direction !== prevDirection) {
      const sigma = realizedVol(closes, i)
      if (sigma !== null && sigma > 0) {
        const expirationDate = nearestFriday(new Date(dateStr), TARGET_DAYS_OUT)
        const daysToExpiry = Math.round((expirationDate.getTime() - new Date(dateStr).getTime()) / (24 * 60 * 60 * 1000))
        const T = daysToExpiry / 365
        const type = direction === 'bullish' ? 'call' : 'put'

        // Evaluate whole-dollar strikes in a band around spot, pick
        // whichever's delta lands in [0.30,0.50] closest to 0.40 - same
        // selection rule selectSwingStrike (server/swingOptionSelection.ts)
        // uses live, just against modeled Greeks instead of real listed
        // contracts/quotes.
        const range = Math.max(3, spot * 0.15)
        let best: { strike: number; premium: number; deltaDist: number } | null = null
        for (let strike = Math.round(spot - range); strike <= Math.round(spot + range); strike++) {
          if (strike <= 0) continue
          const greeks = greeksAt(spot, strike, T, RISK_FREE_RATE, sigma, type)
          const absDelta = Math.abs(greeks.delta)
          if (absDelta < DELTA_BAND.min || absDelta > DELTA_BAND.max) continue
          const dist = Math.abs(absDelta - 0.40)
          if (!best || dist < best.deltaDist) {
            best = { strike, premium: bsPrice(spot, strike, T, RISK_FREE_RATE, sigma, type), deltaDist: dist }
          }
        }

        if (best && best.premium > 0.01) {
          openPosition = {
            symbol, direction, entryIndex: i, entryDate: dateStr,
            entryPremium: best.premium, strike: best.strike, expirationDate
          }
        }
      }
    }

    prevDirection = direction
  }

  if (openPosition) {
    closedTrades.push({
      ...openPosition, exitDate: end, exitPremium: openPosition.entryPremium, pctMove: 0, status: 'open_at_end'
    })
  }

  symbolsProcessed++
  if (symbolsProcessed % 20 === 0) console.log(`  ...${symbolsProcessed}/${symbols.length} symbols processed`)
}

// --- Results ---
console.log(`\nEvaluated ${symbolsProcessed} symbols, ${closedTrades.length} total trades (incl. still-open at window end)\n`)

const resolved = closedTrades.filter(t => t.status !== 'open_at_end')
const byStatus = new Map<string, number>()
for (const t of resolved) byStatus.set(t.status, (byStatus.get(t.status) ?? 0) + 1)

console.log('--- Status breakdown ---')
for (const [status, count] of byStatus) console.log(`  ${status}: ${count}`)
console.log(`  open_at_end: ${closedTrades.length - resolved.length}`)

const winners = resolved.filter(t => t.pctMove > 0)
const winRate = resolved.length > 0 ? (winners.length / resolved.length) * 100 : 0
const avgPctMove = resolved.length > 0 ? resolved.reduce((a, t) => a + t.pctMove, 0) / resolved.length * 100 : 0

console.log(`\n--- Overall ---`)
console.log(`Resolved trades: ${resolved.length}`)
console.log(`Win rate: ${winRate.toFixed(1)}%`)
console.log(`Avg premium move: ${avgPctMove.toFixed(1)}%`)

for (const direction of ['bullish', 'bearish'] as const) {
  const subset = resolved.filter(t => t.direction === direction)
  const subWinners = subset.filter(t => t.pctMove > 0)
  const subWinRate = subset.length > 0 ? (subWinners.length / subset.length) * 100 : 0
  const subAvg = subset.length > 0 ? subset.reduce((a, t) => a + t.pctMove, 0) / subset.length * 100 : 0
  console.log(`\n${direction} (${direction === 'bullish' ? 'CALL' : 'PUT'}): ${subset.length} trades, ${subWinRate.toFixed(1)}% win rate, avg ${subAvg.toFixed(1)}% move`)
}

import { writeFileSync, mkdirSync } from 'fs'
mkdirSync('backtest_out', { recursive: true })
const outFile = `backtest_out/swing_${start}_to_${end}_rsi${RSI_OVERSOLD}-${RSI_OVERBOUGHT}.json`
writeFileSync(outFile, JSON.stringify({ start, end, symbolsProcessed, trades: closedTrades }, null, 1))
console.log(`\nFull detail written to ${outFile}`)
