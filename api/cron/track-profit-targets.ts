import { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../server/supabaseAdmin.js'
import { getQuote } from '../../server/finnhub.js'
import { verifyCronSecret } from '../../server/verifyCronSecret.js'
import { applyPriceSample, checkExpiry } from '../../server/alertOutcomes.js'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!verifyCronSecret(req, res)) return

  try {
    const { data: targets, error: targetError } = await supabase
      .from('profit_targets')
      .select('*')
      .eq('status', 'open')

    if (targetError) throw targetError

    if (!targets || targets.length === 0) {
      return res.status(200).json({ success: true, targetsHit: 0, targetsExpired: 0 })
    }

    let targetsHit = 0
    let targetsExpired = 0
    const now = new Date()

    for (const target of targets) {
      // Cheap check first - no API call needed to close out a stale row from a
      // session that's already ended (this cron has no market-hours gate and runs
      // every minute including nights/weekends, so this matters).
      if (checkExpiry(new Date(target.entry_time), now)) {
        await supabase.from('profit_targets').update({ status: 'expired' }).eq('id', target.id)
        targetsExpired++
        continue
      }

      const quote = await getQuote(target.symbol)
      if (!quote || !quote.c) continue

      const update = applyPriceSample(target, quote.c, now)
      if (update) {
        await supabase.from('profit_targets').update(update).eq('id', target.id)
        if (update.status === 'target_hit') targetsHit++
      }
    }

    res.status(200).json({ success: true, targetsHit, targetsExpired })
  } catch (error) {
    console.error('Error tracking targets:', error)
    res.status(500).json({ error: String(error) })
  }
}
