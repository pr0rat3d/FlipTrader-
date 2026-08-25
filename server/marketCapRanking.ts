import { supabase } from './supabaseAdmin.js'
import { listUSCommonStockSymbols, getCompanyProfile } from './finnhub.js'

// Periodic (roughly monthly, gated by REFRESH_INTERVAL_DAYS below) job that
// replaces sector_universe's hand-curated 50 with the real top 100 US
// common stocks by market cap - see api/cron/rank-market-cap.ts for the
// per-invocation orchestration, this module holds the actual logic. Split
// into phases (idle -> fetching_symbols -> ranking -> finalizing -> idle)
// persisted in market_cap_ranking_status because a single ranking cycle
// spans HOURS of real time (Finnhub's 60/min rate limit against ~8000
// candidate symbols, Vercel's 60s function duration cap) - one invocation
// can only ever make one small batch of progress.

export const REFRESH_INTERVAL_DAYS = 30
export const TOP_N = 100
// Well under Finnhub's confirmed 60/min limit (2026-08-24) - deliberately
// leaves ~30/min headroom, not just a thin margin: `track-profit-targets.ts`
// calls getQuote once per OPEN day-trade leg every invocation (unbounded by
// this file, scales with however many legs are open on a busy day), plus
// scan-confluence.ts/scan-mag7-iv.ts's 1 VIX quote each. This ranking job
// is a low-priority background refresh (runs once/month) - it should never
// be the thing that pushes live trading's own Finnhub calls into a 429.
export const MARKET_CAP_BATCH_SIZE = 30

// The 10 sectors this app's UI already knows about (user_preferences.
// sector_filters, sector_universe.sector) - every classified symbol must
// land in exactly one of these, never a new/unknown bucket, since the
// frontend sector-filter checkboxes only know these 10.
export type Sector = 'tech' | 'energy' | 'materials' | 'financials' | 'healthcare'
  | 'communications' | 'consumer' | 'industrials' | 'real_estate' | 'utilities'

// Finnhub's finnhubIndustry taxonomy is finer-grained than this app's 10
// broad sectors and isn't published as a fixed enum - keyword-matched
// (case-insensitive substring) against real observed values rather than a
// hardcoded exhaustive list, checked in this specific order since some
// industry strings could match more than one bucket (e.g. "Auto Parts"
// contains neither "auto" nor overlaps, but "Electrical Equipment" could
// read as industrials OR tech - industrials wins by being checked first
// for equipment-type terms). Falls back to 'consumer' (the broadest,
// least-wrong catch-all of the 10) for anything unrecognized rather than
// dropping the symbol - keeps every top-100-by-cap name included even if
// its exact sector bucket is a best guess.
const SECTOR_KEYWORDS: [Sector, string[]][] = [
  ['healthcare', ['health', 'biotech', 'pharma', 'medical', 'drug', 'therapeutic', 'life sciences']],
  ['financials', ['bank', 'insurance', 'financial', 'capital markets', 'asset management', 'credit services']],
  ['real_estate', ['real estate', 'reit']],
  ['utilities', ['utilit', 'electric power', 'water supply']],
  ['energy', ['oil', 'gas', 'energy', 'coal', 'refin']],
  ['materials', ['chemical', 'metals', 'mining', 'steel', 'materials', 'paper', 'packaging']],
  ['industrials', ['industrial', 'aerospace', 'defense', 'machinery', 'construction', 'transportation', 'airline', 'railroad', 'engineering', 'building products']],
  ['communications', ['telecom', 'media', 'communication', 'entertainment', 'broadcasting', 'advertising']],
  ['tech', ['technology', 'software', 'semiconductor', 'internet', 'electronics', 'computer', 'it services']],
  // 'consumer' intentionally has no keyword list - it's the fallback,
  // matched only when nothing else does (retail/restaurants/autos/apparel/
  // consumer goods all naturally land here by falling through).
]

export const classifySector = (finnhubIndustry: string | null): Sector => {
  if (!finnhubIndustry) return 'consumer'
  const lower = finnhubIndustry.toLowerCase()
  for (const [sector, keywords] of SECTOR_KEYWORDS) {
    if (keywords.some(k => lower.includes(k))) return sector
  }
  return 'consumer'
}

interface RankingStatus {
  phase: 'idle' | 'fetching_symbols' | 'ranking' | 'finalizing'
  last_completed_at: string | null
}

const getStatus = async (): Promise<RankingStatus> => {
  const { data } = await supabase.from('market_cap_ranking_status').select('phase, last_completed_at').eq('id', 1).single()
  return data as RankingStatus
}

const setStatus = async (fields: Partial<RankingStatus>) => {
  await supabase.from('market_cap_ranking_status').update(fields).eq('id', 1)
}

