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
    .order('created_at', { ascending: false })
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
  const { data, error } = await supabase
    .from('user_preferences')
    .upsert({ user_id: userId, ...preferences })
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

export const getTrackedSymbols = async (category: 'day_trade' | 'swing') => {
  const { data, error } = await supabase
    .from('indicator_snapshots')
    .select('symbol')
    .eq('category', category)

  if (error) throw error
  return Array.from(new Set((data || []).map(row => row.symbol))).sort()
}

export const getSectorUniverse = async () => {
  const { data, error } = await supabase
    .from('sector_universe')
    .select('*')
    .order('sector', { ascending: true })

  if (error) throw error
  return data
}
