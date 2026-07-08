import { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from './helpers/supabaseAdmin.js'
import { getIntradayCloses } from './helpers/twelvedata.js'
import { analyzeCandles } from './helpers/indicators.js'
import { isMarketOpen } from './helpers/marketHours.js'
import { sendToTopic } from './helpers/firebase-notify.js'
import { ALERTS_TOPIC } from '../register-token.js'
import { verifyCronSecret } from './helpers/verifyCronSecret.js'
import { recordSnapshot } from './helpers/snapshot.js'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!verifyCronSecret(req, res)) return

  try {
    if (!isMarketOpen()) {
      return res.status(200).json({ success: true, skipped: true, reason: 'market closed' })
    }

    const indices = ['SPY', 'QQQ', 'IWM']

    let triggeredIndices: string[] = []
    let rsiDivergence: string | null = null
    let macdCurl: string | null = null
    let entryPrice = 0
    let target50EMA = 0

    for (const symbol of indices) {
      const closes = await getIntradayCloses(symbol)
      if (!closes) continue

      await recordSnapshot(symbol, 'day_trade', closes)

      const signal = analyzeCandles(closes)

      if (signal?.hasSignal) {
        triggeredIndices.push(symbol)
        rsiDivergence = signal.rsiDivergence
        macdCurl = signal.macdCurl
        entryPrice = signal.entryPrice
        target50EMA = signal.target50EMA
      }
    }

    // If we have signals, create alert
    if (triggeredIndices.length > 0) {
      const ttfStatus = triggeredIndices.length === 3 ? 'TTF' : triggeredIndices.length === 2 ? 'DTF' : 'STF'

      const { data, error } = await supabase
        .from('day_trade_alerts')
        .insert({
          symbol: triggeredIndices.join('/'),
          ttf_status: ttfStatus,
          rsi_divergence: rsiDivergence,
          macd_curl: macdCurl,
          indices_triggered: triggeredIndices,
          entry_price: entryPrice,
          entry_time: new Date(),
          target_50ema: target50EMA,
          timestamp: new Date()
        })
        .select()

      if (error) throw error

      if (data && data[0]) {
        // Create profit target
        await supabase
          .from('profit_targets')
          .insert({
            day_trade_alert_id: data[0].id,
            symbol: triggeredIndices.join('/'),
            entry_price: entryPrice,
            entry_time: new Date(),
            target_50ema_price: target50EMA
          })

        await sendToTopic(
          ALERTS_TOPIC,
          `${ttfStatus} Alert: ${triggeredIndices.join('/')}`,
          `${rsiDivergence === 'bullish' ? 'Bullish' : 'Bearish'} reversal at $${entryPrice.toFixed(2)}, target $${target50EMA.toFixed(2)}`
        )
      }
    }

    res.status(200).json({ success: true, indicesTriggered: triggeredIndices })
  } catch (error) {
    console.error('Error in scan-day-trades:', error)
    res.status(500).json({ error: String(error) })
  }
}