const isRefreshDue = (lastCompletedAt: string | null): boolean => {
  if (!lastCompletedAt) return true
  const ageMs = Date.now() - new Date(lastCompletedAt).getTime()
  return ageMs >= REFRESH_INTERVAL_DAYS * 24 * 60 * 60 * 1000
}

export interface RankingStepResult {
  phase: string
  detail: string
}

// One call = one small step of progress, matching every other cron in this
// app's "external trigger drives internal state forward" shape (see
// scan-swings.ts's batching). Idempotent/resumable by construction - if an
// invocation is missed or fails partway, the next one picks up from
// whatever `market_cap_ranking_status`/`market_cap_candidates` state was
// last durably written, never redoing already-checked symbols.
export const advanceRankingCycle = async (): Promise<RankingStepResult> => {
  const status = await getStatus()

  if (status.phase === 'idle') {
    if (!isRefreshDue(status.last_completed_at)) {
      return { phase: 'idle', detail: `not due (last completed ${status.last_completed_at ?? 'never'})` }
    }
    await setStatus({ phase: 'fetching_symbols' })
    return { phase: 'fetching_symbols', detail: 'refresh due, starting new cycle' }
  }

  if (status.phase === 'fetching_symbols') {
    const symbols = await listUSCommonStockSymbols()
    if (symbols.length === 0) {
      // Finnhub call failed - stay in this phase, retried next invocation
      // rather than advancing on empty/bad data.
      return { phase: 'fetching_symbols', detail: 'symbol list fetch failed or empty, will retry' }
    }
    // Full reset: clear any stale candidates from a prior cycle (or a
    // partial fetch this cycle) before inserting the fresh list, so a
    // symbol delisted since the last cycle doesn't linger forever.
    await supabase.from('market_cap_candidates').delete().neq('symbol', '')
    const rows = symbols.map(s => ({ symbol: s.symbol }))
    for (let i = 0; i < rows.length; i += 1000) {
      await supabase.from('market_cap_candidates').insert(rows.slice(i, i + 1000))
    }
    await setStatus({ phase: 'ranking' })
    return { phase: 'ranking', detail: `fetched ${symbols.length} candidate symbols` }
  }

  if (status.phase === 'ranking') {
    const { data: batch } = await supabase
      .from('market_cap_candidates')
      .select('symbol')
      .is('checked_at', null)
      .limit(MARKET_CAP_BATCH_SIZE)

    if (!batch || batch.length === 0) {
      await setStatus({ phase: 'finalizing' })
      return { phase: 'finalizing', detail: 'all candidates checked, ready to compute top 100' }
    }

    for (const { symbol } of batch) {
      const profile = await getCompanyProfile(symbol)
      await supabase.from('market_cap_candidates').update({
        market_cap: profile?.marketCapitalization ?? null,
        industry: profile?.industry ?? null,
        country: profile?.country ?? null,
        checked_at: new Date().toISOString()
      }).eq('symbol', symbol)
    }
    return { phase: 'ranking', detail: `checked ${batch.length} symbols` }
  }

  // finalizing. No country/exchange filter here - found live 2026-08-25
  // that Finnhub's own country/exchange fields are unreliable for
  // distinguishing "real NYSE/NASDAQ-listed ADR" (BABA, TSM, ASML - legit,
  // liquid, belongs in this ranking) from "OTC-only foreign ordinary
  // share" (SSNLF, UNLRF - illiquid, produces degenerate RSI, does NOT
  // belong) - TSM's own profile reports "TAIWAN STOCK EXCHANGE" despite
  // being a genuinely liquid US-listed ADR. The real fix is upstream in
  // listUSCommonStockSymbols (server/finnhub.ts) - OTC-junk tickers never
  // even become candidates, so a plain top-N-by-market-cap here is safe.
  // `country` is still captured/stored for diagnostics, just not filtered
  // on.
  const { data: top } = await supabase
    .from('market_cap_candidates')
    .select('symbol, market_cap, industry')
    .not('market_cap', 'is', null)
    .order('market_cap', { ascending: false })
    .limit(TOP_N)

  if (!top || top.length === 0) {
    // Nothing rankable - don't wipe the existing (working) sector_universe
    // over a failed cycle. Reset to idle so the next due-check tries again
    // fresh rather than getting permanently stuck in finalizing.
    await setStatus({ phase: 'idle' })
    return { phase: 'idle', detail: 'no rankable candidates found, aborted without touching sector_universe' }
  }

  const rows = top.map(t => ({ symbol: t.symbol, sector: classifySector(t.industry) }))
  await supabase.from('sector_universe').delete().neq('symbol', '')
  await supabase.from('sector_universe').insert(rows)
  await setStatus({ phase: 'idle', last_completed_at: new Date().toISOString() })
  return { phase: 'idle', detail: `sector_universe refreshed with top ${rows.length} by market cap` }
}
