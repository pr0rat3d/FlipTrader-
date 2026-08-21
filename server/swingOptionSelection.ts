import { supabase } from './supabaseAdmin.js'
import { nyDateKey } from './marketHours.js'
import { getAvailableExpirations, listOptionContractsNear, getOptionQuote } from './execution/alpacaClient.js'
import { makeInHouseBlackScholesProvider, GreeksProvider, OptionType } from './optionsGreeks.js'

// Swappable provider (see optionsGreeks.ts's GreeksProvider docstring) - the
// only implementation today wraps a real Alpaca quote + in-house
// Black-Scholes. Swap this single line if/when a real broker-Greeks provider
// (e.g. Schwab Trader API, TDA's actual successor) is ever built.
const greeksProvider: GreeksProvider = makeInHouseBlackScholesProvider(getOptionQuote)

const TARGET_DAYS_OUT = 17 // midpoint of the ~2-3 week window
const PRIMARY_WINDOW_DAYS = { min: 14, max: 21 }
const FALLBACK_WINDOW_DAYS = { min: 7, max: 35 }
const DELTA_BAND = { min: 0.30, max: 0.50 }
// Below this many real trading-day readings, an IV-rank percentile is too
// noisy to trust (a handful of points can make any fresh reading look like
// an extreme) - callers should proceed on RSI alone until this matures,
// rather than block on or trust a rank computed from almost nothing.
const MIN_IV_HISTORY_FOR_RANK = 20

const addDays = (date: Date, days: number): string => {
  const d = new Date(date)
  d.setDate(d.getDate() + days)
  return nyDateKey(d)
}

const nearestExpirationInWindow = async (
  underlyingSymbol: string, contractType: OptionType, today: Date, window: { min: number; max: number }
): Promise<string | null> => {
  const dates = await getAvailableExpirations(underlyingSymbol, contractType, addDays(today, window.min), addDays(today, window.max))
  if (!dates || dates.length === 0) return null

  const targetMs = addDays(today, TARGET_DAYS_OUT)
  let best = dates[0]
  let bestDiff = Math.abs(new Date(dates[0]).getTime() - new Date(targetMs).getTime())
  for (const d of dates) {
    const diff = Math.abs(new Date(d).getTime() - new Date(targetMs).getTime())
    if (diff < bestDiff) { best = d; bestDiff = diff }
  }
  return best
}

export const pickExpirationForSymbol = async (
  underlyingSymbol: string, contractType: OptionType, today: Date = new Date()
): Promise<string | null> => {
  const primary = await nearestExpirationInWindow(underlyingSymbol, contractType, today, PRIMARY_WINDOW_DAYS)
  if (primary) return primary
  return nearestExpirationInWindow(underlyingSymbol, contractType, today, FALLBACK_WINDOW_DAYS)
}

export interface SwingStrikeSelection {
  optionSymbol: string
  strikePrice: number
  expirationDate: string
  delta: number
  gamma: number
  theta: number
  vega: number
  iv: number
  inBand: boolean
}

