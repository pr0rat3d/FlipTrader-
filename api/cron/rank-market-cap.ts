import { VercelRequest, VercelResponse } from '@vercel/node'
import { verifyCronSecret } from '../../server/verifyCronSecret.js'
import { advanceRankingCycle } from '../../server/marketCapRanking.js'

export const config = {
  maxDuration: 60
}

// Periodic top-100-by-market-cap refresh for sector_universe (2026-08-24) -
// see server/marketCapRanking.ts for the full design/reasoning. Deliberately
// NOT gated on isMarketOpen() unlike every trading-signal cron in this app -
// company market cap/industry data is valid any time, and a multi-hour
// batch job (Finnhub's 60/min rate limit against ~8000 US common stocks)
// finishes faster the more hours a day it's allowed to run in, with no
// downside to running outside market hours.
//
// Needs a NEW external cron-job.org job pointing at this endpoint,
// triggered every 1 minute (same minimum as every other cron here) - each
// invocation only advances the cycle by one small step (see
// advanceRankingCycle's phase machine), so it needs to be called
// repeatedly to make progress. Safe to trigger even when nothing is due -
// the idle-phase check below is a cheap single-row read, not a real
// no-op cost.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!verifyCronSecret(req, res)) return

  try {
    const result = await advanceRankingCycle()
    res.status(200).json({ success: true, ...result })
  } catch (error) {
    console.error('Error in rank-market-cap:', error)
    res.status(500).json({ success: false, error: String(error) })
  }
}
