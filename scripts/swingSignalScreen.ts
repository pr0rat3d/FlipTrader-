// Share-level screen for swing ENTRY signals (2026-10-04). The spread-aware
// options backtest (scripts/swingSpreadBacktest.ts) showed the live RSI<35
// signal beats a random day by only ~0.75pt over 15 days - too thin for any
// options structure to survive spreads. Before building options logic around
// a new signal again, this measures whether the signal has edge as plain
// SHARES, against the two things that fooled the original backtest:
//   - market drift: every return is EXCESS vs SPY over the identical window,
//     then compared to the same universe's any-day excess (the universe is
//     today's top-100 by market cap, so it carries survivorship drift - a
//     random day in these names beats SPY too, and a signal has to beat that)
//   - overfitting: signals are judged on the first and second half of the
//     window separately; one that only works in one half isn't a signal
// Signal-day clustering (selloffs fire dozens of names at once) is handled
// by averaging per entry date first, then taking the t-stat across dates.
//
// Entry at the NEXT day's open after the signal close by default (the signal
// isn't known until the close); --entry close enters at the signal close
// itself, approximating a live scanner that fires late in the session.
// Exit at the close H trading days later. Same symbol can't re-signal until
// its previous window has ended.
//
// Usage: npx tsx scripts/swingSignalScreen.ts [--days 1460] [--entry open|close] [--refresh]

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
type Candle = { open: number; high: number; low: number; close: number; volume: number; datetime: string }

const args = process.argv.slice(2)
const DAYS = args.includes('--days') ? parseInt(args[args.indexOf('--days') + 1], 10) : 1460
const HORIZONS = [5, 10, 15]
const BENCHMARK = 'SPY'
const WARMUP = 200
const ENTRY_AT_CLOSE = args.includes('--entry') && args[args.indexOf('--entry') + 1] === 'close'

// --- Data (split+dividend adjusted, cached) ---
const end = new Date().toISOString().slice(0, 10)
const start = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
mkdirSync('backtest_out', { recursive: true })
const cacheFile = `backtest_out/swing_screen_cache_adj_${start}_to_${end}.json`
let history: Record<string, Candle[]>
if (existsSync(cacheFile) && !args.includes('--refresh')) {
  history = JSON.parse(readFileSync(cacheFile, 'utf8'))
} else {
  const { data, error } = await supabase.from('sector_universe').select('symbol')
  if (error) throw new Error(`sector_universe read failed: ${error.message}`)
  history = {}
  for (const symbol of [BENCHMARK, ...(data ?? []).map(r => r.symbol)]) {
    try {
      history[symbol] = await fetchDailyHistory(symbol, `${start}T00:00:00Z`, `${end}T23:59:59Z`, 'all')
    } catch (e) {
      console.log(`  skip ${symbol}: ${(e as Error).message.slice(0, 80)}`)
    }
  }
  writeFileSync(cacheFile, JSON.stringify(history))
}
const spy = history[BENCHMARK]
if (!spy) throw new Error('no SPY history')
const spyIndex = new Map(spy.map((c, i) => [c.datetime.slice(0, 10), i]))
const symbols = Object.keys(history).filter(s => s !== BENCHMARK)
console.log(`${symbols.length} symbols + ${BENCHMARK}, ${start}..${end} (adjusted), entry at ${ENTRY_AT_CLOSE ? 'signal close' : 'next open'}`)

// --- Indicators ---
const sma = (xs: number[], n: number): (number | null)[] => {
  const out: (number | null)[] = new Array(xs.length).fill(null)
  let sum = 0
  for (let i = 0; i < xs.length; i++) {
    sum += xs[i]
    if (i >= n) sum -= xs[i - n]
    if (i >= n - 1) out[i] = sum / n
  }
  return out
}
const alignedRSI = (closes: number[], period: number): (number | null)[] => {
  const r = calculateRSI(closes, period)
  const offset = closes.length - r.length
  return closes.map((_, i) => (i >= offset ? r[i - offset] : null))
}

interface Ctx {
  c: Candle[]; close: number[]; rsi14: (number | null)[]; rsi2: (number | null)[]
  sma10: (number | null)[]; sma50: (number | null)[]; sma200: (number | null)[]
  spyAbove200: (i: number) => boolean
  rsTopDecile: (i: number) => boolean
}

