import { VercelRequest, VercelResponse } from '@vercel/node'
import { getSwingUniverse } from '../server/swingUniverse.js'
import { supabase } from '../server/supabaseAdmin.js'

const CONFLUENCE_INDICES = ['SPY', 'QQQ', 'IWM']

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const category = req.query.category === 'day_trade' ? 'day_trade' : 'swing'

  try {
    if (category === 'day_trade') {
      const { data: followedRows } = await supabase
        .from('watchlists')
        .select('symbol')
        .eq('type', 'day_trade')

      const followed = Array.from(new Set((followedRows || []).map(r => r.symbol)))
      const symbols = Array.from(new Set([...CONFLUENCE_INDICES, ...followed])).sort()
      return res.status(200).json({ symbols })
    }

    const { sectorPool, followedPool } = await getSwingUniverse()
    const symbols = Array.from(new Set([...sectorPool, ...followedPool])).sort()
    res.status(200).json({ symbols })
  } catch (error) {
    console.error('Error in tracked-universe:', error)
    res.status(500).json({ error: String(error) })
  }
}
