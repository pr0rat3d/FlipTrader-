import { VercelRequest } from '@vercel/node'
import { supabase } from './supabaseAdmin.js'

// Records that this cron endpoint was just called, keyed by its path
// basename (e.g. /api/cron/scan-day-trades -> 'scan-day-trades'). Read by
// cron_health() - see migration 030. Never throws: a missed heartbeat must
// not take down the job it's reporting on.
export const recordCronRun = async (req: VercelRequest): Promise<void> => {
  const job = (req.url || '').split('?')[0].split('/').filter(Boolean).pop()
  if (!job) return

  try {
    const { error } = await supabase
      .from('cron_heartbeats')
      .upsert({ job, last_run_at: new Date().toISOString() })
    if (error) console.error(`cron heartbeat failed for ${job}:`, error.message)
  } catch (error) {
    console.error(`cron heartbeat failed for ${job}:`, error)
  }
}
