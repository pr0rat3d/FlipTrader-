import axios from 'axios'
import { Candle } from '../twelvedata.js'

// Without this, a hung upstream request waits indefinitely (no client-side
// cutoff) and can single-handedly blow through a cron's maxDuration - this bit
// track-profit-targets.ts's Finnhub calls once already, so every Alpaca call
// here goes through an instance with the same defensive timeout.
const REQUEST_TIMEOUT_MS = 10_000
const http = axios.create({ timeout: REQUEST_TIMEOUT_MS })

// Every order-placement catch block across execute-alerts.ts and
// monitor-executions.ts used to do `String(e)` on a failed placeOrder call -
// on an AxiosError that only ever produces the generic "Request failed with
// status code 422", discarding Alpaca's actual response body (which almost
// always explains WHY - insufficient buying power, asset not tradable,
// invalid qty, etc.). Found live 2026-07-17: three days of recurring 403/422
// failures (first flagged 2026-07-15) were never root-caused because nothing
// ever captured what Alpaca actually said. Use this instead of String(e) in
// any catch around a placeOrder/cancelOrder/replaceOrder call.
export const describeAlpacaError = (e: unknown): string => {
  if (axios.isAxiosError(e)) {
    const status = e.response?.status
    const data = e.response?.data
    if (data !== undefined) {
      const dataStr = typeof data === 'string' ? data : JSON.stringify(data)
      return `Alpaca ${status ?? '?'}: ${dataStr}`
    }
    return `Alpaca request failed (${status ?? 'no response'}): ${e.message}`
  }
  return String(e)
}

// Env read lazily inside each function (not at module load) so an unrelated
// function importing this module can't crash on missing Alpaca env - same
// reasoning as finnhub.ts's module-level constant, but this module is used
// from crons where a misconfigured Alpaca key must not break market-hours
// scanning if it were ever accidentally imported alongside it.
const tradingHeaders = () => ({
  'APCA-API-KEY-ID': process.env.ALPACA_API_KEY_ID || '',
  'APCA-API-SECRET-KEY': process.env.ALPACA_API_SECRET_KEY || ''
})

const tradingBaseUrl = () => process.env.ALPACA_API_BASE_URL || 'https://paper-api.alpaca.markets'
// Market data API is a separate host from the trading API regardless of
// paper/live - see Alpaca's docs (data.alpaca.markets serves both).
const dataBaseUrl = () => process.env.ALPACA_DATA_BASE_URL || 'https://data.alpaca.markets'

export interface AlpacaAccount {
  equity: number
  buying_power: number
  cash: number
}

export const getAccount = async (): Promise<AlpacaAccount | null> => {
  try {
    const response = await http.get(`${tradingBaseUrl()}/v2/account`, { headers: tradingHeaders() })
    return {
      equity: parseFloat(response.data.equity),
      buying_power: parseFloat(response.data.buying_power),
      cash: parseFloat(response.data.cash)
    }
  } catch (error) {
    console.error('Error fetching Alpaca account:', error)
    return null
  }
}

export interface AlpacaPosition {
  symbol: string
  qty: number
  side: 'long' | 'short'
}

export const getPositions = async (): Promise<AlpacaPosition[] | null> => {
  try {
    const response = await http.get(`${tradingBaseUrl()}/v2/positions`, { headers: tradingHeaders() })
    return response.data.map((p: any) => ({ symbol: p.symbol, qty: parseFloat(p.qty), side: p.side }))
  } catch (error) {
    console.error('Error fetching Alpaca positions:', error)
    return null
  }
}

export interface AlpacaOrder {
  id: string
  client_order_id: string
  symbol: string
  status: string
  side: 'buy' | 'sell'
  type: string
  qty: string
  filled_qty: string
  filled_avg_price: string | null
}

export const getOpenOrders = async (symbol: string): Promise<AlpacaOrder[] | null> => {
  try {
    const response = await http.get(`${tradingBaseUrl()}/v2/orders`, {
      headers: tradingHeaders(),
      params: { status: 'open', symbols: symbol }
    })
    return response.data
  } catch (error) {
    console.error(`Error fetching open orders for ${symbol}:`, error)
    return null
  }
}

