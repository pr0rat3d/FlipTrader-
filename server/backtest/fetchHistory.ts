import { Candle } from '../twelvedata.js'

// Alpaca's market data API, not Twelve Data - confirmed empirically
// 2026-07-15 that historical bars (including the SIP/consolidated-tape
// feed, normally a paid tier) are included with this account at no extra
// cost, rate-limited to 200 req/min rather than metered per request. A
// completely separate quota from Twelve Data's fully-committed per-minute
// budget the live crons depend on - pulling backtest history never
// competes with or risks live signal detection.
const DATA_BASE_URL = process.env.ALPACA_DATA_BASE_URL || 'https://data.alpaca.markets'

const headers = () => ({
  'APCA-API-KEY-ID': process.env.ALPACA_API_KEY_ID || '',
  'APCA-API-SECRET-KEY': process.env.ALPACA_API_SECRET_KEY || ''
})

interface AlpacaBar {
  t: string
  o: number
  h: number
  l: number
  c: number
  v: number
}

const toCandle = (b: AlpacaBar): Candle => ({
  open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v, datetime: b.t
})

const fetchAllBars = async (symbol: string, timeframe: string, start: string, end: string): Promise<AlpacaBar[]> => {
  let all: AlpacaBar[] = []
  let pageToken: string | undefined

  for (let page = 0; page < 500; page++) {
    const url = new URL(`${DATA_BASE_URL}/v2/stocks/${symbol}/bars`)
    url.searchParams.set('timeframe', timeframe)
    url.searchParams.set('start', start)
    url.searchParams.set('end', end)
    url.searchParams.set('limit', '10000')
    // IEX, not SIP - confirmed empirically 2026-07-15/16 that SIP works for
    // older ranges but 403s on recent data ("subscription does not permit
    // querying recent SIP data") on this account's plan. IEX has no such
    // restriction at any recency. Single-exchange rather than the full
    // consolidated tape, but SPY/QQQ/IWM are liquid enough on IEX alone
    // that this shouldn't meaningfully change signal-level patterns
    // (RSI divergence, MACD crosses, daily trend) - fine for this backtest's
    // purpose even if not perfectly tick-complete.
    url.searchParams.set('feed', 'iex')
    url.searchParams.set('adjustment', 'raw')
    if (pageToken) url.searchParams.set('page_token', pageToken)

    const res = await fetch(url.toString(), { headers: headers() })
    if (!res.ok) throw new Error(`Alpaca bars ${symbol} ${timeframe} failed: ${res.status} ${await res.text()}`)

    const json = await res.json()
    all = all.concat(json.bars ?? [])
    pageToken = json.next_page_token
    if (!pageToken) break
  }

  return all
}

export const fetchIntradayHistory = async (symbol: string, start: string, end: string): Promise<Candle[]> =>
  (await fetchAllBars(symbol, '5Min', start, end)).map(toCandle)

export const fetchDailyHistory = async (symbol: string, start: string, end: string): Promise<Candle[]> =>
  (await fetchAllBars(symbol, '1Day', start, end)).map(toCandle)
