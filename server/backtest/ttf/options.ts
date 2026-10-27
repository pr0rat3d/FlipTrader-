import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { Attempt } from './engine.js'
import { TtfConfig } from './config.js'

// Real historical 0DTE option prices from Alpaca's options bars endpoint -
// confirmed empirically 2026-10-26 to work on this account's plan for
// expired contracts back to at least 2025-04 (contrary to the older
// assumption in scripts/backtestRun.ts's header that this needed the paid
// Algo Trader Plus plan). These are TRADE bars: no bid/ask, so the spread
// isn't observable - modeled as a flat per-side haircut instead. Minutes
// with no trades have no bar at all.

const DATA_BASE_URL = process.env.ALPACA_DATA_BASE_URL || 'https://data.alpaca.markets'
const CACHE_DIR = 'backtest_out/cache/ttf_options'

interface OptBar { t: number; o: number; c: number }

const headers = () => ({
  'APCA-API-KEY-ID': process.env.ALPACA_API_KEY_ID || '',
  'APCA-API-SECRET-KEY': process.env.ALPACA_API_SECRET_KEY || ''
})

// OCC symbol, e.g. SPY261023C00760000. $1 strikes on 0DTE SPY/QQQ/IWM.
export const occSymbol = (root: string, day: string, type: 'C' | 'P', strike: number): string =>
  `${root}${day.slice(2, 4)}${day.slice(5, 7)}${day.slice(8, 10)}${type}${String(Math.round(strike * 1000)).padStart(8, '0')}`

// nOtm-th strike strictly out of the money from spot (calls above, puts below).
export const otmStrike = (spot: number, type: 'C' | 'P', nOtm: number): number =>
  type === 'C' ? Math.floor(spot) + nOtm : Math.ceil(spot) - nOtm

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export const fetchOptionDay = async (contract: string, day: string): Promise<OptBar[]> => {
  mkdirSync(CACHE_DIR, { recursive: true })
  const file = `${CACHE_DIR}/${contract}.json`
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'))
  const url = new URL(`${DATA_BASE_URL}/v1beta1/options/bars`)
  url.searchParams.set('symbols', contract)
  url.searchParams.set('timeframe', '1Min')
  url.searchParams.set('start', `${day}T13:00:00Z`)
  url.searchParams.set('end', `${day}T21:00:00Z`)
  url.searchParams.set('limit', '10000')
  for (let tries = 0; ; tries++) {
    const res = await fetch(url.toString(), { headers: headers() })
    if (res.status === 429 && tries < 5) { await sleep(15000); continue }
    if (!res.ok) throw new Error(`Alpaca option bars ${contract} failed: ${res.status} ${await res.text()}`)
    const json = await res.json()
    const bars: OptBar[] = (json.bars?.[contract] ?? []).map((b: { t: string; o: number; c: number }) => ({ t: Date.parse(b.t), o: b.o, c: b.c }))
    writeFileSync(file, JSON.stringify(bars))
    return bars
  }
}

export interface OptionResult {
  nOtm: number
  contract: string
  filled: boolean
  noFillReason?: string
  entryPrice?: number // raw trade price, before haircut
  exitPrices?: Array<{ price: number; contracts: number; stale: boolean }>
  pnlByHaircut?: Record<string, number> // dollars, keyed by haircut
  premiumPaid?: number
}

const firstAtOrAfter = (bars: OptBar[], t: number) => bars.find(b => b.t >= t)

export const priceAttempt = (a: Attempt, bars: OptBar[], nOtm: number, contract: string, cfg: TtfConfig): OptionResult => {
  const entryBar = firstAtOrAfter(bars, a.entryT)
  if (!entryBar || entryBar.t > a.entryT + cfg.optionMaxEntryDelayMin * 60000) {
    return { nOtm, contract, filled: false, noFillReason: bars.length ? 'no trade within entry window' : 'no bars for contract' }
  }
  const total = cfg.contractsPerTrade
  let left = total
  const exitPrices = a.exits.map((x, k) => {
    const contracts = k === a.exits.length - 1 ? left : Math.round(x.frac * total)
    left -= contracts
    const b = firstAtOrAfter(bars, x.optionFillT)
    if (b) return { price: b.o, contracts, stale: false }
    const before = [...bars].reverse().find(bb => bb.t < x.optionFillT)
    return { price: before?.c ?? 0, contracts, stale: true }
  })
  const pnlByHaircut: Record<string, number> = {}
  for (const h of cfg.optionHaircuts) {
    pnlByHaircut[h.toFixed(2)] = exitPrices.reduce(
      (acc, x) => acc + x.contracts * 100 * (Math.max(0, x.price - h) - (entryBar.o + h)), 0)
  }
  return { nOtm, contract, filled: true, entryPrice: entryBar.o, exitPrices, pnlByHaircut, premiumPaid: entryBar.o * 100 * total }
}

export const contractsFor = (a: Attempt, nOtm: number): string => {
  const type = a.direction === 'bullish' ? 'C' : 'P'
  return occSymbol(a.symbol, a.day, type, otmStrike(a.entryPrice, type, nOtm))
}
