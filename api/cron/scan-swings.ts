import { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../server/supabaseAdmin.js'
import { getDailyCandles } from '../../server/twelvedata.js'
import { isMarketOpen } from '../../server/marketHours.js'
import { verifyCronSecret } from '../../server/verifyCronSecret.js'
import { recordCronRun } from '../../server/cronHeartbeat.js'
import { recordSnapshot } from '../../server/snapshot.js'
import { pickBatch } from '../../server/batching.js'
import { getSwingUniverse } from '../../server/swingUniverse.js'
import { getDailyLevels } from '../../server/supportResistance.js'
import { runMacroScan } from '../../server/macroScan.js'

// Stock-only daily scanner (2026-10-27). The swing OPTIONS layer (CALL/PUT
// alerts, IV rank, strike selection, push notifications) and the swing
// execution bot were removed - after spreads, the live swing spec lost money
// at every spread level tested (see scripts/swingSpreadBacktest.ts). What's
// left feeds the Scanner tab: a daily snapshot per symbol (close/volume/RSI,
// read for gaps, movers, sector leaders and the RSI<30 daily oversold list)
// plus daily_levels for the gap scanner and RVOL.
//
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
  await recordCronRun(req)

  try {
    // Daily-interval data only updates once/day (see comment above) - without
    // this gate, this cron kept spending credits around the clock re-fetching
    // the same unchanged daily bar every 15 min overnight/weekends, a real
    // contributor to blowing through the free tier's 800-credit/day cap.
    if (!isMarketOpen()) {
      return res.status(200).json({ success: true, skipped: true, reason: 'market closed' })
    }

    // Folded in here rather than its own cron (see macroScan.ts's comment) -
    // independent of the symbol batch below, so it runs every invocation;
    // its own once-per-day dedup means this is a no-op past the first
    // successful run of the day.
    const macroScanResult = await runMacroScan()

    const { sectorPool, followedPool } = await getSwingUniverse()

    // Reserve slots for followed symbols; backfill unused reservation with sector-pool symbols
    const followedBatch = pickBatch(followedPool, FOLLOWED_RESERVE, BATCH_INTERVAL_MIN)
    const sectorBudget = BATCH_SIZE - followedBatch.length
    const sectorBatch = pickBatch(
      sectorPool.filter(s => !followedBatch.includes(s)),
      sectorBudget,
      BATCH_INTERVAL_MIN
    )

    const batch = Array.from(new Set([...followedBatch, ...sectorBatch]))

    for (const symbol of batch) {
      const candles = await getDailyCandles(symbol)
      if (!candles || candles.length < 14) continue

      await recordSnapshot(symbol, 'swing', candles)

      // Populates daily_levels (PDH/PDL/PDC + 20-day avg volume) for the whole swing
      // universe, not just the day-trade confluence indices - this alone is what
      // unlocks the gap scanner and swing RVOL, reusing the same cache-once-per-day
      // function IV detection already relies on. Passing the candles already fetched
      // above avoids a second API call on a cache-miss - without this, every symbol
      // with a cold cache would silently cost 2 credits instead of 1 in this loop.
      await getDailyLevels(symbol, candles)
    }

    res.status(200).json({ success: true, batch, macroRecorded: macroScanResult.recorded })
  } catch (error) {
    console.error('Error in scan-swings:', error)
    res.status(500).json({ error: String(error) })
  }
}
