import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.VITE_SUPABASE_URL
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error('Missing Supabase service role credentials')
}

// Server-only: bypasses RLS, must never be exposed to the frontend bundle.
export const supabase = createClient(supabaseUrl, supabaseServiceRoleKey)
