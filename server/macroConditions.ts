import { supabase } from './supabaseAdmin.js'

// Liquid ETF proxies for commodities Twelve Data/Alpaca already know how to
// quote/trade like any other symbol - same approach as GLD/SLV, no new data
// provider. Also the swing bot's tradeable-commodity watchlist (see
// watchlists table, type='swing').
export const MACRO_SYMBOLS = ['GLD', 'SLV', 'USO', 'UNG', 'CPER'] as const

export type CommodityTrend = 'up' | 'down' | 'flat'

const TREND_THRESHOLD_PCT = 0.02

// Reads the latest macro-category snapshot recorded by scan-macro.ts and
// classifies trend off the same close/ema_50 columns recordSnapshot already
// populates for every category - no new computation needed.
export const getCommodityTrend = async (symbol: string): Promise<CommodityTrend | null> => {
  const { data } = await supabase
    .from('indicator_snapshots')
    .select('close_price, ema_50')
    .eq('symbol', symbol)
    .eq('category', 'macro')
    .order('timestamp', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!data || data.ema_50 == null) return null
  const pctFromEma = (data.close_price - data.ema_50) / data.ema_50
  if (pctFromEma > TREND_THRESHOLD_PCT) return 'up'
  if (pctFromEma < -TREND_THRESHOLD_PCT) return 'down'
  return 'flat'
}

// Informational-only mapping (rationale text), not used for gating yet - see
// the plan's Phase B note on why sector/commodity correlation needs a
// backtest (scripts/swingBacktestRun.ts) before it drives real entry/skip
// decisions.
const SECTOR_COMMODITY_PROXY: Partial<Record<string, string>> = {
  energy: 'USO',
  materials: 'GLD'
}

export const getSectorCommodityProxy = (sector: string): string | null => SECTOR_COMMODITY_PROXY[sector] ?? null