// Cross-sectional 126-day return rank, per date - for the momentum signal.
const ret126ByDate = new Map<string, number[]>()
for (const s of symbols) {
  const c = history[s]
  for (let i = 126; i < c.length; i++) {
    const d = c[i].datetime.slice(0, 10)
    if (!ret126ByDate.has(d)) ret126ByDate.set(d, [])
    ret126ByDate.get(d)!.push(c[i].close / c[i - 126].close - 1)
  }
}
const decileCut = new Map<string, number>()
for (const [d, rs] of ret126ByDate) {
  if (rs.length < 50) continue
  const sorted = [...rs].sort((a, b) => b - a)
  decileCut.set(d, sorted[Math.floor(sorted.length * 0.1)])
}
const spyClose = spy.map(c => c.close)
const spySma200 = sma(spyClose, 200)

type SignalFn = (x: Ctx, i: number) => boolean
const above200 = (x: Ctx, i: number) => x.sma200[i] !== null && x.close[i] > x.sma200[i]!
const signalDefs: Record<string, SignalFn> = {
  'RSI14<35 cross (LIVE)': (x, i) => (x.rsi14[i] ?? 99) < 35 && (x.rsi14[i - 1] ?? 0) >= 35,
  'RSI14<35 cross + >200SMA': (x, i) => signalDefs['RSI14<35 cross (LIVE)'](x, i) && above200(x, i),
  'RSI14<30 cross': (x, i) => (x.rsi14[i] ?? 99) < 30 && (x.rsi14[i - 1] ?? 0) >= 30,
  'RSI2<10 + >200SMA': (x, i) => (x.rsi2[i] ?? 99) < 10 && above200(x, i),
  'RSI2<5 + >200SMA': (x, i) => (x.rsi2[i] ?? 99) < 5 && above200(x, i),
  'RSI2<5 + >200SMA + SPY>200': (x, i) => signalDefs['RSI2<5 + >200SMA'](x, i) && x.spyAbove200(i),
  '3 down closes + >200SMA': (x, i) => x.close[i] < x.close[i - 1] && x.close[i - 1] < x.close[i - 2] && x.close[i - 2] < x.close[i - 3] && above200(x, i),
  'IBS<0.15 + <10SMA + >200SMA': (x, i) => {
    const { high, low, close } = x.c[i]
    return high > low && (close - low) / (high - low) < 0.15 && x.sma10[i] !== null && close < x.sma10[i]! && above200(x, i)
  },
  'Pullback to 50SMA in uptrend': (x, i) =>
    x.sma50[i] !== null && x.sma200[i] !== null && x.sma50[i]! > x.sma200[i]! &&
    x.c[i].low <= x.sma50[i]! && x.close[i - 1] > x.sma50[i - 1]! && x.close[i] > x.sma200[i]!,
  '55-day closing high breakout': (x, i) => {
    if (i < 56) return false
    const prevMax = Math.max(...x.close.slice(i - 55, i))
    return x.close[i] > prevMax && x.close[i - 1] <= Math.max(...x.close.slice(i - 56, i - 1))
  },
  '252-day closing high breakout': (x, i) => {
    if (i < 253) return false
    return x.close[i] > Math.max(...x.close.slice(i - 252, i)) && x.close[i - 1] <= Math.max(...x.close.slice(i - 253, i - 1))
  },
  'Enters top-decile 126d momentum': (x, i) => x.rsTopDecile(i) && !x.rsTopDecile(i - 1)
}

// --- Evaluate ---
interface Obs { date: string; excess: number }
const results: Record<string, Record<number, Obs[]>> = {}
const baseline: Record<number, Obs[]> = Object.fromEntries(HORIZONS.map(h => [h, []]))
for (const name of Object.keys(signalDefs)) results[name] = Object.fromEntries(HORIZONS.map(h => [h, []]))

