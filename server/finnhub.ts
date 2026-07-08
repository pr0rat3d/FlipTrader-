import axios from 'axios'

const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY
const BASE_URL = 'https://finnhub.io/api/v1'

export const getQuote = async (symbol: string) => {
  try {
    const response = await axios.get(`${BASE_URL}/quote`, {
      params: { symbol, token: FINNHUB_API_KEY }
    })
    return response.data
  } catch (error) {
    console.error(`Error fetching quote for ${symbol}:`, error)
    return null
  }
}

export interface SymbolMatch {
  symbol: string
  description: string
}

// US-listed stocks/ETFs only - drop exchange-suffixed symbols (e.g. "SPY.AX")
// since Twelve Data's calls elsewhere in this app assume plain US tickers.
export const searchSymbols = async (query: string): Promise<SymbolMatch[]> => {
  try {
    const response = await axios.get(`${BASE_URL}/search`, {
      params: { q: query, token: FINNHUB_API_KEY }
    })

    const results = response.data?.result
    if (!Array.isArray(results)) return []

    return results
      .filter((r: any) => (r.type === 'Common Stock' || r.type === 'ETP') && !r.symbol.includes('.'))
      .slice(0, 10)
      .map((r: any) => ({ symbol: r.symbol, description: r.description }))
  } catch (error) {
    console.error(`Error searching symbols for "${query}":`, error)
    return []
  }
}
