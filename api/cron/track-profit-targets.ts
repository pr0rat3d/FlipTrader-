import { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../server/supabaseAdmin.js'
import { getQuote } from '../../server/finnhub.js'
import { verifyCronSecret } from '../../server/verifyCronSecret.js'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!verifyCronSecret(req, res)) return

  try {
    // Get all open profit targets
    const { data: targets, error: targetError } = await supabase
      .from('profit_targets')
      .select('*')
      .is('target_hit_at', null)

    if (targetError) throw targetError

    if (!targets || targets.length === 0) {
      return res.status(200).json({ success: true, targetsHit: 0 })
    }

    let targetsHit = 0

    for (const target of targets) {
      const quote = await getQuote(target.symbol)

      if (!quote || !quote.c) continue

      const currentPrice = quote.c
      const isBullish = target.target_50ema_price > target.entry_price

      // Check if target hit
      const targetHit = isBullish
        ? currentPrice >= target.target_50ema_price
        : currentPrice <= target.target_50ema_price

      if (targetHit) {
        await supabase
          .from('profit_targets')
          .update({ target_hit_at: new Date() })
          .eq('id', target.id)

        targetsHit++
      }
    }

    res.status(200).json({ success: true, targetsHit })
  } catch (error) {
    console.error('Error tracking targets:', error)
    res.status(500).json({ error: String(error) })
  }
}
