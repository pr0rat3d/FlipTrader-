import { SymbolSeries } from './candles.js'
import { TrendlineEngine, Line, LineLogEntry, TrendlineParams } from './trendlines.js'
import { TtfConfig, Variant, Direction } from './config.js'

// Per-session, per-bar setup state for one symbol. Every flag at local
// index i only uses information available at the CLOSE of bar i.
export interface DayFlags {
  symbol: string
  day: string
  start: number // global index of the session's first bar
  n: number
  minute: number[]
  ttf: Record<Direction, boolean[]> // instantaneous TTF (all three RSIs)
  curl: Record<Direction, boolean[]>
  touch: Record<Direction, boolean[]>
  div: Record<Direction, boolean[]>
  active: Record<Direction, (Line | null)[]>
  engines: Record<Direction, TrendlineEngine>
  trendDay: boolean
}

export const dayRanges = (s: SymbolSeries): Map<string, { start: number; end: number }> => {
  const out = new Map<string, { start: number; end: number }>()
  s.bars.forEach((b, i) => {
    const r = out.get(b.day)
    if (r) r.end = i + 1
    else out.set(b.day, { start: i, end: i + 1 })
  })
  return out
}

export const computeDayFlags = (s: SymbolSeries, start: number, end: number, cfg: TtfConfig, tl: TrendlineParams): DayFlags => {
  const n = end - start
  const mk = () => new Array<boolean>(n).fill(false)
  const flags: DayFlags = {
    symbol: s.symbol, day: s.bars[start].day, start, n,
    minute: s.bars.slice(start, end).map(b => b.minute),
    ttf: { bullish: mk(), bearish: mk() },
    curl: { bullish: mk(), bearish: mk() },
    touch: { bullish: mk(), bearish: mk() },
    div: { bullish: mk(), bearish: mk() },
    active: { bullish: new Array(n).fill(null), bearish: new Array(n).fill(null) },
    engines: { bullish: new TrendlineEngine('bullish', tl), bearish: new TrendlineEngine('bearish', tl) },
    trendDay: Math.abs(s.bars[end - 1].close - s.bars[start].open) / s.bars[start].open > 0.01
  }
  const slope = (g: number) => s.macd1[g] - s.macd1[g - 1]
  const eps = cfg.macdFlatEps

  for (let i = 0; i < n; i++) {
    const g = start + i
    const b = s.bars[g]
    flags.ttf.bullish[i] = s.rsi1[g] < cfg.rsiOversold && s.rsi3[g] < cfg.rsiOversold && s.rsi5[g] < cfg.rsiOversold
    flags.ttf.bearish[i] = s.rsi1[g] > cfg.rsiOverbought && s.rsi3[g] > cfg.rsiOverbought && s.rsi5[g] > cfg.rsiOverbought
    if (g >= 3) {
      flags.curl.bullish[i] = slope(g - 2) < 0 && slope(g - 1) >= -eps && slope(g) >= -eps
      flags.curl.bearish[i] = slope(g - 2) > 0 && slope(g - 1) <= eps && slope(g) <= eps
    }
    for (const dir of ['bullish', 'bearish'] as const) {
      const eng = flags.engines[dir]
      eng.step({ t: b.t, high: b.high, low: b.low, close: b.close, atr: s.atr[g] })
      flags.active[dir][i] = eng.active
      flags.touch[dir][i] = eng.isTouch(i)
      const sw = eng.swings
      if (sw.length >= 2) {
        const s1 = sw[sw.length - 2]
        const s2 = sw[sw.length - 1]
        const r1 = s.rsi1[start + s1.idx]
        const r2 = s.rsi1[start + s2.idx]
        flags.div[dir][i] = dir === 'bullish' ? s2.price < s1.price && r2 > r1 : s2.price > s1.price && r2 < r1
      }
    }
  }
  return flags
}

export const ttfActiveAt = (f: DayFlags, dir: Direction, i: number, bars: number): boolean => {
  for (let j = Math.max(0, i - bars + 1); j <= i; j++) if (f.ttf[dir][j]) return true
  return false
}

export interface RawSignal {
  symbol: string
  day: string
  i: number
  t: number
  minute: number
  direction: Direction
  variants: Variant[] // which variants' entry conditions passed on this bar
  indexCount: number
  divergenceBlocked: boolean
  conditions: { ttfActive: boolean; curl: boolean; touch: boolean; div: boolean }
}

