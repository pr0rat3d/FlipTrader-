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

// Standard OTC Markets Group ticker convention: a 5-letter symbol ending in
// F is an unsponsored "foreign private issuer" ordinary share traded on the
// Pink/Grey OTC tier, ending in Y is an unsponsored OTC ADR - both are
// distinct from a REAL sponsored NYSE/NASDAQ-listed ADR (BABA, TSM, ASML,
// UL, ...), which always has a short, clean ticker with no such suffix.
// Confirmed empirically 2026-08-25: every OTC-junk symbol observed in a
// live ranking cycle (SSNLF/Samsung, UNLRF/Unilever Indonesia, PTPIF, ...)
// matched this exact pattern, while real ADRs (BABA, TSM, ASML) never do -
// a much more reliable signal than Finnhub's own country/exchange fields
// on /stock/profile2, which turned out to be INCONSISTENT for this purpose
// (TSM's profile reports "TAIWAN STOCK EXCHANGE" as its exchange despite
// TSM being a genuinely liquid NYSE-listed ADR - country/exchange reflect
// the company's home listing, not whether THIS ticker is the real US one).
const OTC_FOREIGN_TICKER_PATTERN = /^[A-Z]{4}[FY]$/

// Full US common-stock candidate list for the market-cap ranking job
// (server/marketCapRanking.ts) - one call returns the whole exchange listing
// (thousands of entries), so this is only ever called once per ranking
// cycle (roughly monthly), never per-scan. `.`-suffixed symbols (share
// classes, warrants, etc. Finnhub sometimes lists separately), non-
// "Common Stock" types (ETFs, ADRs, units, warrants), and the OTC-foreign
// ticker pattern above are all dropped before a single market-cap lookup
// happens - cheaper (no wasted API calls on symbols that could never
// belong in a real "top US companies" list) and more correct than filtering
// after the fact.
export const listUSCommonStockSymbols = async (): Promise<USSymbol[]> => {
  try {
    const response = await axios.get(`${BASE_URL}/stock/symbol`, {
      params: { exchange: 'US', token: FINNHUB_API_KEY },
      timeout: REQUEST_TIMEOUT_MS
    })
    const results = response.data
    if (!Array.isArray(results)) return []

    return results
      .filter((r: any) =>
        r.type === 'Common Stock' &&
        typeof r.symbol === 'string' &&
        !r.symbol.includes('.') &&
        !OTC_FOREIGN_TICKER_PATTERN.test(r.symbol)
      )
      .map((r: any) => ({ symbol: r.symbol }))
  } catch (error) {
    console.error('Error listing US common stock symbols:', error)
    return []
  }
}

export interface CompanyProfile {
  marketCapitalization: number | null
  industry: string | null
  country: string | null
}

// Finnhub's free tier has no market-cap SCREENER (confirmed empirically
// 2026-08-24 - /index/constituents 403s, paid-plan only) - this is the only
// free-tier path to a real market cap, one symbol at a time. Rate limit
// confirmed via response headers same day: 60 req/min account-wide, shared
// with getQuote/searchSymbols elsewhere in this app (low volume, not a real
// contention risk) - the ranking job's own batch size is what actually
// respects this, see MARKET_CAP_BATCH_SIZE in marketCapRanking.ts.
//
// `country` is critical, not optional metadata: Finnhub's `exchange=US`
// symbol list (listUSCommonStockSymbols) includes foreign companies traded
// OTC in the US (e.g. SSNLF = Samsung Electronics, country "KR") - their
// marketCapitalization is reported in their HOME currency (KRW for
// Samsung), not consistently USD, so comparing it raw against a real US
// company's USD figure is meaningless (found live 2026-08-25: this bug let
// Samsung/Unilever-Indonesia/etc. outrank every real US mega-cap and fill
// most of a "top 100 US companies" list). `currency === 'USD'` alone isn't
// reliable either - some foreign filers (e.g. an Indonesian company)
// report in USD anyway while still not being a US company - `country`
// is the actual signal callers should filter on.
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
      industry: typeof data.finnhubIndustry === 'string' ? data.finnhubIndustry : null,
      country: typeof data.country === 'string' ? data.country : null
    }
  } catch (error) {
    console.error(`Error fetching company profile for ${symbol}:`, error)
    return null
  }
}
