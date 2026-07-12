import { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../server/supabaseAdmin.js'
import { getQuote } from '../../server/finnhub.js'
import { verifyCronSecret } from '../../server/verifyCronSecret.js'
import { applyPriceSample, checkExpiry } from '../../server/alertOutcomes.js'

// cron-job.org's free tier has no sub-minute scheduling option, so this still gets
// triggered once a minute externally - but loops internally to get an effective
// ~18s checking cadence within that single invocation instead of only checking
// once. 3 checks x 18s gaps = ~36s elapsed, comfortably under the 60s maxDuration
// requested below. Each open position costs 1 Finnhub call per check; even at 3x
// the previous call volume this stays far under Finnhub's 60 calls/min free tier
// for any realistic number of open positions.
const CHECK_INTERVAL_MS = 18_000
const CHECKS_PER_INVOCATION = 3

// Requests the maximum execution time Vercel allows so the loop above isn't cut
// short mid-cycle.
export const config = {
  maxDuration: 60
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const checkOpenTargets = async (): Promise<{ hit: number; expired: number }> => {
  const { data: targets, error } = await supabase
    .from('profit_targets')
    .select('*')
    .eq('status', 'open')

  if (error) throw error
  if (!targets || targets.length === 0) return { hit: 0, expired: 0 }

  let hit = 0
  let expired = 0
  const now = new Date()

  for (const target of targets) {
    // Cheap check first - no API call needed to close out a stale row from a
    // session that's already ended.
    if (checkExpiry(new Date(target.entry_time), now)) {
      await supabase.from('profit_targets').update({ status: 'expired' }).eq('id', target.id)
      expired++
      continue
    }

    const quote = await getQuote(target.symbol)
    if (!quote || !quote.c) continue

    const update = applyPriceSample(target, quote.c, now)
    if (update) {
      await supabase.from('profit_targets').update(update).eq('id', target.id)
      if (update.status === 'target_hit') hit++
    }
  }

  return { hit, expired }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!verifyCronSecret(req, res)) return

  try {
    let targetsHit = 0
    let targetsExpired = 0

    for (let i = 0; i < CHECKS_PER_INVOCATION; i++) {
      const { hit, expired } = await checkOpenTargets()
      targetsHit += hit
      targetsExpired += expired
      if (i < CHECKS_PER_INVOCATION - 1) await sleep(CHECK_INTERVAL_MS)
    }

    res.status(200).json({ success: true, targetsHit, targetsExpired, checksRun: CHECKS_PER_INVOCATION })
  } catch (error) {
    console.error('Error tracking targets:', error)
    res.status(500).json({ error: String(error) })
  }
}