export const getOrder = async (orderId: string): Promise<AlpacaOrder | null> => {
  try {
    const response = await http.get(`${tradingBaseUrl()}/v2/orders/${orderId}`, { headers: tradingHeaders() })
    return response.data
  } catch (error) {
    console.error(`Error fetching order ${orderId}:`, error)
    return null
  }
}

export interface PlaceOrderParams {
  symbol: string
  qty: number
  side: 'buy' | 'sell'
  type: 'market' | 'limit' | 'stop'
  timeInForce: 'day' | 'gtc'
  limitPrice?: number
  stopPrice?: number
  clientOrderId: string
}

// Throws on failure - order placement is a critical action the caller must
// handle explicitly (unlike the read functions above, which degrade to null).
export const placeOrder = async (params: PlaceOrderParams): Promise<AlpacaOrder> => {
  const body: Record<string, unknown> = {
    symbol: params.symbol,
    qty: params.qty,
    side: params.side,
    type: params.type,
    time_in_force: params.timeInForce,
    client_order_id: params.clientOrderId
  }
  if (params.limitPrice !== undefined) body.limit_price = params.limitPrice.toFixed(2)
  if (params.stopPrice !== undefined) body.stop_price = params.stopPrice.toFixed(2)

  const response = await http.post(`${tradingBaseUrl()}/v2/orders`, body, { headers: tradingHeaders() })
  return response.data
}

export const cancelOrder = async (orderId: string): Promise<boolean> => {
  try {
    await http.delete(`${tradingBaseUrl()}/v2/orders/${orderId}`, { headers: tradingHeaders() })
    return true
  } catch (error) {
    console.error(`Error cancelling order ${orderId}:`, error)
    return false
  }
}

export interface ReplaceOrderParams {
  qty?: number
  limitPrice?: number
  stopPrice?: number
}

// Throws on failure - callers replacing a resting stop need to know explicitly
// if the replace didn't go through rather than silently continuing as if it did.
export const replaceOrder = async (orderId: string, params: ReplaceOrderParams): Promise<AlpacaOrder> => {
  const body: Record<string, unknown> = {}
  if (params.qty !== undefined) body.qty = params.qty
  if (params.limitPrice !== undefined) body.limit_price = params.limitPrice.toFixed(2)
  if (params.stopPrice !== undefined) body.stop_price = params.stopPrice.toFixed(2)

  const response = await http.patch(`${tradingBaseUrl()}/v2/orders/${orderId}`, body, { headers: tradingHeaders() })
  return response.data
}

export interface AlpacaBar {
  t: string // ISO timestamp
  o: number
  h: number
  l: number
  c: number
  v: number
}

export const getBars1Min = async (symbol: string, start: Date, end: Date): Promise<AlpacaBar[] | null> => {
  try {
    const response = await http.get(`${dataBaseUrl()}/v2/stocks/${symbol}/bars`, {
      headers: tradingHeaders(),
      params: {
        timeframe: '1Min',
        start: start.toISOString(),
        end: end.toISOString(),
        feed: 'iex',
        limit: 50
      }
    })
    return response.data?.bars ?? []
  } catch (error) {
    console.error(`Error fetching 1-min bars for ${symbol}:`, error)
    return null
  }
}

// Live 5-min bars for scan-mag7-iv.ts - deliberately a separate data source
// from twelvedata.ts (used by scan-confluence.ts/scan-day-trades.ts/
// scan-swings.ts), which is already fully committed against its own
// 8-credit/min, 800/day free-tier budget. Alpaca's data API has its own,
// much larger budget (confirmed empirically 2026-07-20: 200 req/window via
// the response's x-ratelimit-limit header) and is already proven reliable
// all week for backtest history - this is the same feed, just for live/
// recent bars instead of a historical range. `feed=iex` confirmed free/
// unrestricted at any recency (checked repeatedly this week; the SIP feed
// 403s on recent dates without a paid subscription, IEX doesn't).
const toCandle = (b: AlpacaBar): Candle => ({
  open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v, datetime: b.t
})

