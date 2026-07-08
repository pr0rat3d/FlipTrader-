import { VercelRequest, VercelResponse } from '@vercel/node'

// Returns true if authorized. On failure, writes the 401 response itself
// so callers can just `if (!verifyCronSecret(req, res)) return`.
export const verifyCronSecret = (req: VercelRequest, res: VercelResponse): boolean => {
  const expected = process.env.CRON_SECRET
  if (!expected) return true

  const authHeader = req.headers.authorization
  const headerSecret = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined
  const querySecret = typeof req.query.secret === 'string' ? req.query.secret : undefined

  if (headerSecret === expected || querySecret === expected) return true

  res.status(401).json({ error: 'Unauthorized' })
  return false
}
