// Spread-aware swing backtest (2026-10-04). Follow-up to the 10-02 review of
// the live swing account (-80%, $3,000 -> $606): 7 of 9 live losers lost
// 46-78% of premium while the stock moved < +/-1.3% - the -50% stop,
// measured on the bid, was sitting inside the bid/ask spread. The original
// scripts/swingBacktestRun.ts could not see that failure mode at all:
//   - it priced entries AND exits at Black-Scholes mid (zero spread)
//   - it checked target/stop on daily closes only (live stops fire intraday)
//   - it ran a 35% stop (live runs 50%) on ideal ~0.40-delta whole-dollar
//     strikes (live falls back further OTM to fit $600 / 2 contracts)
// This script keeps the same RSI signal + Black-Scholes/realized-vol premium
// model, and fixes those four things so the result can be compared to what
// the live account actually did. CALL side only (PUT was never traded live).
//
// Fill model, per trade:
//   - entry at the signal day's close, paying the ASK = mid + spread/2
//   - every later day, the bid (mid - spread/2) is evaluated at the day's
//     open, low and high (underlying prices plugged into Black-Scholes):
//       open through stop/target -> filled at the open bid (gap)
//       low through stop         -> filled at the stop level
//       high through target      -> filled at the target level
//       both in one day          -> assume stop first (conservative)
//   - spread = max(MIN_SPREAD, spreadPct x mid)
//
// Configs run side by side against one data load; candles are cached to
// backtest_out/ so reruns are fast. Same read-the-numbers caveat as the
// original: modeled premium, not real historical option prices - this is a
// "does the edge survive realistic friction" test, not a dollar forecast.
//
// Usage: npx tsx scripts/swingSpreadBacktest.ts [--days 730] [--rsi-oversold 35] [--refresh]

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
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
type Candle = { open: number; high: number; low: number; close: number; volume: number; datetime: string }

const args = process.argv.slice(2)
const argNum = (name: string, fallback: number) => args.includes(name) ? parseFloat(args[args.indexOf(name) + 1]) : fallback
const DAYS = argNum('--days', 730)
const RSI_OVERSOLD = argNum('--rsi-oversold', 35)
const RSI_PERIOD = 14
const REALIZED_VOL_WINDOW_DAYS = 20
const IV_MARKUP = 1.20
const MIN_SPREAD = 0.05

interface Config {
  name: string
  spreadPct: number
  intraday: boolean
  targetPct: number | null
  stopPct: number | null
  // Exit when the UNDERLYING falls this far below entry spot - a stop the
  // option spread can't trigger. null = off.
  underlyingStopPct: number | null
  dte: number
  deltaTarget: number
  // Live affordability fallback: $600 / MIN_CONTRACTS(2) / 100 = $3.00 ask
  // cap, pick the closest-to-target delta among strikes under it.
  maxAsk: number | null
  forceCloseTradingDays: number
}

const LIVE: Config = {
  name: 'LIVE spec', spreadPct: 0.10, intraday: true, targetPct: 0.30, stopPct: 0.50,
  underlyingStopPct: null, dte: 17, deltaTarget: 0.40, maxAsk: 3.00, forceCloseTradingDays: 3
}
const configs: Config[] = [
  { ...LIVE, name: 'Original backtest (mid, closes, 35% stop)', spreadPct: 0, intraday: false, stopPct: 0.35, maxAsk: null },
  { ...LIVE, name: 'Live spec, 0% spread', spreadPct: 0 },
  { ...LIVE, name: 'Live spec, 5% spread', spreadPct: 0.05 },
  { ...LIVE, name: 'Live spec, 10% spread', spreadPct: 0.10 },
  { ...LIVE, name: 'Live spec, 20% spread', spreadPct: 0.20 },
  { ...LIVE, name: 'Live spec, 40% spread', spreadPct: 0.40 },
  // --- Redesign candidates, all at 10% spread ---
  { ...LIVE, name: 'No $3 ask cap (true ~0.40d)', maxAsk: null },
  { ...LIVE, name: 'Stock stop -3%, no premium stop', stopPct: null, underlyingStopPct: 0.03 },
  { ...LIVE, name: 'Stock stop -5%, no premium stop', stopPct: null, underlyingStopPct: 0.05 },
  { ...LIVE, name: '45 DTE, 0.60d, stock stop -5%', stopPct: null, underlyingStopPct: 0.05, dte: 45, deltaTarget: 0.60, maxAsk: null },
  { ...LIVE, name: '45 DTE, 0.60d, no stop, time exit', stopPct: null, dte: 45, deltaTarget: 0.60, maxAsk: null, forceCloseTradingDays: 21 },
  { ...LIVE, name: '45 DTE, 0.60d, 50% tgt, stock stop -5%', targetPct: 0.50, stopPct: null, underlyingStopPct: 0.05, dte: 45, deltaTarget: 0.60, maxAsk: null }
]

