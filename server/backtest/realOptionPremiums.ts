import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { nyDateKey } from '../marketHours.js'

// Real historical option prices for the main backtest (2026-10-27) - a
// drop-in replacement for the Black-Scholes premium model in
// optionPnlSimulator.ts, enabled with --real-options. Alpaca's
// /v1beta1/options/bars serves expired contracts on this account's plan
// (confirmed for the TTF backtest back to 2024-10), contrary to the older
// assumption in scripts/backtestRun.ts's header.
//
// These are TRADE bars, not quotes: no bid/ask, so the spread is a flat
// per-side haircut - entries pay (trade price + haircut), every mark and
// exit gets (trade price - haircut). Marks only use 1m bars that have fully
// CLOSED by the decision time (no lookahead); entries fill at the first
// trade at/after the decision time, or not at all if none within
// ENTRY_MAX_DELAY_MIN (a dead contract live would have struggled to fill).

const DATA_BASE_URL = process.env.ALPACA_DATA_BASE_URL || 'https://data.alpaca.markets'
const CACHE_DIR = 'backtest_out/cache/real_options'
const ENTRY_MAX_DELAY_MIN = 3

interface OptBar { t: number; o: number; c: number }

const headers = () => ({
  'APCA-API-KEY-ID': process.env.ALPACA_API_KEY_ID || '',
  'APCA-API-SECRET-KEY': process.env.ALPACA_API_SECRET_KEY || ''
})

// OCC symbol, e.g. SPY261023C00760000.
export const occSymbol = (root: string, day: string, type: 'C' | 'P', strike: number): string =>
  `${root}${day.slice(2, 4)}${day.slice(5, 7)}${day.slice(8, 10)}${type}${String(Math.round(strike * 1000)).padStart(8, '0')}`

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// One request (paginated) for many contracts on one day.
const fetchBars = async (contracts: string[], day: string): Promise<Record<string, OptBar[]>> => {
  const out: Record<string, OptBar[]> = Object.fromEntries(contracts.map(c => [c, []]))
  let pageToken: string | undefined
  for (let page = 0; page < 50; page++) {
    const url = new URL(`${DATA_BASE_URL}/v1beta1/options/bars`)
    url.searchParams.set('symbols', contracts.join(','))
    url.searchParams.set('timeframe', '1Min')
    url.searchParams.set('start', `${day}T13:00:00Z`)
    url.searchParams.set('end', `${day}T21:00:00Z`)
    url.searchParams.set('limit', '10000')
    if (pageToken) url.searchParams.set('page_token', pageToken)
    let res = await fetch(url.toString(), { headers: headers() })
    for (let tries = 0; res.status === 429 && tries < 8; tries++) {
      await sleep(15000)
      res = await fetch(url.toString(), { headers: headers() })
    }
    if (!res.ok) throw new Error(`Alpaca option bars ${day} failed: ${res.status} ${await res.text()}`)
    const json = await res.json()
    for (const [sym, bars] of Object.entries(json.bars ?? {}) as Array<[string, Array<{ t: string; o: number; c: number }>]>) {
      out[sym] = (out[sym] ?? []).concat(bars.map(b => ({ t: Date.parse(b.t), o: b.o, c: b.c })))
    }
    pageToken = json.next_page_token
    if (!pageToken) break
  }
  return out
}

export class RealPremiumSource {
  private bars = new Map<string, OptBar[]>()
  private missing = new Set<string>()
  entriesFilled = 0
  entriesNoTrade = 0

  // barMinutes: the underlying bar size - `timeIso` passed in is a bar's
  // START, and the bot acts on that bar's close.
  constructor(readonly haircut: number, readonly barMinutes: number) {}

  // Loads (from disk cache, or Alpaca) every contract in `strikes` x C/P for
  // one symbol-day. Cached per symbol-day; contracts added later are fetched
  // and merged.
  async loadDay(root: string, day: string, strikes: number[]): Promise<void> {
    mkdirSync(CACHE_DIR, { recursive: true })
    const file = `${CACHE_DIR}/${root}_${day}.json`
    const cached: Record<string, OptBar[]> = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
    const wanted = strikes.flatMap(k => [occSymbol(root, day, 'C', k), occSymbol(root, day, 'P', k)])
    const need = wanted.filter(c => !(c in cached))
    if (need.length) {
      for (let i = 0; i < need.length; i += 50) Object.assign(cached, await fetchBars(need.slice(i, i + 50), day))
      writeFileSync(file, JSON.stringify(cached))
    }
    for (const [c, b] of Object.entries(cached)) this.bars.set(c, b)
  }

  private decisionMs = (timeIso: string) => Date.parse(timeIso) + this.barMinutes * 60000

  private contract = (root: string, timeIso: string, type: 'call' | 'put', strike: number) =>
    occSymbol(root, nyDateKey(timeIso), type === 'call' ? 'C' : 'P', strike)

  // Ask-side entry price, or null = no trade within the entry window.
  entryPremium(root: string, type: 'call' | 'put', strike: number, timeIso: string): number | null {
    const c = this.contract(root, timeIso, type, strike)
    const bars = this.bars.get(c)
    if (!bars) { this.missing.add(c); this.entriesNoTrade++; return null }
    const d = this.decisionMs(timeIso)
    const b = bars.find(x => x.t >= d)
    if (!b || b.t > d + ENTRY_MAX_DELAY_MIN * 60000) { this.entriesNoTrade++; return null }
    this.entriesFilled++
    return b.o + this.haircut
  }

  // Bid-side mark at a bar's close: the last 1m trade bar fully closed by
  // then, but not before the position's own entry fill. Falls back to the
  // entry trade price when nothing has traded since.
  mark(root: string, type: 'call' | 'put', strike: number, entryTimeIso: string, entryPremium: number, timeIso: string): number {
    const bars = this.bars.get(this.contract(root, entryTimeIso, type, strike)) ?? []
    const from = this.decisionMs(entryTimeIso)
    const until = this.decisionMs(timeIso)
    let last: OptBar | undefined
    for (const b of bars) {
      if (b.t + 60000 > until) break
      if (b.t >= from) last = b
    }
    const raw = last ? last.c : entryPremium - this.haircut
    return Math.max(0, raw - this.haircut)
  }

  missingContracts = () => [...this.missing]
}
