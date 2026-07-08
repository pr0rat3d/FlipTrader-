import axios from 'axios'

const TWELVEDATA_API_KEY = process.env.TWELVEDATA_API_KEY
const BASE_URL = 'https://api.twelvedata.com'

export interface Candle {
  open: number
  high: number
  low: number
  close: number
  volume: number
  datetime: string
}

const fetchCloses = async (symbol: string, interval: string, outputsize: number): Promise<number[] | null> => {
  try {
    const response = await axios.get(`${BASE_URL}/time_series`, {
      params: { symbol, interval, outputsize, apikey: TWELVEDATA_API_KEY }
    })

    const values = response.data?.values
    if (!Array.isArray(values)) {
      console.error(`Twelve Data error for ${symbol} (${interval}):`, response.data)
      return null
    }

    // API returns newest-first; reverse to chronological order for indicator math
    return values.map((v: any) => parseFloat(v.close)).reverse()
  } catch (error) {
    console.error(`Error fetching ${interval} candles for ${symbol}:`, error)
    return null
  }
}

// Full OHLCV (needed for VWAP, which requires volume + typical price, not just close).
// Explicit timezone so "which calendar day is this bar from" is unambiguous downstream.
export const getIntradayCandles = async (symbol: string, outputsize: number = 300): Promise<Candle[] | null> => {
  try {
    const response = await axios.get(`${BASE_URL}/time_series`, {
      params: { symbol, interval: '5min', outputsize, timezone: 'America/New_York', apikey: TWELVEDATA_API_KEY }
    })

    const values = response.data?.values
    if (!Array.isArray(values)) {
      console.error(`Twelve Data error for ${symbol} (5min):`, response.data)
      return null
    }

    return values
      .map((v: any) => ({
        open: parseFloat(v.open),
        high: parseFloat(v.high),
        low: parseFloat(v.low),
        close: parseFloat(v.close),
        volume: parseFloat(v.volume),
        datetime: v.datetime
      }))
      .reverse()
  } catch (error) {
    console.error(`Error fetching intraday candles for ${symbol}:`, error)
    return null
  }
}

export const getDailyCloses = (symbol: string, outputsize: number = 300): Promise<number[] | null> => {
  return fetchCloses(symbol, '1day', outputsize)
}
