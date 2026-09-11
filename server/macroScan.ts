import { supabase } from './supabaseAdmin.js'
import { nyDateKey } from './marketHours.js'
import { getDailyCandles } from './twelvedata.js'
import { recordSnapshot } from './snapshot.js'
import { MACRO_SYMBOLS, getCommodityTrend } from './macroConditions.js'
import { getUpcomingMacroEvents } from './economicCalendar.js'
import { sendToTopic } from './firebase-notify.js'
import { ALERTS_TOPIC } from '../api/register-token.js'

// Originally its own api/cron/scan-macro.ts, folded into scan-swings.ts's
// invocation instead (2026-09-11) - this repo's api/ directory was already
// at exactly 12 Vercel Hobby functions (9 cron + register-token/symbol-
// search/tracked-universe), not the 9-cron-only count this feature was
// planned against, so adding a 10th standalone function broke the deploy
// outright (build succeeded, "Deploying outputs" failed with zero functions
// listed). Same fix shape as execute-swings.ts absorbing what was originally
// monitor-swing-executions.ts for this identical cap reason.
const MACRO_EVENT_LOOKAHEAD_DAYS = 5

// Commodity daily bars only update once/day (same reasoning as this file's
// caller batches Twelve Data calls) - the pre-check below means this only
// actually spends a Twelve Data credit once per symbol per day, regardless
// of how often scan-swings.ts itself runs.
export const runMacroScan = async (): Promise<{ recorded: number }> => {
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
  // this point, avoiding a notification every scan-swings cycle.
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

  return { recorded }
}
