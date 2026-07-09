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
import { deriveMilestonePrices } from '../../server/alertOutcomes.js'

const CONFLUENCE_INDICES = ['SPY', 'QQQ', 'IWM']
// 3 confluence + 5 followed = 8, exactly Twelve Data's free-tier credits/minute cap.
// Runs every 5 minutes, so a followed pool bigger than 5 rotates through over time
// rather than blowing the per-minute budget in a single run.
const FOLLOWED_BATCH_SIZE = 5
const BATCH_INTERVAL_MIN = 5

interface SignalResult {
  symbol: string
  rsiDivergence: string
  macdCurl: string
  entryPrice: number
  target50EMA: number
}

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

    // One independent result per triggered symbol - previously these were shared
    // variables overwritten on every iteration, so a DTF/TTF alert (2-3 symbols
    // agreeing) always recorded only the LAST symbol's numbers (always IWM),
    // silently discarding SPY/QQQ's actual entry/target prices.
    const signalResults: SignalResult[] = []

    for (const symbol of CONFLUENCE_INDICES) {
      const candles = await getIntradayCandles(symbol)
      if (!candles) continue

      const closes = candles.map(c => c.close)
      const latest = candles[candles.length - 1]
      const vwap = calculateSessionVWAP(candles)
      await recordSnapshot(symbol, 'day_trade', closes, vwap, latest.high, latest.low)

      const signal = analyzeCandles(closes)

      if (signal?.hasSignal && signal.rsiDivergence && signal.macdCurl) {
        signalResults.push({
          symbol,
          rsiDivergence: signal.rsiDivergence,
          macdCurl: signal.macdCurl,
          entryPrice: signal.entryPrice,
          target50EMA: signal.target50EMA
        })
      }
    }

    for (const symbol of followedSymbols) {
      const candles = await getIntradayCandles(symbol)
      if (!candles) continue

      const closes = candles.map(c => c.close)
      const latest = candles[candles.length - 1]
      const vwap = calculateSessionVWAP(candles)
      await recordSnapshot(symbol, 'day_trade', closes, vwap, latest.high, latest.low)
    }

    const triggeredIndices = signalResults.map(r => r.symbol)

    // If we have signals, create alert
    if (signalResults.length > 0) {
      const ttfStatus = triggeredIndices.length === 3 ? 'TTF' : triggeredIndices.length === 2 ? 'DTF' : 'STF'
      const representative = signalResults[0]
      const entryTime = new Date()

      const { data, error } = await supabase
        .from('day_trade_alerts')
        .insert({
          symbol: triggeredIndices.join('/'),
          ttf_status: ttfStatus,
          rsi_divergence: representative.rsiDivergence,
          macd_curl: representative.macdCurl,
          indices_triggered: triggeredIndices,
          entry_price: representative.entryPrice,
          entry_time: entryTime,
          target_50ema: representative.target50EMA,
          timestamp: entryTime
        })
        .select()

      if (error) throw error

      if (data && data[0]) {
        // One profit_targets row per triggered symbol, each with its own real
        // entry/target/milestones - not a single blended row for the whole alert.
        await supabase.from('profit_targets').insert(
          signalResults.map(r => {
            const milestones = deriveMilestonePrices(r.entryPrice, r.target50EMA)
            return {
              day_trade_alert_id: data[0].id,
              symbol: r.symbol,
              entry_price: r.entryPrice,
              entry_time: entryTime,
              target_50ema_price: r.target50EMA,
              milestone_10_price: milestones.milestone10,
              milestone_20_price: milestones.milestone20,
              milestone_30_price: milestones.milestone30
            }
          })
        )

        const legLines = signalResults
          .map(r => `${r.symbol} $${r.entryPrice.toFixed(2)} -> $${r.target50EMA.toFixed(2)}`)
          .join(', ')

        await sendToTopic(
          ALERTS_TOPIC,
          `${ttfStatus} Alert: ${triggeredIndices.join('/')}`,
          `${representative.rsiDivergence === 'bullish' ? 'Bullish' : 'Bearish'} reversal - ${legLines}`
        )
      }
    }

    res.status(200).json({ success: true, indicesTriggered: triggeredIndices, followedTracked: followedSymbols })
  } catch (error) {
    console.error('Error in scan-day-trades:', error)
    res.status(500).json({ error: String(error) })
  }
}
