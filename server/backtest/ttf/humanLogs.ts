import { readFileSync } from 'fs'
import { Direction, TtfConfig, Variant } from './config.js'
import { DayFlags, conditionsAt } from './engine.js'
import { nyDayMinute } from './candles.js'

// Logged human TTF trades. CSV header (exact):
//   timestamp,symbol,direction,entry,exit,result
// timestamp: ISO with offset, or "YYYY-MM-DD HH:MM" read as America/New_York.
// direction: bullish|bearish (also accepts long|short, call|put).
// result: free text (win/loss/scratch, or a $/R number) - carried through.
export interface HumanTrade {
  t: number
  day: string
  minute: number
  symbol: string
  direction: Direction
  entry: number
  exit: number
  result: string
}

const parseDirection = (v: string): Direction => {
  const s = v.trim().toLowerCase()
  if (['bullish', 'long', 'call', 'calls', 'bull'].includes(s)) return 'bullish'
  if (['bearish', 'short', 'put', 'puts', 'bear'].includes(s)) return 'bearish'
  throw new Error(`unrecognized direction "${v}"`)
}

// "YYYY-MM-DD HH:MM" in New York -> epoch ms (tries both EST/EDT offsets
// and keeps the one that round-trips).
const parseNyLocal = (s: string): number => {
  const m = s.trim().match(/^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})/)
  if (!m) throw new Error(`bad timestamp "${s}"`)
  for (const off of ['-04:00', '-05:00']) {
    const t = Date.parse(`${m[1]}T${m[2].padStart(2, '0')}:${m[3]}:00${off}`)
    const { day, minute } = nyDayMinute(t)
    if (day === m[1] && minute === parseInt(m[2], 10) * 60 + parseInt(m[3], 10)) return t
  }
  throw new Error(`timestamp not representable in New York time "${s}"`)
}

export const loadHumanLogs = (file: string): HumanTrade[] => {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter(l => l.trim() && !l.trim().startsWith('#'))
  const header = lines[0].split(',').map(h => h.trim().toLowerCase())
  const want = ['timestamp', 'symbol', 'direction', 'entry', 'exit', 'result']
  if (want.some((w, i) => header[i] !== w)) throw new Error(`header must be: ${want.join(',')}`)
  return lines.slice(1).map((line, k) => {
    const c = line.split(',').map(x => x.trim())
    try {
      const raw = c[0]
      const t = /[zZ]|[+-]\d{2}:\d{2}$/.test(raw) ? Date.parse(raw) : parseNyLocal(raw)
      const { day, minute } = nyDayMinute(t)
      return { t, day, minute, symbol: c[1].toUpperCase(), direction: parseDirection(c[2]), entry: Number(c[3]), exit: Number(c[4]), result: c[5] ?? '' }
    } catch (err) {
      throw new Error(`${file} row ${k + 2}: ${(err as Error).message}`)
    }
  })
}

// Deterministic 50/50 split (mulberry32, fixed seed).
export const seededSplit = <T>(items: T[], seed = 42): { tuning: T[]; holdout: T[] } => {
  let a = seed >>> 0
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const shuffled = items.map(x => ({ x, r: rand() })).sort((p, q) => p.r - q.r).map(p => p.x)
  const half = Math.ceil(shuffled.length / 2)
  return { tuning: shuffled.slice(0, half), holdout: shuffled.slice(half) }
}

export interface MatchRow {
  trade: HumanTrade
  matched: boolean // the match variant's full conditions passed within +-window bars, same direction
  nearestOffset: number | null
  bestConditions: ReturnType<typeof conditionsAt> | null // at the bar where the most conditions passed
}

const variantPass = (c: ReturnType<typeof conditionsAt>, v: Variant) =>
  c.ttfActive && c.curl && (v === 'A' || (c.touch && (v === 'B' || c.div)))

export const matchTrades = (
  trades: HumanTrade[], flagsFor: (symbol: string, day: string) => DayFlags | undefined,
  variant: Variant, windowBars: number, cfg: TtfConfig
): MatchRow[] => trades.map(trade => {
  const f = flagsFor(trade.symbol, trade.day)
  if (!f) return { trade, matched: false, nearestOffset: null, bestConditions: null }
  const center = f.minute.findIndex(m => m >= trade.minute)
  if (center < 0) return { trade, matched: false, nearestOffset: null, bestConditions: null }
  let best: ReturnType<typeof conditionsAt> | null = null
  let bestScore = -1
  let nearest: number | null = null
  for (let off = -windowBars; off <= windowBars; off++) {
    const i = center + off
    if (i < 0 || i >= f.n) continue
    const c = conditionsAt(f, trade.direction, i, cfg)
    const score = Number(c.ttfActive) + Number(c.curl) + Number(c.touch) + Number(c.div)
    if (score > bestScore) { bestScore = score; best = c }
    if (variantPass(c, variant) && (nearest === null || Math.abs(off) < Math.abs(nearest))) nearest = off
  }
  return { trade, matched: nearest !== null, nearestOffset: nearest, bestConditions: best }
})

export const matchRate = (rows: MatchRow[]) => (rows.length ? rows.filter(r => r.matched).length / rows.length : 0)
