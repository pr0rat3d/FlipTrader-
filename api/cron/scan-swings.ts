import { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../server/supabaseAdmin.js'
import { calculateRSI } from '../../src/lib/technicalIndicators.js'
import { getDailyCandles } from '../../server/twelvedata.js'
import { sendToTopic } from '../../server/firebase-notify.js'
import { ALERTS_TOPIC } from '../register-token.js'
import { verifyCronSecret } from '../../server/verifyCronSecret.js'
import { recordSnapshot } from '../../server/snapshot.js'
import { pickBatch } from '../../server/batching.js'
import { getSwingUniverse } from '../../server/swingUniverse.js'
import { getDailyLevels } from '../../server/supportResistance.js'

// Twelve Data's free tier allows 8 credits/minute account-wide, shared with
// scan-confluence.ts (3 credits, but that one now runs every single minute -
// see that file) and scan-day-trades.ts (5 credits, every 5 min). Since
// scan-confluence.ts fires every minute, this job's 3+6=9 credits would have
// exceeded the cap on whichever minute the two coincided - reduced from 6 to 5
// so 3 (confluence, always present) + 5 (this) = 8, the safe ceiling, regardless
// of timing. The 7,22,37,52 offset still avoids colliding with scan-day-trades.ts's
// */5 grid (7 mod 5 = 2, permanent), keeping the worst case at exactly 8, never 13.
//
// Twelve Data's daily interval only updates once/day, so running this more
// often than daily doesn't fetch fresher data - the batching exists purely to
// cycle a >8-symbol universe through the fixed per-minute credit budget. Don't
// "optimize" this away under the belief it's about freshness.
const BATCH_SIZE = 5
const FOLLOWED_RESERVE = 3
const BATCH_INTERVAL_MIN = 15

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!verifyCronSecret(req, res)) return

  try {
    const { sectorPool, followedPool, sectorBySymbol } = await getSwingUniverse()

    // A symbol that drops out of the universe entirely (its sector gets
    // deselected, or it's removed from a swing watchlist) never rotates back
    // into `batch` below - without this, its swing_trade_alerts row would sit
    // forever showing a stale RSI from whenever it was last actually checked,
    // since the refresh/delete logic further down only ever touches symbols
    // still in this run's batch. Cheap (no API cost) so it's safe to run every
    // invocation rather than only occasionally.
    const currentUniverse = new Set([...sectorPool, ...followedPool])
    const { data: existingAlerts } = await supabase.from('swing_trade_alerts').select('symbol')
    const orphanedSymbols = (existingAlerts || [])
      .map(r => r.symbol)
      .filter(symbol => !currentUniverse.has(symbol))
    if (orphanedSymbols.length > 0) {
      await supabase.from('swing_trade_alerts').delete().in('symbol', orphanedSymbols)
    }

    // Reserve slots for followed symbols; backfill unused reservation with sector-pool symbols
    const followedBatch = pickBatch(followedPool, FOLLOWED_RESERVE, BATCH_INTERVAL_MIN)
    const sectorBudget = BATCH_SIZE - followedBatch.length
    const sectorBatch = pickBatch(
      sectorPool.filter(s => !followedBatch.includes(s)),
      sectorBudget,
      BATCH_INTERVAL_MIN
    )

    const batch = Array.from(new Set([...followedBatch, ...sectorBatch]))

    const oversoldAlerts = []

    for (const symbol of batch) {
      const candles = await getDailyCandles(symbol)
      if (!candles || candles.length < 14) continue

      const closes = candles.map(c => c.close)
      await recordSnapshot(symbol, 'swing', candles)

      // Populates daily_levels (PDH/PDL/PDC + 20-day avg volume) for the whole swing
      // universe, not just the day-trade confluence indices - this alone is what
      // unlocks the gap scanner and swing RVOL, reusing the same cache-once-per-day
      // function IV detection already relies on. Passing the candles already fetched
      // above avoids a second API call on a cache-miss - without this, every symbol
      // with a cold cache would silently cost 2 credits instead of 1 in this loop.
      await getDailyLevels(symbol, candles)

      const rsiValues = calculateRSI(closes, 14)
      const currentRSI = rsiValues[rsiValues.length - 1]

      if (currentRSI < 30) {
        const sector = sectorBySymbol[symbol] || 'other'

        // One row per symbol, kept up to date in place - a symbol that stays
        // oversold across many consecutive runs should update its existing card's
        // timestamp/RSI, not stack up a new duplicate card every run.
        const { data: existing } = await supabase
          .from('swing_trade_alerts')
          .select('id')
          .eq('symbol', symbol)
          .maybeSingle()

        const { error } = await supabase
          .from('swing_trade_alerts')
          .upsert(
            { symbol, rsi_value: currentRSI, sector, oversold_date: new Date() },
            { onConflict: 'symbol' }
          )

        if (!error) {
          oversoldAlerts.push({ symbol, rsi: currentRSI, sector })
          // Only notify on a genuinely new oversold occurrence, not every re-fire
          // while the symbol remains oversold across subsequent runs.
          if (!existing) {
            await sendToTopic(
              ALERTS_TOPIC,
              `Swing Alert: ${symbol}`,
              `Oversold at RSI ${currentRSI.toFixed(1)} (${sector})`
            )
          }
        }
      } else {
        // No longer oversold - fall off the list rather than sit there showing a
        // stale RSI from whenever it last triggered.
        await supabase.from('swing_trade_alerts').delete().eq('symbol', symbol)
      }
    }

    res.status(200).json({ success: true, batch, oversoldAlerts })
  } catch (error) {
    console.error('Error in scan-swings:', error)
    res.status(500).json({ error: String(error) })
  }
}