const DAY_MS = 24 * 60 * 60 * 1000
const nearestFriday = (from: Date, targetDaysOut: number): Date => {
  const target = new Date(from.getTime() + targetDaysOut * DAY_MS)
  target.setDate(target.getDate() + ((5 - target.getDay() + 7) % 7))
  return target
}
const tradingDaysBetween = (from: Date, to: Date): number => {
  let n = 0
  for (let d = new Date(from.getTime() + DAY_MS); d <= to; d = new Date(d.getTime() + DAY_MS)) {
    if (d.getDay() !== 0 && d.getDay() !== 6) n++
  }
  return n
}
const strikeIncrement = (spot: number) => spot < 100 ? 1 : spot < 250 ? 2.5 : 5
const spreadOf = (mid: number, pct: number) => Math.max(MIN_SPREAD, pct * mid)
const bidOf = (mid: number, pct: number) => Math.max(0, mid - spreadOf(mid, pct) / 2)
const askOf = (mid: number, pct: number) => mid + spreadOf(mid, pct) / 2

const realizedVol = (closes: number[], endIndex: number): number | null => {
  const start = endIndex - REALIZED_VOL_WINDOW_DAYS
  if (start < 0) return null
  const returns: number[] = []
  for (let i = start + 1; i <= endIndex; i++) returns.push(Math.log(closes[i] / closes[i - 1]))
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length
  const variance = returns.reduce((a, b) => a + (b - mean) * (b - mean), 0) / returns.length
  return Math.sqrt(variance) * Math.sqrt(252) * IV_MARKUP
}

// --- Data load (cached) ---
const end = new Date().toISOString().slice(0, 10)
const start = new Date(Date.now() - DAYS * DAY_MS).toISOString().slice(0, 10)
mkdirSync('backtest_out', { recursive: true })
const cacheFile = `backtest_out/swing_daily_cache_${start}_to_${end}.json`
let history: Record<string, Candle[]>
if (existsSync(cacheFile) && !args.includes('--refresh')) {
  history = JSON.parse(readFileSync(cacheFile, 'utf8'))
  console.log(`Loaded ${Object.keys(history).length} symbols from ${cacheFile}`)
} else {
  const { data: universeRows, error } = await supabase.from('sector_universe').select('symbol')
  if (error) throw new Error(`sector_universe read failed: ${error.message}`)
  history = {}
  for (const { symbol } of universeRows ?? []) {
    try {
      history[symbol] = await fetchDailyHistory(symbol, `${start}T00:00:00Z`, `${end}T23:59:59Z`)
    } catch (e) {
      console.log(`  skip ${symbol}: ${(e as Error).message.slice(0, 80)}`)
    }
  }
  writeFileSync(cacheFile, JSON.stringify(history))
  console.log(`Fetched ${Object.keys(history).length} symbols, cached to ${cacheFile}`)
}

