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

export const saveUserPreferences = async (userId: string, preferences: any) => {
  const { data, error } = await supabase
    .from('user_preferences')
    .upsert({ user_id: userId, ...preferences })
    .select()

  if (error) throw error
  return data
}