// Per-bar condition snapshot for a direction - also used by the human-log
// validation to report which conditions passed/failed.
export const conditionsAt = (f: DayFlags, dir: Direction, i: number, cfg: TtfConfig) => ({
  ttfActive: ttfActiveAt(f, dir, i, cfg.ttfActiveBars),
  curl: f.curl[dir][i],
  touch: f.touch[dir][i],
  div: f.div[dir][i]
})

const variantsPassing = (c: ReturnType<typeof conditionsAt>): Variant[] => {
  const out: Variant[] = []
  if (c.ttfActive && c.curl) {
    out.push('A')
    if (c.touch) {
      out.push('B')
      if (c.div) out.push('C')
    }
  }
  return out
}

// All bars where at least variant A's conditions pass, across symbols of
// one day (needed together for index count + divergence filter). Not
// gated by time/attempts - that's the simulator's job.
export const rawSignalsForDay = (days: DayFlags[], cfg: TtfConfig, s: Map<string, SymbolSeries>): RawSignal[] => {
  const byMinute = days.map(f => new Map(f.minute.map((m, i) => [m, i])))
  const out: RawSignal[] = []
  days.forEach((f, k) => {
    for (let i = 0; i < f.n; i++) {
      for (const dir of ['bullish', 'bearish'] as const) {
        const c = conditionsAt(f, dir, i, cfg)
        const variants = variantsPassing(c)
        if (!variants.length) continue
        const opp: Direction = dir === 'bullish' ? 'bearish' : 'bullish'
        let indexCount = 0
        let divergenceBlocked = false
        days.forEach((g, kk) => {
          const j = byMinute[kk].get(f.minute[i])
          if (j === undefined) return
          if (ttfActiveAt(g, dir, j, cfg.ttfActiveBars)) indexCount++
          if (kk !== k && ttfActiveAt(g, opp, j, cfg.ttfActiveBars)) divergenceBlocked = true
        })
        out.push({
          symbol: f.symbol, day: f.day, i, t: s.get(f.symbol)!.bars[f.start + i].t, minute: f.minute[i],
          direction: dir, variants, indexCount, divergenceBlocked, conditions: c
        })
      }
    }
  })
  return out.sort((a, b) => a.t - b.t)
}

export interface ExitFill {
  t: number // underlying bar start where the fill happens
  optionFillT: number // when the option leg is filled (next 1m bar open after the trigger)
  price: number
  frac: number
  reason: 'ema50' | 'stop_pct' | 'stop_line' | 'macd' | 'time' | 'session_end'
}

export interface Attempt {
  variant: Variant
  startMinute: number
  symbol: string
  day: string
  direction: Direction
  signalT: number
  entryT: number
  entryPrice: number
  initialStop: number
  risk: number
  points: number
  r: number
  exits: ExitFill[]
  indexCount: number
  timeBucket: string
  trendDay: boolean
  lineId: number | null
  line: { aT: number; aPrice: number; bT: number; bPrice: number } | null
  entryIdx: number // session-local
  exitIdx: number
}

export const timeBucket = (minute: number): string =>
  minute < 630 ? '10:00-10:30' : minute < 660 ? '10:30-11:00' : minute < 720 ? '11:00-12:00' : minute < 840 ? '12:00-14:00' : '14:00-15:30'

// Simulate one variant/start-time over one day. One open position per
// symbol at a time (no averaging down), max N attempts per symbol per day.
export const simulateDay = (
  signals: RawSignal[], days: Map<string, DayFlags>, series: Map<string, SymbolSeries>,
  variant: Variant, startMinute: number, cfg: TtfConfig
): Attempt[] => {
  const attempts: Attempt[] = []
  const busyUntil = new Map<string, number>() // symbol -> session-local exit idx
  const count = new Map<string, number>()

  for (const sig of signals) {
    if (!sig.variants.includes(variant)) continue
    if (sig.minute < startMinute || sig.minute >= cfg.lastEntryMinutes) continue
    if (cfg.divergenceFilter && sig.divergenceBlocked) continue
    if ((count.get(sig.symbol) ?? 0) >= cfg.maxAttemptsPerSymbolDay) continue
    if ((busyUntil.get(sig.symbol) ?? -1) >= sig.i) continue
    const f = days.get(sig.symbol)!
    const s = series.get(sig.symbol)!
    const e = sig.i + 1
    if (e >= f.n) continue
    const a = runTrade(sig, f, s, e, variant, startMinute, cfg)
    attempts.push(a)
    count.set(sig.symbol, (count.get(sig.symbol) ?? 0) + 1)
    busyUntil.set(sig.symbol, a.exitIdx)
  }
  return attempts
}

