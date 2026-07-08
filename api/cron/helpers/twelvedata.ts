import axios from 'axios'

const TWELVEDATA_API_KEY = process.env.TWELVEDATA_API_KEY
const BASE_URL = 'https://api.twelvedata.com'

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

// 300 bars: enough lookback for a meaningful EMA200 (not just its seed window).
export const getIntradayCloses = (symbol: string, outputsize: number = 300): Promise<number[] | null> => {
  return fetchCloses(symbol, '5min', outputsize)
}

export const getDailyCloses = (symbol: string, outputsize: number = 300): Promise<number[] | null> => {
  return fetchCloses(symbol, '1day', outputsize)
}
