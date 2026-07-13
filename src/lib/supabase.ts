import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing Supabase credentials')
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey)

export const subscribeToAlerts = (callback: (alert: any) => void) => {
  return supabase
    .channel('day_trade_alerts')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'day_trade_alerts' }, callback)
    .subscribe()
}

export const subscribeToSwingAlerts = (callback: (alert: any) => void) => {
  return supabase
    .channel('swing_trade_alerts')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'swing_trade_alerts' }, callback)
    .subscribe()
}

export const subscribeToProfitTargets = (callback: (target: any) => void) => {
  return supabase
    .channel('profit_targets')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'profit_targets' }, callback)
    .subscribe()
}

export const getAlerts = async () => {
  const { data, error } = await supabase
    .from('day_trade_alerts')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(50)

  if (error) throw error
  return data
}

export const getSwingAlerts = async () => {
  const { data, error } = await supabase
    .from('swing_trade_alerts')
    .select('*')
    .order('oversold_date', { ascending: false })
    .limit(20)

  if (error) throw error
  return data
}

export const getProfitTargets = async () => {
  const { data, error } = await supabase
    .from('profit_targets')
    .select('*')
    .order('created_at', { ascending: false })

  if (error) throw error
  return data
}

export const getProfitTargetsForAlert = async (alertId: string) => {
  const { data, error } = await supabase
    .from('profit_targets')
    .select('*')
    .eq('day_trade_alert_id', alertId)

  if (error) throw error
  return data
}

export const getIndicatorSnapshots = async (symbol: string, limit = 60) => {
  const { data, error } = await supabase
    .from('indicator_snapshots')
    .select('*')
    .eq('symbol', symbol)
    .order('timestamp', { ascending: false })
    .limit(limit)

  if (error) throw error
  return (data || []).reverse()
}

// Minutes a timezone is offset from UTC at a given instant (positive = ahead
// of UTC) - computed by rendering the instant's wall-clock time in that zone,
// re-interpreting those same numbers as if they were UTC, and diffing against
// the true UTC instant. Standard technique for converting a timezone's local
// midnight to a UTC instant without a date library.
const tzOffsetMinutes = (date: Date, timeZone: string): number => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(date)

  const get = (type: string) => Number(parts.find(p => p.type === type)?.value)
  const asUTC = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
  return (asUTC - date.getTime()) / 60_000
}

// Start of the current NY calendar day, expressed as a UTC ISO timestamp.
const startOfTodayNY = (): string => {
  const now = new Date()
  const offsetMinutes = tzOffsetMinutes(now, 'America/New_York')

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now)
  const get = (type: string) => Number(parts.find(p => p.type === type)?.value)

  const nyMidnightAsUTCNumbers = Date.UTC(get('year'), get('month') - 1, get('day'), 0, 0, 0)
  return new Date(nyMidnightAsUTCNumbers - offsetMinutes * 60_000).toISOString()
}

// Day-trade-specific: scoped to TODAY (NY calendar day) rather than a fixed
// row count, so a symbol scanned every ~1 min doesn't get truncated to the
// last hour - a clicked pattern from earlier today needs to land on a point
// the chart actually rendered. Swing keeps using getIndicatorSnapshots (one
// row/day, a row-count cap already spans months of history).
export const getTodayIndicatorSnapshots = async (symbol: string, category: 'day_trade' | 'swing') => {
  const { data, error } = await supabase
    .from('indicator_snapshots')
    .select('*')
    .eq('symbol', symbol)
    .eq('category', category)
    .gte('timestamp', startOfTodayNY())
    .order('timestamp', { ascending: true })

  if (error) throw error
  return data || []
}

export const subscribeToIndicatorSnapshots = (symbol: string, callback: (row: any) => void) => {
  return supabase
    .channel(`indicator_snapshots:${symbol}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'indicator_snapshots', filter: `symbol=eq.${symbol}` },
      callback
    )
    .subscribe()
}

export const saveUserPreferences = async (userId: string, preferences: any) => {
  // onConflict must be explicit: user_preferences' primary key is `id` (a fresh
  // UUID every insert), not `user_id` - without this, upsert() targets the
  // primary key by default, never conflicts, and every save after the first
  // fails with a duplicate-key error on the separate UNIQUE(user_id) constraint.
  const { data, error } = await supabase
    .from('user_preferences')
    .upsert({ user_id: userId, ...preferences }, { onConflict: 'user_id' })
    .select()

  if (error) throw error
  return data
}

export const getUserPreferences = async (userId: string) => {
  const { data, error } = await supabase
    .from('user_preferences')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle()

  if (error) throw error
  return data
}

export const getWatchlist = async (userId: string, type?: 'day_trade' | 'swing') => {
  let query = supabase.from('watchlists').select('*').eq('user_id', userId)
  if (type) query = query.eq('type', type)

  const { data, error } = await query.order('created_at', { ascending: false })
  if (error) throw error
  return data
}

export const addWatchlistSymbol = async (userId: string, symbol: string, type: 'day_trade' | 'swing') => {
  const { data, error } = await supabase
    .from('watchlists')
    .insert({ user_id: userId, symbol, type })
    .select()

  if (error) throw error
  return data
}

export const removeWatchlistSymbol = async (id: string) => {
  const { error } = await supabase.from('watchlists').delete().eq('id', id)
  if (error) throw error
}

// Reflects the CURRENT active scanning universe (sector filters + follows),
// not just "has ever had a snapshot" - a deselected sector's symbols should
// disappear from the picker even though their historical rows still exist.
export const getActiveUniverse = async (category: 'day_trade' | 'swing'): Promise<string[]> => {
  const response = await fetch(`/api/tracked-universe?category=${category}`)
  const data = await response.json()
  return data.symbols || []
}

export const getSectorUniverse = async () => {
  const { data, error } = await supabase
    .from('sector_universe')
    .select('*')
    .order('sector', { ascending: true })

  if (error) throw error
  return data
}

// Swing snapshots are deduped to one row per symbol per trading day (see
// snapshot.ts), so a modest limit comfortably covers several recent days across
// the whole tracked universe - grouped/sorted per symbol client-side by the caller.
export const getRecentSwingSnapshots = async (symbols: string[], limit = 500) => {
  if (symbols.length === 0) return []
  const { data, error } = await supabase
    .from('indicator_snapshots')
    .select('*')
    .eq('category', 'swing')
    .in('symbol', symbols)
    .order('timestamp', { ascending: false })
    .limit(limit)

  if (error) throw error
  return data
}

export const getExecutionSettings = async () => {
  const { data, error } = await supabase
    .from('execution_settings')
    .select('*')
    .eq('id', 1)
    .single()

  if (error) throw error
  return data
}

export const setExecutionEnabled = async (isEnabled: boolean) => {
  const { error } = await supabase
    .from('execution_settings')
    .update({ is_enabled: isEnabled, updated_at: new Date().toISOString() })
    .eq('id', 1)

  if (error) throw error
}

export const getDailyLevelsForSymbols = async (symbols: string[]) => {
  if (symbols.length === 0) return []
  // trading_date is stored in NY calendar-day terms (server's nyDateKey) - must
  // match that here, not a naive UTC date slice, which would be wrong for several
  // hours around midnight UTC (e.g. evenings in the US).
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date())
  const { data, error } = await supabase
    .from('daily_levels')
    .select('symbol, pdh, pdl, pdc, avg_volume_20d')
    .in('symbol', symbols)
    .eq('trading_date', today)

  if (error) throw error
  return data
}