// --- Signals: first day crossing into RSI < threshold (scan-swings.ts's
// new-occurrence gate). Split guard: skip any symbol with a >40% one-day
// close move, since bars are adjustment=raw. ---
interface Signal { symbol: string; i: number }
const signals: Signal[] = []
for (const [symbol, candles] of Object.entries(history)) {
  if (candles.length < RSI_PERIOD + REALIZED_VOL_WINDOW_DAYS + 5) continue
  const closes = candles.map(c => c.close)
  if (closes.some((c, i) => i > 0 && Math.abs(Math.log(c / closes[i - 1])) > Math.log(1.4))) {
    console.log(`  skip ${symbol}: likely split in raw bars`)
    continue
  }
  const rsi = calculateRSI(closes, RSI_PERIOD)
  const offset = closes.length - rsi.length
  let prev = false
  for (let i = offset; i < closes.length; i++) {
    const now = rsi[i - offset] < RSI_OVERSOLD
    if (now && !prev && i >= REALIZED_VOL_WINDOW_DAYS) signals.push({ symbol, i })
    prev = now
  }
}

// --- Stock-only check: does the signal itself have edge? ---
console.log(`\n${signals.length} RSI<${RSI_OVERSOLD} signals, ${start}..${end}`)
console.log('\n--- Underlying forward return from signal close (no options) ---')
for (const h of [5, 10, 15]) {
  const rets = signals
    .filter(s => s.i + h < history[s.symbol].length)
    .map(s => history[s.symbol][s.i + h].close / history[s.symbol][s.i].close - 1)
  const avg = rets.reduce((a, b) => a + b, 0) / rets.length
  const up = rets.filter(r => r > 0).length / rets.length
  console.log(`  +${h} trading days: avg ${(avg * 100).toFixed(2)}%, ${(up * 100).toFixed(1)}% positive (n=${rets.length})`)
}

// --- Simulation ---
interface Trade {
  symbol: string; entryDate: string; exitDate: string; strike: number; entrySpot: number
  entryAsk: number; exitBid: number; pnlPct: number; status: 'target' | 'stop' | 'stock_stop' | 'time_exit'
  daysHeld: number
}

const pickStrike = (spot: number, T: number, sigma: number, cfg: Config, spreadPct: number) => {
  const inc = strikeIncrement(spot)
  let best: { strike: number; mid: number; dist: number } | null = null
  const lo = Math.ceil((spot * 0.7) / inc) * inc
  for (let strike = lo; strike <= spot * 1.3; strike += inc) {
    const delta = greeksAt(spot, strike, T, RISK_FREE_RATE, sigma, 'call').delta
    const mid = bsPrice(spot, strike, T, RISK_FREE_RATE, sigma, 'call')
    if (mid < 0.05) continue
    if (cfg.maxAsk !== null && askOf(mid, spreadPct) > cfg.maxAsk) continue
    const dist = Math.abs(delta - cfg.deltaTarget)
    if (!best || dist < best.dist) best = { strike, mid, dist }
  }
  return best
}

