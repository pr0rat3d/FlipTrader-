import { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from './helpers/supabaseAdmin.js'
import { calculateRSI } from '../../src/lib/technicalIndicators.js'
import { getDailyCloses } from './helpers/twelvedata.js'
import { sendToTopic } from './helpers/firebase-notify.js'
import { ALERTS_TOPIC } from '../register-token.js'
import { verifyCronSecret } from './helpers/verifyCronSecret.js'
import { recordSnapshot } from './helpers/snapshot.js'
import { pickBatch } from './helpers/batching.js'

// Twelve Data's free tier allows 8 credits/minute account-wide, shared with
// scan-day-trades.ts (3 credits, every 5 min during market hours). This job's
// cron-job.org schedule is offset (7,22,37,52 * * * *) so it never lands on
// the same wall-clock minute as the day-trade job's */5 grid - 7 mod 5 = 2,
// and adding 15 repeatedly never changes that residue, so the offset holds
// permanently. 6 total budget here (well under the remaining 8-3=5... actually
// this job never overlaps the day-trade job at all, so its full 8-credit
// budget is technically available, but staying at 6 leaves headroom against
// scheduler jitter).
//
// Twelve Data's daily interval only updates once/day, so running this more
// often than daily doesn't fetch fresher data - the batching exists purely to
// cycle a >8-symbol universe through the fixed per-minute credit budget. Don't
// "optimize" this away under the belief it's about freshness.
const BATCH_SIZE = 6
const FOLLOWED_RESERVE = 3
const BATCH_INTERVAL_MIN = 15

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!verifyCronSecret(req, res)) return

  try {
    const [{ data: prefRows }, { data: followedRows }, { data: universeRows }] = await Promise.all([
      supabase.from('user_preferences').select('sector_filters'),
      supabase.from('watchlists').select('symbol').eq('type', 'swing'),
      supabase.from('sector_universe').select('symbol, sector')
    ])

    const selectedSectors = new Set<string>()
    for (const row of prefRows || []) {
      for (const sector of row.sector_filters || []) selectedSectors.add(sector)
    }

    const sectorBySymbol: { [symbol: string]: string } = {}
    for (const row of universeRows || []) {
      sectorBySymbol[row.symbol] = row.sector
    }

    const sectorPool = (universeRows || [])
      .filter(row => selectedSectors.has(row.sector))
      .map(row => row.symbol)

    const followedPool = Array.from(new Set((followedRows || []).map(r => r.symbol)))

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
      const closes = await getDailyCloses(symbol)
      if (!closes || closes.length < 14) continue

      await recordSnapshot(symbol, 'swing', closes)

      const rsiValues = calculateRSI(closes, 14)
      const currentRSI = rsiValues[rsiValues.length - 1]

      if (currentRSI < 30) {
        const sector = sectorBySymbol[symbol] || 'other'

        const { error } = await supabase
          .from('swing_trade_alerts')
          .insert({
            symbol,
            rsi_value: currentRSI,
            sector,
            oversold_date: new Date()
          })

        if (!error) {
          oversoldAlerts.push({ symbol, rsi: currentRSI, sector })
          await sendToTopic(
            ALERTS_TOPIC,
            `Swing Alert: ${symbol}`,
            `Oversold at RSI ${currentRSI.toFixed(1)} (${sector})`
          )
        }
      }
    }

    res.status(200).json({ success: true, batch, oversoldAlerts })
  } catch (error) {
    console.error('Error in scan-swings:', error)
    res.status(500).json({ error: String(error) })
  }
}
