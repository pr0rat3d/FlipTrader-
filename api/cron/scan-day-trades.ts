import { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../server/supabaseAdmin.js'
import { getIntradayCandles } from '../../server/twelvedata.js'
import { isMarketOpen } from '../../server/marketHours.js'
import { verifyCronSecret } from '../../server/verifyCronSecret.js'
import { recordSnapshot } from '../../server/snapshot.js'
import { calculateSessionVWAP } from '../../server/vwap.js'
import { pickBatch } from '../../server/batching.js'

// TTTF/DTTF/STTF/IV confluence detection moved to scan-confluence.ts, which runs on
// its own faster (every 1 min) schedule - that logic is latency-sensitive, this
// one isn't (followed-ticker chart history doesn't need to be faster than 5 min).
// Keeping this file/endpoint name so the existing cron-job.org job needs no URL
// change, just a description update.
const CONFLUENCE_INDICES = ['SPY', 'QQQ', 'IWM']
// 5 credits here, up to 3 more from scan-confluence.ts's own concurrent run in the
// same minute = 8, exactly Twelve Data's free-tier credits/minute cap.
const FOLLOWED_BATCH_SIZE = 5
const BATCH_INTERVAL_MIN = 5

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!verifyCronSecret(req, res)) return

  try {
    if (!isMarketOpen()) {
      return res.status(200).json({ success: true, skipped: true, reason: 'market closed' })
    }

    const { data: followedRows } = await supabase
      .from('watchlists')
      .select('symbol')
      .eq('type', 'day_trade')

    const allFollowed = Array.from(new Set((followedRows || []).map(r => r.symbol))).filter(
      s => !CONFLUENCE_INDICES.includes(s)
    )
    const followedSymbols = pickBatch(allFollowed, FOLLOWED_BATCH_SIZE, BATCH_INTERVAL_MIN)

    for (const symbol of followedSymbols) {
      const candles = await getIntradayCandles(symbol)
      if (!candles) continue

      const vwap = calculateSessionVWAP(candles)
      await recordSnapshot(symbol, 'day_trade', candles, { vwap })
    }

    res.status(200).json({ success: true, followedTracked: followedSymbols })
  } catch (error) {
    console.error('Error in scan-day-trades:', error)
    res.status(500).json({ error: String(error) })
  }
}