export const getBars5Min = async (symbol: string, lookbackBars: number = 300): Promise<Candle[] | null> => {
  try {
    const end = new Date()
    // ~7 calendar days covers 300 5-min regular-session bars even across a
    // weekend/holiday gap, same margin twelvedata.ts's equivalent uses.
    const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000)
    const response = await http.get(`${dataBaseUrl()}/v2/stocks/${symbol}/bars`, {
      headers: tradingHeaders(),
      params: {
        timeframe: '5Min',
        start: start.toISOString(),
        end: end.toISOString(),
        feed: 'iex',
        limit: lookbackBars,
        sort: 'asc'
      }
    })
    const bars: AlpacaBar[] = response.data?.bars ?? []
    return bars.map(toCandle)
  } catch (error) {
    console.error(`Error fetching 5-min bars for ${symbol}:`, error)
    return null
  }
}

export interface OptionContract {
  symbol: string
  strikePrice: number
}

// Widens the strike search a few dollars around the desired strike rather than
// requiring an exact match - not every whole-dollar strike is necessarily
// listed for every expiration, so this picks the closest one that actually is.
export const findOptionContract = async (
  underlyingSymbol: string,
  expirationDate: string,
  desiredStrike: number,
  contractType: 'call' | 'put'
): Promise<OptionContract | null> => {
  try {
    const response = await http.get(`${tradingBaseUrl()}/v2/options/contracts`, {
      headers: tradingHeaders(),
      params: {
        underlying_symbols: underlyingSymbol,
        expiration_date: expirationDate,
        strike_price_gte: (desiredStrike - 3).toFixed(2),
        strike_price_lte: (desiredStrike + 3).toFixed(2),
        type: contractType,
        status: 'active'
      }
    })
    const contracts: any[] = response.data?.option_contracts ?? []
    if (contracts.length === 0) return null

    let closest = contracts[0]
    let closestDiff = Math.abs(parseFloat(closest.strike_price) - desiredStrike)
    for (const c of contracts) {
      const diff = Math.abs(parseFloat(c.strike_price) - desiredStrike)
      if (diff < closestDiff) {
        closest = c
        closestDiff = diff
      }
    }

    return { symbol: closest.symbol, strikePrice: parseFloat(closest.strike_price) }
  } catch (error) {
    console.error(`Error finding option contract for ${underlyingSymbol} ${expirationDate} ${desiredStrike}${contractType}:`, error)
    return null
  }
}

export interface OptionQuote {
  bid: number
  ask: number
}

export const getOptionQuote = async (optionSymbol: string): Promise<OptionQuote | null> => {
  try {
    const response = await http.get(`${dataBaseUrl()}/v1beta1/options/quotes/latest`, {
      headers: tradingHeaders(),
      params: { symbols: optionSymbol }
    })
    const q = response.data?.quotes?.[optionSymbol]
    if (!q || typeof q.bp !== 'number' || typeof q.ap !== 'number') return null
    return { bid: q.bp, ask: q.ap }
  } catch (error) {
    console.error(`Error fetching option quote for ${optionSymbol}:`, error)
    return null
  }
}

export interface OptionBar {
  t: string
  o: number
  h: number
  l: number
  c: number
  v: number
}

export const getOptionBars1Min = async (optionSymbol: string, start: Date, end: Date): Promise<OptionBar[] | null> => {
  try {
    const response = await http.get(`${dataBaseUrl()}/v1beta1/options/bars`, {
      headers: tradingHeaders(),
      params: {
        symbols: optionSymbol,
        timeframe: '1Min',
        start: start.toISOString(),
        end: end.toISOString(),
        limit: 50
      }
    })
    return response.data?.bars?.[optionSymbol] ?? []
  } catch (error) {
    console.error(`Error fetching option 1-min bars for ${optionSymbol}:`, error)
    return null
  }
}