const simulate = (cfg: Config): Trade[] => {
  const trades: Trade[] = []
  const busyUntil = new Map<string, number>() // one open position per symbol
  for (const { symbol, i } of signals) {
    if ((busyUntil.get(symbol) ?? -1) >= i) continue
    const candles = history[symbol]
    const closes = candles.map(c => c.close)
    const sigma0 = realizedVol(closes, i)
    if (!sigma0) continue
    const entryDate = new Date(candles[i].datetime)
    const expiry = nearestFriday(entryDate, cfg.dte)
    const pick = pickStrike(closes[i], (expiry.getTime() - entryDate.getTime()) / DAY_MS / 365, sigma0, cfg, cfg.spreadPct)
    if (!pick) continue
    const entryAsk = askOf(pick.mid, cfg.spreadPct)
    const entrySpot = closes[i]
    const stopLevel = cfg.stopPct !== null ? entryAsk * (1 - cfg.stopPct) : null
    const targetLevel = cfg.targetPct !== null ? entryAsk * (1 + cfg.targetPct) : null
    const stockStop = cfg.underlyingStopPct !== null ? entrySpot * (1 - cfg.underlyingStopPct) : null

    let trade: Trade | null = null
    const close = (j: number, exitBid: number, status: Trade['status']) => {
      trade = {
        symbol, entryDate: candles[i].datetime.slice(0, 10), exitDate: candles[j].datetime.slice(0, 10),
        strike: pick.strike, entrySpot, entryAsk, exitBid, pnlPct: (exitBid - entryAsk) / entryAsk, status, daysHeld: j - i
      }
      busyUntil.set(symbol, j)
    }

    for (let j = i + 1; j < candles.length && !trade; j++) {
      const c = candles[j]
      const day = new Date(c.datetime)
      const T = Math.max((expiry.getTime() - day.getTime()) / DAY_MS, 0.5) / 365
      const sigma = realizedVol(closes, j - 1) ?? sigma0
      const bidAt = (s: number) => bidOf(bsPrice(s, pick.strike, T, RISK_FREE_RATE, sigma, 'call'), cfg.spreadPct)

      if (cfg.intraday) {
        const openBid = bidAt(c.open)
        if (stockStop !== null && c.open <= stockStop) { close(j, openBid, 'stock_stop'); break }
        if (stopLevel !== null && openBid <= stopLevel) { close(j, openBid, 'stop'); break }
        if (targetLevel !== null && openBid >= targetLevel) { close(j, openBid, 'target'); break }
        if (stockStop !== null && c.low <= stockStop) { close(j, bidAt(stockStop), 'stock_stop'); break }
        if (stopLevel !== null && bidAt(c.low) <= stopLevel) { close(j, stopLevel, 'stop'); break }
        if (targetLevel !== null && bidAt(c.high) >= targetLevel) { close(j, targetLevel, 'target'); break }
      } else {
        const closeBid = bidAt(c.close)
        if (targetLevel !== null && closeBid >= targetLevel) { close(j, closeBid, 'target'); break }
        if (stopLevel !== null && closeBid <= stopLevel) { close(j, closeBid, 'stop'); break }
      }
      if (tradingDaysBetween(day, expiry) <= cfg.forceCloseTradingDays) { close(j, bidAt(c.close), 'time_exit'); break }
    }
    if (trade) trades.push(trade)
  }
  return trades
}

const pct = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`
const rows: Record<string, string | number>[] = []
const allResults: Record<string, Trade[]> = {}
for (const cfg of configs) {
  const t = simulate(cfg)
  allResults[cfg.name] = t
  const n = t.length
  const avg = t.reduce((a, x) => a + x.pnlPct, 0) / n
  const sorted = t.map(x => x.pnlPct).sort((a, b) => a - b)
  const gains = t.filter(x => x.pnlPct > 0).reduce((a, x) => a + x.pnlPct, 0)
  const losses = -t.filter(x => x.pnlPct < 0).reduce((a, x) => a + x.pnlPct, 0)
  const count = (s: Trade['status']) => t.filter(x => x.status === s).length
  const sameDayStops = t.filter(x => (x.status === 'stop') && x.daysHeld <= 1).length
  rows.push({
    config: cfg.name, n, win: `${((t.filter(x => x.pnlPct > 0).length / n) * 100).toFixed(1)}%`,
    avg: pct(avg), median: pct(sorted[Math.floor(n / 2)]), pf: (gains / Math.max(losses, 1e-9)).toFixed(2),
    '$/600 pos': Math.round(avg * 600), tgt: count('target'), stop: count('stop') + count('stock_stop'),
    'stop<=1d': sameDayStops, time: count('time_exit')
  })
}
console.log('\n--- Option results (CALL, per trade, entry at ask / exit at bid) ---')
console.table(rows)

const outFile = `backtest_out/swing_spread_${start}_to_${end}_rsi${RSI_OVERSOLD}.json`
writeFileSync(outFile, JSON.stringify({ start, end, rsiOversold: RSI_OVERSOLD, configs, results: allResults }, null, 1))
console.log(`\nFull per-trade detail written to ${outFile}`)
