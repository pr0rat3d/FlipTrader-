import { VercelRequest, VercelResponse } from '@vercel/node'
import { searchSymbols } from '../server/finnhub.js'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : ''
  if (q.length < 1) {
    return res.status(200).json({ results: [] })
  }

  try {
    const results = await searchSymbols(q)
    res.status(200).json({ results })
  } catch (error) {
    console.error('Error in symbol-search:', error)
    res.status(500).json({ error: String(error) })
  }
}
