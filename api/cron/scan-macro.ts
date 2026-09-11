import { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../server/supabaseAdmin.js'
import { verifyCronSecret } from '../../server/verifyCronSecret.js'
import { isMarketOpen, nyDateKey } from '../../server/marketHours.js'
import { getDailyCandles } from '../../server/twelvedata.js'
import { recordSnapshot } from '../../server/snapshot.js'
import { MACRO_SYMBOLS, getCommodityTrend } from '../../server/macroConditions.js'
import { getUpcomingMacroEvents } from '../../server/economicCalendar.js'
import { sendToTopic } from '../../server/firebase-notify.js'
import { ALERTS_TOPIC } from '../register-token.js'

export const config = {
  maxDuration: 60
}

// 10th of Vercel Hobby's 12-function cap. Commodity daily bars only update
// once/day (same reasoning as scan-swings.ts's Twelve Data batching) - the
// pre-check below means this only actually spends a Twelve Data credit once
// per symbol per day, regardless of how often the external cron-job.org
// trigger fires (every 30 min is fine).
const MACRO_EVENT_LOOKAHEAD_DAYS = 5

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!verifyCronSecret(req, res)) return

  try {
    if (!isMarketOpen()) {
      return res.status(200).json({ success: true, skipped: true, reason: 'market closed' })
    }

    const today = nyDateKey(new Date())
    let recorded = 0

    for (const symbol of MACRO_SYMBOLS) {
      const { data: existing } = await supabase
        .from('indicator_snapshots')
        .select('timestamp')
        .eq('symbol', symbol)
        .eq('category', 'macro')
        .order('timestamp', { ascending: false })
        .limit(1)
        .maybeSingle()

      if (existing && nyDateKey(existing.timestamp) === today) continue

      const candles = await getDailyCandles(symbol)
      if (!candles || candles.length < 26) continue

      await recordSnapshot(symbol, 'macro', candles)
      recorded++
    }

    // Only send the digest on the run that actually did the once-daily
    // refresh above - every other invocation this same day is a no-op past
    // this point, avoiding a notification every 30 min.
    if (recorded > 0) {
      const trends = await Promise.all(
        MACRO_SYMBOLS.map(async symbol => `${symbol} ${(await getCommodityTrend(symbol)) ?? 'n/a'}`)
      )
      const events = getUpcomingMacroEvents(MACRO_EVENT_LOOKAHEAD_DAYS)
      const eventText = events.length > 0
        ? events.map(e => `${e.type} in ${e.daysAway}d (${e.date})`).join(', ')
        : `no major events in next ${MACRO_EVENT_LOOKAHEAD_DAYS}d`

      await sendToTopic(ALERTS_TOPIC, 'Macro digest', `${trends.join(', ')} | ${eventText}`)
    }

    res.status(200).json({ success: true, recorded })
  } catch (error) {
    console.error('Error in scan-macro:', error)
    res.status(500).json({ success: false, error: String(error) })
  }
}
