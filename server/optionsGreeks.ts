// In-house Greeks/IV computation for the swing scanner - Alpaca's options
// quote endpoint only returns bid/ask (see alpacaClient.ts's OptionQuote),
// no Greeks or IV, so both are backed out from a REAL observed quote here.
// Deliberately separate from server/backtest/blackScholes.ts, which is
// explicitly calibrated for 0DTE SPY/QQQ/IWM backtesting (ZERO_DTE_IV_MARKUP,
// realized-vol-as-IV-proxy) - mixing multi-week swing-equity option pricing
// into that file would corrupt its calibration. This module's math is the
// same standard Black-Scholes shape, just genuinely generic (any spot,
// strike, T, type), and driven off a real quoted price instead of a modeled
// one.

const A1 = 0.254829592, A2 = -0.284496736, A3 = 1.421413741
const A4 = -1.453152027, A5 = 1.061405429, P = 0.3275911

const erf = (x: number): number => {
  const sign = x < 0 ? -1 : 1
  const ax = Math.abs(x)
  const t = 1 / (1 + P * ax)
  const y = 1 - (((((A5 * t + A4) * t) + A3) * t + A2) * t + A1) * t * Math.exp(-ax * ax)
  return sign * y
}

const normalCdf = (x: number): number => 0.5 * (1 + erf(x / Math.SQRT2))
const normalPdf = (x: number): number => Math.exp(-(x * x) / 2) / Math.sqrt(2 * Math.PI)

export type OptionType = 'call' | 'put'
export const RISK_FREE_RATE = 0.05
const MIN_TIME_TO_EXPIRY_YEARS = 1 / 365 // floor at 1 day - swing contracts are always multi-day, never 0DTE

const bsPrice = (spot: number, strike: number, T: number, r: number, sigma: number, type: OptionType): number => {
  const d1 = (Math.log(spot / strike) + (r + (sigma * sigma) / 2) * T) / (sigma * Math.sqrt(T))
  const d2 = d1 - sigma * Math.sqrt(T)
  return type === 'call'
    ? spot * normalCdf(d1) - strike * Math.exp(-r * T) * normalCdf(d2)
    : strike * Math.exp(-r * T) * normalCdf(-d2) - spot * normalCdf(-d1)
}

// Bisection solve for the volatility that reproduces the real observed mid
// price - simple and numerically stable across the whole realistic vol range,
// unlike Newton's method which can diverge near-the-money on a flat vega.
// Returns null if the target price is outside what's achievable in
// [1%, 400%] vol (e.g. a bad/crossed quote), rather than returning a
// meaningless extreme value.
export const impliedVolatility = (
  marketMid: number, spot: number, strike: number, T: number, r: number, type: OptionType
): number | null => {
  const t = Math.max(T, MIN_TIME_TO_EXPIRY_YEARS)
  let lo = 0.01, hi = 4.0
  const priceAt = (sigma: number) => bsPrice(spot, strike, t, r, sigma, type)
  if (marketMid <= priceAt(lo) || marketMid >= priceAt(hi)) return null

  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    if (priceAt(mid) < marketMid) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

export interface Greeks {
  delta: number
  gamma: number
  theta: number
  vega: number
}

// Standard closed-form Black-Scholes Greeks, no dividend yield (same
// simplification blackScholes.ts uses - immaterial for a few-week hold on
// this watchlist). Theta returned per-calendar-day (divided by 365), vega
// per 1 percentage-point change in IV (divided by 100) - both the
// conventional units a Greeks display shows, not the raw per-year partials.
export const greeksAt = (spot: number, strike: number, T: number, r: number, sigma: number, type: OptionType): Greeks => {
  const t = Math.max(T, MIN_TIME_TO_EXPIRY_YEARS)
  const sqrtT = Math.sqrt(t)
  const d1 = (Math.log(spot / strike) + (r + (sigma * sigma) / 2) * t) / (sigma * sqrtT)
  const d2 = d1 - sigma * sqrtT

  const delta = type === 'call' ? normalCdf(d1) : normalCdf(d1) - 1
  const gamma = normalPdf(d1) / (spot * sigma * sqrtT)
  const vegaRaw = spot * normalPdf(d1) * sqrtT
  const thetaRaw = type === 'call'
    ? -(spot * normalPdf(d1) * sigma) / (2 * sqrtT) - r * strike * Math.exp(-r * t) * normalCdf(d2)
    : -(spot * normalPdf(d1) * sigma) / (2 * sqrtT) + r * strike * Math.exp(-r * t) * normalCdf(-d2)

  return { delta, gamma, theta: thetaRaw / 365, vega: vegaRaw / 100 }
}

export interface ContractGreeksResult extends Greeks {
  iv: number
  midPrice: number
  bid: number
  ask: number
}

// Swappable provider interface - the only implementation today wraps a real
// Alpaca quote + the in-house solve/Greeks above. If Schwab Trader API
// access is ever approved (TDA's actual successor - TDA itself shut down
// 2024-05-10 and no longer exists to integrate with), a SchwabGreeksProvider
// returning real broker-computed Greeks/IV can implement this same interface
// and be swapped into swingOptionSelection.ts with a one-line change -
// nothing else (the scanner, schema, or dashboard) needs to know which
// provider is in use.
export interface GreeksProvider {
  getGreeksForContract(
    optionSymbol: string, spot: number, strike: number, timeToExpiryYears: number, type: OptionType
  ): Promise<ContractGreeksResult | null>
}

export const makeInHouseBlackScholesProvider = (
  getQuote: (optionSymbol: string) => Promise<{ bid: number; ask: number } | null>
): GreeksProvider => ({
  async getGreeksForContract(optionSymbol, spot, strike, timeToExpiryYears, type) {
    const quote = await getQuote(optionSymbol)
    if (!quote || quote.bid <= 0 || quote.ask <= 0) return null
    const midPrice = (quote.bid + quote.ask) / 2

    const iv = impliedVolatility(midPrice, spot, strike, timeToExpiryYears, RISK_FREE_RATE, type)
    if (iv === null) return null

    const greeks = greeksAt(spot, strike, timeToExpiryYears, RISK_FREE_RATE, iv, type)
    return { ...greeks, iv, midPrice, bid: quote.bid, ask: quote.ask }
  }
})