const runTrade = (sig: RawSignal, f: DayFlags, s: SymbolSeries, e: number, variant: Variant, startMinute: number, cfg: TtfConfig): Attempt => {
  const bull = sig.direction === 'bullish'
  const sg = bull ? 1 : -1
  const G = (i: number) => f.start + i
  const bar = (i: number) => s.bars[G(i)]
  const entry = bar(e).open
  const usesLine = variant !== 'A'
  const line = usesLine ? f.active[sig.direction][sig.i] : null
  const eng = f.engines[sig.direction]

  const pctStop = entry * (1 - sg * cfg.stopPct)
  let initialStop = pctStop
  if (line) {
    const lineStop = eng.lineValue(line, e) - sg * cfg.touchTolAtr * s.atr[G(sig.i)]
    // nearer of the two stops, if it's actually on the losing side of entry
    if (sg * (entry - lineStop) > 0 && sg * (lineStop - pctStop) > 0) initialStop = lineStop
  }
  const risk = Math.abs(entry - initialStop)

  const exits: ExitFill[] = []
  let remaining = 1
  let halfDone = false
  let exitIdx = f.n - 1
  const fill = (i: number, price: number, frac: number, reason: ExitFill['reason'], optionFillT: number) => {
    exits.push({ t: bar(i).t, optionFillT, price, frac, reason })
    remaining -= frac
  }

  for (let x = e; x < f.n && remaining > 1e-9; x++) {
    const b = bar(x)
    const nextOpenT = b.t + 60000
    if (b.minute >= cfg.forceExitMinutes) { fill(x, b.open, remaining, 'time', b.t); exitIdx = x; break }
    // intrabar % stop (stop first if the same bar also tags EMA50)
    if (sg * (pctStop - (bull ? b.low : b.high)) >= 0) {
      const px = bull ? Math.min(b.open, pctStop) : Math.max(b.open, pctStop)
      fill(x, px, remaining, 'stop_pct', nextOpenT); exitIdx = x; break
    }
    const lvl = s.ema50[G(x) - 1]
    if (!halfDone && Number.isFinite(lvl) && sg * ((bull ? b.high : b.low) - lvl) >= 0) {
      const px = bull ? Math.max(b.open, lvl) : Math.min(b.open, lvl)
      fill(x, px, 0.5, 'ema50', nextOpenT)
      halfDone = true
    }
    let pending: ExitFill['reason'] | null = null
    if (line && eng.isBroken(line, x)) pending = 'stop_line'
    else if ((halfDone || cfg.macdExitBeforeTarget) && sg * (s.macd1[G(x)] - s.macd1[G(x) - 1]) < -cfg.macdFlatEps) pending = 'macd'
    if (pending) {
      if (x + 1 < f.n) fill(x + 1, bar(x + 1).open, remaining, pending, bar(x + 1).t)
      else fill(x, b.close, remaining, 'session_end', nextOpenT)
      exitIdx = Math.min(x + 1, f.n - 1)
      break
    }
    if (x === f.n - 1) { fill(x, b.close, remaining, 'session_end', nextOpenT); exitIdx = x }
  }

  const points = exits.reduce((acc, x) => acc + x.frac * sg * (x.price - entry), 0)
  return {
    variant, startMinute, symbol: sig.symbol, day: sig.day, direction: sig.direction,
    signalT: sig.t, entryT: bar(e).t, entryPrice: entry, initialStop, risk, points,
    r: risk > 0 ? points / risk : 0, exits, indexCount: sig.indexCount,
    timeBucket: timeBucket(bar(e).minute), trendDay: f.trendDay,
    lineId: line?.id ?? null,
    line: line ? { aT: line.a.t, aPrice: line.a.price, bT: line.b.t, bPrice: line.b.price } : null,
    entryIdx: e, exitIdx
  }
}

export const lineLogRows = (f: DayFlags): Array<LineLogEntry & { symbol: string; day: string; direction: Direction }> =>
  (['bullish', 'bearish'] as const).flatMap(dir => f.engines[dir].log.map(l => ({ ...l, symbol: f.symbol, day: f.day, direction: dir })))