const excessAt = (c: Candle[], i: number, h: number): Obs | null => {
  if (i + h >= c.length) return null
  const entryBar = ENTRY_AT_CLOSE ? i : i + 1
  const entryDate = c[entryBar].datetime.slice(0, 10)
  const exitDate = c[i + h].datetime.slice(0, 10)
  const si = spyIndex.get(entryDate), se = spyIndex.get(exitDate)
  if (si === undefined || se === undefined) return null
  const stock = c[i + h].close / (ENTRY_AT_CLOSE ? c[i].close : c[i + 1].open) - 1
  const bench = spy[se].close / (ENTRY_AT_CLOSE ? spy[si].close : spy[si].open) - 1
  return { date: entryDate, excess: stock - bench }
}

for (const s of symbols) {
  const c = history[s]
  if (c.length < WARMUP + 20) continue
  const close = c.map(k => k.close)
  const x: Ctx = {
    c, close, rsi14: alignedRSI(close, 14), rsi2: alignedRSI(close, 2),
    sma10: sma(close, 10), sma50: sma(close, 50), sma200: sma(close, 200),
    spyAbove200: i => {
      const si = spyIndex.get(c[i].datetime.slice(0, 10))
      return si !== undefined && spySma200[si] !== null && spyClose[si] > spySma200[si]!
    },
    rsTopDecile: i => {
      if (i < 126) return false
      const cut = decileCut.get(c[i].datetime.slice(0, 10))
      return cut !== undefined && close[i] / close[i - 126] - 1 >= cut
    }
  }
  for (const h of HORIZONS) {
    for (let i = WARMUP; i < c.length; i += h) {
      const o = excessAt(c, i, h)
      if (o) baseline[h].push(o)
    }
    for (const [name, fn] of Object.entries(signalDefs)) {
      let busyUntil = -1
      for (let i = WARMUP; i < c.length - 1; i++) {
        if (i <= busyUntil || !fn(x, i)) continue
        const o = excessAt(c, i, h)
        if (!o) continue
        results[name][h].push(o)
        busyUntil = i + h
      }
    }
  }
}

// Date-clustered mean + t-stat, minus the universe's any-day excess.
const allDates = [...spyIndex.keys()].slice(WARMUP).sort()
const midDate = allDates[Math.floor(allDates.length / 2)]
const clustered = (obs: Obs[], base: number) => {
  const byDate = new Map<string, number[]>()
  for (const o of obs) byDate.set(o.date, [...(byDate.get(o.date) ?? []), o.excess - base])
  const means = [...byDate.values()].map(v => v.reduce((a, b) => a + b, 0) / v.length)
  const m = means.reduce((a, b) => a + b, 0) / Math.max(means.length, 1)
  const sd = Math.sqrt(means.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(means.length - 1, 1))
  return { mean: m, t: means.length > 1 ? m / (sd / Math.sqrt(means.length)) : 0, n: obs.length, dates: means.length }
}
const avg = (o: Obs[]) => o.reduce((a, b) => a + b.excess, 0) / Math.max(o.length, 1)
const fmt = (v: number) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%`
const years = allDates.length / 252

console.log(`Halves split at ${midDate}. Edge = excess vs SPY minus the universe's any-day excess vs SPY.`)
for (const h of HORIZONS) {
  const base1 = avg(baseline[h].filter(o => o.date < midDate))
  const base2 = avg(baseline[h].filter(o => o.date >= midDate))
  console.log(`\n=== Hold ${h} trading days | any-day excess vs SPY: H1 ${fmt(base1)}, H2 ${fmt(base2)} ===`)
  const rows = Object.entries(results).map(([name, byH]) => {
    const obs = byH[h]
    const a = clustered(obs.filter(o => o.date < midDate), base1)
    const b = clustered(obs.filter(o => o.date >= midDate), base2)
    const win = obs.filter(o => o.excess > 0).length / Math.max(obs.length, 1)
    return {
      signal: name, 'per yr': Math.round(obs.length / years), 'beat SPY': `${(win * 100).toFixed(0)}%`,
      'H1 edge': fmt(a.mean), 'H1 t': +a.t.toFixed(1), 'H2 edge': fmt(b.mean), 'H2 t': +b.t.toFixed(1),
      both: a.mean > 0 && b.mean > 0 && a.t > 2 && b.t > 2 ? 'YES' : ''
    }
  })
  console.table(rows)
}
