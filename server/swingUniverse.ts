import { supabase } from './supabaseAdmin.js'

export interface SwingUniverse {
  sectorPool: string[]
  followedPool: string[]
  sectorBySymbol: { [symbol: string]: string }
}

// Shared between the swing cron scan and the read-only tracked-universe endpoint,
// so the Indicators picker always reflects exactly what's currently eligible to be
// scanned - not stale symbols left over from a sector that's since been deselected.
export const getSwingUniverse = async (): Promise<SwingUniverse> => {
  const [{ data: prefRows }, { data: followedRows }, { data: universeRows }] = await Promise.all([
    supabase.from('user_preferences').select('sector_filters'),
    supabase.from('watchlists').select('symbol').eq('type', 'swing'),
    supabase.from('sector_universe').select('symbol, sector')
  ])

  const selectedSectors = new Set<string>()
  for (const row of prefRows || []) {
    for (const sector of row.sector_filters || []) selectedSectors.add(sector)
  }

  const sectorBySymbol: { [symbol: string]: string } = {}
  for (const row of universeRows || []) {
    sectorBySymbol[row.symbol] = row.sector
  }

  const sectorPool = (universeRows || [])
    .filter(row => selectedSectors.has(row.sector))
    .map(row => row.symbol)

  const followedPool = Array.from(new Set((followedRows || []).map(r => r.symbol)))

  return { sectorPool, followedPool, sectorBySymbol }
}
