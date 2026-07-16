// Approximates option premium from the underlying's price - there's no
// affordable historical OPRA options data source available (see
// report_out and MEMORY for why: real-time/historical OPRA options data on
// Alpaca requires the $99/mo Algo Trader Plus plan, not yet subscribed to).
// This is a MODEL, not a measurement - it won't capture real bid/ask
// spread, liquidity effects, or the exact vol surface a real market maker
// quotes. Read Phase 2 P&L results as "does this entry/exit logic look
// directionally profitable," not "this is the dollar amount the bot would
// have made." Calibrated against 2026-07-15's real fills before being
// trusted for anything more than that - see calibrate.ts.

const A1 = 0.254829592, A2 = -0.284496736, A3 = 1.421413741
const A4 = -1.453152027, A5 = 1.061405429, P = 0.3275911

// Abramowitz & Stegun 7.1.26 approximation of the error function - accurate
// to ~1.5e-7, more than sufficient for a premium ESTIMATE (the model's
// dominant error is the volatility assumption below, not this).
const erf = (x: number): number => {
  const sign = x < 0 ? -1 : 1
  const ax = Math.abs(x)
  const t = 1 / (1 + P * ax)
  const y = 1 - (((((A5 * t + A4) * t) + A3) * t + A2) * t + A1) * t * Math.exp(-ax * ax)
  return sign * y
}

const normalCdf = (x: number): number => 0.5 * (1 + erf(x / Math.SQRT2))

export type OptionType = 'call' | 'put'

// Standard Black-Scholes, no dividend yield (SPY/QQQ/IWM's dividend yield
// over a same-day-to-few-day horizon is negligible for this purpose).
// `timeToExpiryYears` is floored well above zero even as real time-to-
// expiry approaches zero (0DTE near market close) - Black-Scholes is
// numerically degenerate exactly at T=0, and economically an option's
// premium is converging to intrinsic value in that limit anyway, which
// this floor reproduces correctly rather than dividing by zero.
const MIN_TIME_TO_EXPIRY_YEARS = 1 / (365 * 24 * 60) // 1 minute, floor

export const blackScholesPrice = (
  spot: number,
  strike: number,
  timeToExpiryYears: number,
  riskFreeRate: number,
  volatility: number,
  type: OptionType
): number => {
  const T = Math.max(timeToExpiryYears, MIN_TIME_TO_EXPIRY_YEARS)
  const sigma = Math.max(volatility, 0.01) // a literal 0% vol also degenerates the formula

  const d1 = (Math.log(spot / strike) + (riskFreeRate + (sigma * sigma) / 2) * T) / (sigma * Math.sqrt(T))
  const d2 = d1 - sigma * Math.sqrt(T)

  if (type === 'call') {
    return spot * normalCdf(d1) - strike * Math.exp(-riskFreeRate * T) * normalCdf(d2)
  }
  return strike * Math.exp(-riskFreeRate * T) * normalCdf(-d2) - spot * normalCdf(-d1)
}

// A flat, unconditional risk-free rate - not load-bearing at these time
// horizons (T is usually under a day), included only because the formula
// needs one.
export const RISK_FREE_RATE = 0.05

// Realized volatility (annualized) from a trailing window of 5-min closes -
// the closest data-driven proxy available for IV without a real options
// data source. Deliberately NOT the same thing as a real 0DTE option's
// actual implied vol, which typically runs richer than trailing realized
// vol would suggest (0DTE's well-known vol-surface premium) - see
// ZERO_DTE_IV_MARKUP below, which exists specifically to correct for that
// gap rather than pretend it doesn't exist.
export const realizedVolatility = (closes: number[]): number => {
  if (closes.length < 2) return 0.20 // fallback: a reasonable generic equity-index vol

  const logReturns: number[] = []
  for (let i = 1; i < closes.length; i++) {
    logReturns.push(Math.log(closes[i] / closes[i - 1]))
  }

  const mean = logReturns.reduce((a, b) => a + b, 0) / logReturns.length
  const variance = logReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / logReturns.length

  // 5-min bars, ~78 bars/trading day, ~252 trading days/year.
  const barsPerYear = 78 * 252
  return Math.sqrt(variance * barsPerYear)
}

// 0DTE/near-dated options trade at richer implied vol than trailing
// realized vol implies - a documented, well-known effect of the vol
// surface's term structure near expiry, not something this model can
// derive from price history alone. This multiplier is a deliberately
// explicit, adjustable stand-in for that gap rather than a silent
// omission.
//
// Calibrated 2026-07-16 by solving for the REAL implied vol behind 5 real
// fills from 2026-07-15 (bisection against blackScholesPrice, using the
// actual underlying price and time-to-close at each fill's timestamp) and
// comparing it to trailing realized vol at that same moment:
//   SPY 754C  17:01 ET -> 2.56x
//   QQQ 713C  17:19 ET -> 3.07x
//   IWM 295C  17:27 ET -> 2.10x
//   SPY 752C  17:47 ET -> 4.10x
//   QQQ 715C  18:16 ET -> excluded (implied a below-intrinsic-value price -
//     an arbitrage-impossible result, meaning the underlying price sampled
//     at that timestamp didn't actually match the real price at the
//     instant the option filled, not a real data point about vol)
// An initial guess of 1.4x (picked before checking) turned out to be well
// off - the real spread from 4 usable points is 2.1x-4.1x, median ~2.8x.
// That spread is real dispersion in a small sample, not measurement noise
// to average away - treat any single Phase 2 P&L run as reflecting "roughly
// this order of magnitude," not a precise dollar figure. Worth re-
// calibrating with a larger sample once more live days exist.
export const ZERO_DTE_IV_MARKUP = 2.8
