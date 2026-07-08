import { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from './helpers/supabaseAdmin'
import { calculateRSI } from '../../src/lib/technicalIndicators'
import { getDailyCloses } from './helpers/twelvedata'
import { sendToTopic } from './helpers/firebase-notify'
import { ALERTS_TOPIC } from '../register-token'
import { verifyCronSecret } from './helpers/verifyCronSecret'

// Capped at 8 symbols: Twelve Data's free tier allows 8 API credits/minute,
// and this loop fires sequentially with no throttling.
const STOCKS_TO_SCAN = [
  'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'TSLA', 'META', 'NFLX'
]

const SECTORS: { [key: string]: string } = {
  'AAPL': 'tech',
  'MSFT': 'tech',
  'GOOGL': 'tech',
  'AMZN': 'consumer',
  'NVDA': 'tech',
  'TSLA': 'consumer',
  'META': 'tech',
  'NFLX': 'consumer'
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!verifyCronSecret(req, res)) return

  try {
    const oversoldAlerts = []

    for (const symbol of STOCKS_TO_SCAN) {
      const closes = await getDailyCloses(symbol)
      if (!closes || closes.length < 14) continue

      const rsiValues = calculateRSI(closes, 14)
      const currentRSI = rsiValues[rsiValues.length - 1]

      if (currentRSI < 30) {
        const sector = SECTORS[symbol] || 'other'

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

    res.status(200).json({ success: true, oversoldAlerts })
  } catch (error) {
    console.error('Error in scan-swings:', error)
    res.status(500).json({ error: String(error) })
  }
}