// Evaluates every candidate contract's REAL delta (via a real quote + the
// in-house solve) and picks whichever actually lands in [0.30, 0.50] closest
// to 0.40 - never assumes the nearest-to-spot strike is the right one, since
// delta moves nonlinearly with both moneyness and this expiry's own time
// value. Falls back to the closest-to-band candidate if none land inside it
// (flagged via `inBand: false` so callers/dashboard can show that plainly).
export const selectSwingStrike = async (
  underlyingSymbol: string, direction: 'bullish' | 'bearish', expirationDate: string, spotPrice: number
): Promise<SwingStrikeSelection | null> => {
  const contractType: OptionType = direction === 'bullish' ? 'call' : 'put'
  const candidates = await listOptionContractsNear(underlyingSymbol, expirationDate, spotPrice, contractType)
  if (candidates.length === 0) return null

  const daysToExpiry = Math.max(1, Math.round((new Date(expirationDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
  const T = daysToExpiry / 365

  const evaluated: SwingStrikeSelection[] = []
  for (const contract of candidates) {
    const result = await greeksProvider.getGreeksForContract(contract.symbol, spotPrice, contract.strikePrice, T, contractType)
    if (!result) continue
    evaluated.push({
      optionSymbol: contract.symbol, strikePrice: contract.strikePrice, expirationDate,
      delta: result.delta, gamma: result.gamma, theta: result.theta, vega: result.vega, iv: result.iv,
      inBand: Math.abs(result.delta) >= DELTA_BAND.min && Math.abs(result.delta) <= DELTA_BAND.max
    })
  }
  if (evaluated.length === 0) return null

  const inBand = evaluated.filter(e => e.inBand)
  if (inBand.length > 0) {
    return inBand.reduce((best, e) => Math.abs(Math.abs(e.delta) - 0.40) < Math.abs(Math.abs(best.delta) - 0.40) ? e : best)
  }
  // Nothing landed in-band - return whichever candidate's delta is closest to
  // the band overall (closest edge), still flagged inBand: false.
  const distanceToBand = (delta: number) => {
    const abs = Math.abs(delta)
    if (abs < DELTA_BAND.min) return DELTA_BAND.min - abs
    if (abs > DELTA_BAND.max) return abs - DELTA_BAND.max
    return 0
  }
  return evaluated.reduce((best, e) => distanceToBand(e.delta) < distanceToBand(best.delta) ? e : best)
}

export interface IvRankResult {
  rank: number
  sampleSize: number
}

// Percentile rank of a FRESH implied-vol reading (just computed by
// selectSwingStrike, not yet written to indicator_snapshots for today)
// against this symbol's own trailing history there (category='swing') -
// grows naturally as more daily readings accumulate rather than requiring a
// hardcoded 52-week window up front. Returns null below
// MIN_IV_HISTORY_FOR_RANK prior readings - too little history for a rank to
// mean anything yet (callers should proceed on RSI alone during this
// cold-start period, not block on or trust a rank from a handful of points).
export const computeIvRank = async (symbol: string, currentIv: number): Promise<IvRankResult | null> => {
  const { data, error } = await supabase
    .from('indicator_snapshots')
    .select('implied_vol')
    .eq('symbol', symbol)
    .eq('category', 'swing')
    .not('implied_vol', 'is', null)
    .order('timestamp', { ascending: true })

  if (error || !data || data.length < MIN_IV_HISTORY_FOR_RANK) return null

  const priorValues = data.map(r => r.implied_vol as number)
  const values = [...priorValues, currentIv]
  const low = Math.min(...values)
  const high = Math.max(...values)
  if (high === low) return { rank: 50, sampleSize: values.length }

  const rank = ((currentIv - low) / (high - low)) * 100
  return { rank, sampleSize: values.length }
}

export interface SwingOpportunity {
  strike: SwingStrikeSelection
  ivRank: IvRankResult | null
  rationale: string
}

// One-call orchestration for scan-swings.ts: expiration -> strike/Greeks ->
// IV rank -> rationale text. Returns null if no tradable expiration/contract
// was found at all (an illiquid symbol, or Alpaca has nothing listed) - the
// caller still has a valid RSI-only alert to fall back on in that case.
export const evaluateSwingOpportunity = async (
  symbol: string, direction: 'bullish' | 'bearish', spotPrice: number, rsi: number
): Promise<SwingOpportunity | null> => {
  const contractType: OptionType = direction === 'bullish' ? 'call' : 'put'
  const expirationDate = await pickExpirationForSymbol(symbol, contractType)
  if (!expirationDate) return null

  const strike = await selectSwingStrike(symbol, direction, expirationDate, spotPrice)
  if (!strike) return null

  const ivRank = await computeIvRank(symbol, strike.iv)
  const ivPct = (strike.iv * 100).toFixed(0)
  const rationale = direction === 'bullish'
    ? `Oversold bounce (RSI ${rsi.toFixed(1)}) - IV ${ivPct}%${ivRank ? `, rank ${ivRank.rank.toFixed(0)}%` : ' (rank building history)'}, ${(strike.delta).toFixed(2)}Δ ${expirationDate} $${strike.strikePrice} call`
    : `Overbought pullback (RSI ${rsi.toFixed(1)}) - IV ${ivPct}%${ivRank ? `, rank ${ivRank.rank.toFixed(0)}%` : ' (rank building history)'}, ${(strike.delta).toFixed(2)}Δ ${expirationDate} $${strike.strikePrice} put`

  return { strike, ivRank, rationale }
}
