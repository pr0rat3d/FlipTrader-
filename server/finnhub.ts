import axios from 'axios'

const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY
const BASE_URL = 'https://finnhub.io/api/v1'

// Without this, a hung upstream request waits indefinitely (no client-side
// cutoff) and can single-handedly blow through a cron's maxDuration even with
// just one call in the loop - this is what caused a track-profit-targets timeout.
const REQUEST_TIMEOUT_MS = 10_000

export const getQuote = async (symbol: string) => {
  try {
    const response = await axios.get(`${BASE_URL}/quote`, {
      params: { symbol, token: FINNHUB_API_KEY },
      timeout: REQUEST_TIMEOUT_MS
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
      params: { q: query, token: FINNHUB_API_KEY },
      timeout: REQUEST_TIMEOUT_MS
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

export interface USSymbol {
  symbol: string
}

// Full US common-stock candidate list for the market-cap ranking job
// (server/marketCapRanking.ts) - one call returns the whole exchange listing
// (thousands of entries), so this is only ever called once per ranking
// cycle (roughly monthly), never per-scan. `.`-suffixed symbols (share
// classes, warrants, etc. Finnhub sometimes lists separately) and non-
// "Common Stock" types (ETFs, ADRs, units, warrants) are dropped - the
// ranking only cares about real US common stock, matching this app's
// existing options-tradability assumptions elsewhere.
export const listUSCommonStockSymbols = async (): Promise<USSymbol[]> => {
  try {
    const response = await axios.get(`${BASE_URL}/stock/symbol`, {
      params: { exchange: 'US', token: FINNHUB_API_KEY },
      timeout: REQUEST_TIMEOUT_MS
    })
    const results = response.data
    if (!Array.isArray(results)) return []

    return results
      .filter((r: any) => r.type === 'Common Stock' && typeof r.symbol === 'string' && !r.symbol.includes('.'))
      .map((r: any) => ({ symbol: r.symbol }))
  } catch (error) {
    console.error('Error listing US common stock symbols:', error)
    return []
  }
}

export interface CompanyProfile {
  marketCapitalization: number | null
  industry: string | null
}

// Finnhub's free tier has no market-cap SCREENER (confirmed empirically
// 2026-08-24 - /index/constituents 403s, paid-plan only) - this is the only
// free-tier path to a real market cap, one symbol at a time. Rate limit
// confirmed via response headers same day: 60 req/min account-wide, shared
// with getQuote/searchSymbols elsewhere in this app (low volume, not a real
// contention risk) - the ranking job's own batch size is what actually
// respects this, see MARKET_CAP_BATCH_SIZE in marketCapRanking.ts.
export const getCompanyProfile = async (symbol: string): Promise<CompanyProfile | null> => {
  try {
    const response = await axios.get(`${BASE_URL}/stock/profile2`, {
      params: { symbol, token: FINNHUB_API_KEY },
      timeout: REQUEST_TIMEOUT_MS
    })
    const data = response.data
    if (!data || typeof data !== 'object') return null
    return {
      marketCapitalization: typeof data.marketCapitalization === 'number' ? data.marketCapitalization : null,
      industry: typeof data.finnhubIndustry === 'string' ? data.finnhubIndustry : null
    }
  } catch (error) {
    console.error(`Error fetching company profile for ${symbol}:`, error)
    return null
  }
}
