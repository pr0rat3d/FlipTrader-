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

// Finnhub's own data occasionally lists the same symbol twice with different
// description casing (e.g. "KEEL INFRASTRUCTURE CORP" and "Keel Infrastructure
// Corp") - title-case ALL-CAPS descriptions for consistency and display them
// as one entry per symbol.
const titleCase = (s: string): string =>
  /[a-z]/.test(s) ? s : s.replace(/\w\S*/g, w => w.charAt(0) + w.slice(1).toLowerCase())

// US-listed stocks/ETFs only - drop exchange-suffixed symbols (e.g. "SPY.AX")
// since Twelve Data's calls elsewhere in this app assume plain US tickers.
export const searchSymbols = async (query: string): Promise<SymbolMatch[]> => {
  try {
    const response = await axios.get(`${BASE_URL}/search`, {
      params: { q: query, token: FINNHUB_API_KEY }
    })

    const results = response.data?.result
    if (!Array.isArray(results)) return []

    const seen = new Set<string>()
    const matches: SymbolMatch[] = []

    for (const r of results) {
      if (r.type !== 'Common Stock' && r.type !== 'ETP') continue
      if (r.symbol.includes('.')) continue
      if (seen.has(r.symbol)) continue
      seen.add(r.symbol)
      matches.push({ symbol: r.symbol, description: titleCase(r.description) })
      if (matches.length >= 10) break
    }

    return matches
  } catch (error) {
    console.error(`Error searching symbols for "${query}":`, error)
    return []
  }
}
