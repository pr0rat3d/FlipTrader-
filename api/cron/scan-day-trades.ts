import { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../server/supabaseAdmin.js'
import { getIntradayCandles } from '../../server/twelvedata.js'
import { analyzeCandles } from '../../server/indicators.js'
import { isMarketOpen } from '../../server/marketHours.js'
import { sendToTopic } from '../../server/firebase-notify.js'
import { ALERTS_TOPIC } from '../register-token.js'
import { verifyCronSecret } from '../../server/verifyCronSecret.js'
import { recordSnapshot } from '../../server/snapshot.js'
import { calculateSessionVWAP } from '../../server/vwap.js'
import { pickBatch } from '../../server/batching.js'

const CONFLUENCE_INDICES = ['SPY', 'QQQ', 'IWM']
// 3 confluence + 5 followed = 8, exactly Twelve Data's free-tier credits/minute cap.
// Runs every 5 minutes, so a followed pool bigger than 5 rotates through over time
// rather than blowing the per-minute budget in a single run.
const FOLLOWED_BATCH_SIZE = 5
const BATCH_INTERVAL_MIN = 5

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!verifyCronSecret(req, res)) return

  try {
    if (!isMarketOpen()) {
      return res.status(200).json({ success: true, skipped: true, reason: 'market closed' })
    }

    // Followed day-trade tickers get the same snapshot treatment (RSI/MACD/EMA/VWAP)
    // but are NOT folded into the TTF/DTF/STF confluence logic below, which is
    // specifically about SPY/QQQ/IWM agreeing with each other.
    const { data: followedRows } = await supabase
      .from('watchlists')
      .select('symbol')
      .eq('type', 'day_trade')

    const allFollowed = Array.from(new Set((followedRows || []).map(r => r.symbol))).filter(
      s => !CONFLUENCE_INDICES.includes(s)
    )
    const followedSymbols = pickBatch(allFollowed, FOLLOWED_BATCH_SIZE, BATCH_INTERVAL_MIN)

    let triggeredIndices: string[] = []
    let rsiDivergence: string | null = null
    let macdCurl: string | null = null
    let entryPrice = 0
    let target50EMA = 0

    for (const symbol of CONFLUENCE_INDICES) {
      const candles = await getIntradayCandles(symbol)
      if (!candles) continue

      const closes = candles.map(c => c.close)
      const vwap = calculateSessionVWAP(candles)
      await recordSnapshot(symbol, 'day_trade', closes, vwap)

      const signal = analyzeCandles(closes)

      if (signal?.hasSignal) {
        triggeredIndices.push(symbol)
        rsiDivergence = signal.rsiDivergence
        macdCurl = signal.macdCurl
        entryPrice = signal.entryPrice
        target50EMA = signal.target50EMA
      }
    }

    for (const symbol of followedSymbols) {
      const candles = await getIntradayCandles(symbol)
      if (!candles) continue

      const closes = candles.map(c => c.close)
      const vwap = calculateSessionVWAP(candles)
      await recordSnapshot(symbol, 'day_trade', closes, vwap)
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

    res.status(200).json({ success: true, indicesTriggered: triggeredIndices, followedTracked: followedSymbols })
  } catch (error) {
    console.error('Error in scan-day-trades:', error)
    res.status(500).json({ error: String(error) })
  }
}
