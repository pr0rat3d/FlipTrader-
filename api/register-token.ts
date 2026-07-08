import { VercelRequest, VercelResponse } from '@vercel/node'
import { subscribeToTopic } from '../server/firebase-notify.js'

export const ALERTS_TOPIC = 'all-alerts'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { token } = req.body || {}
  if (!token || typeof token !== 'string') {
    return res.status(400).json({ error: 'Missing token' })
  }

  try {
    await subscribeToTopic(token, ALERTS_TOPIC)
    res.status(200).json({ success: true })
  } catch (error) {
    if (error instanceof Error && error.message.includes('not configured')) {
      return res.status(200).json({ success: false, reason: 'firebase not configured' })
    }
    console.error('Error subscribing token to topic:', error)
    res.status(500).json({ error: String(error) })
  }
}
