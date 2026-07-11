import { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../server/supabaseAdmin.js'
import { getIntradayCandles, Candle } from '../../server/twelvedata.js'
import { analyzeCandles } from '../../server/indicators.js'
import { isMarketOpen } from '../../server/marketHours.js'
import { sendToTopic } from '../../server/firebase-notify.js'
import { ALERTS_TOPIC } from '../register-token.js'
import { verifyCronSecret } from '../../server/verifyCronSecret.js'
import { recordSnapshot } from '../../server/snapshot.js'
import { calculateSessionVWAP } from '../../server/vwap.js'
import { deriveMilestonePrices } from '../../server/alertOutcomes.js'
import { getSupportResistanceLevels } from '../../server/supportResistance.js'
import { detectIVSignal } from '../../server/signalDetection.js'

// Split out from scan-day-trades.ts so the latency-sensitive TTF/DTF/STF/IV
// detection can run on its own fast schedule (every 1 min - 3 credits/min, well
// under Twelve Data's free-tier 8 credits/min cap) without being tied to the
// slower cadence that's actually fine for followed-ticker snapshot history
// (still handled by scan-day-trades.ts, every 5 min). Since this runs every
// single minute, it's *always* concurrent with whatever else happens to fire in
// that minute - scan-day-trades.ts's followed batch (up to 5 credits) and
// scan-swings.ts's batch (5 credits, reduced from 6 for exactly this reason) are
// each sized so 3 (this) + 5 (either other job) never exceeds the 8/min cap,
// even in the worst case where both land in the same minute.
const CONFLUENCE_INDICES = ['SPY', 'QQQ', 'IWM']

// Below this, an alert still gets recorded (and tracked in Performance) but doesn't
// push a notification - filters out the single weakest tier from each signal family
// (STF's 0.55, and IV's weakest 2-index gap-fill case at 0.585) while still notifying
// on everything else. Adjust freely; nothing downstream depends on this exact value.
const NOTIFICATION_CONFIDENCE_THRESHOLD = 0.6

interface PerSymbolSignal {
  symbol: string
  rsiDivergence: string | null
  macdCurl: string | null
  entryPrice: number
  target50EMA: number
  candles: Candle[]
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!verifyCronSecret(req, res)) return

  try {
    if (!isMarketOpen()) {
      return res.status(200).json({ success: true, skipped: true, reason: 'market closed' })
    }

    // One entry per scanned symbol regardless of whether the full signal condition is
    // met - analyzeCandles always computes rsiDivergence/macdCurl/entryPrice/
    // target50EMA, and IV detection needs the MACD-curl-only symbols too.
    const perSymbolSignals: PerSymbolSignal[] = []

    for (const symbol of CONFLUENCE_INDICES) {
      const candles = await getIntradayCandles(symbol)
      if (!candles) continue

      const closes = candles.map(c => c.close)
      const latest = candles[candles.length - 1]
      const vwap = calculateSessionVWAP(candles)
      await recordSnapshot(symbol, 'day_trade', closes, { vwap, open: latest.open, high: latest.high, low: latest.low })

      const signal = analyzeCandles(closes)

      if (signal) {
        perSymbolSignals.push({
          symbol,
          rsiDivergence: signal.rsiDivergence,
          macdCurl: signal.macdCurl,
          entryPrice: signal.entryPrice,
          target50EMA: signal.target50EMA,
          candles
        })
      }
    }

    // Full confluence (TTF/DTF/STF): RSI divergence + MACD curl agreeing.
    const signalResults = perSymbolSignals.filter(s => s.rsiDivergence && s.rsiDivergence === s.macdCurl)
    const triggeredIndices = signalResults.map(r => r.symbol)
    let fullConfluenceFired = false

    if (signalResults.length > 0) {
      fullConfluenceFired = true
      const ttfStatus = triggeredIndices.length === 3 ? 'TTF' : triggeredIndices.length === 2 ? 'DTF' : 'STF'
      // Same confidence scale the user's original spec proposed for full confluence -
      // scales with how many indices agree, same idea as IV's index-count scaling.
      const confidence = ttfStatus === 'TTF' ? 0.95 : ttfStatus === 'DTF' ? 0.75 : 0.55
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
          confidence,
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

        if (confidence >= NOTIFICATION_CONFIDENCE_THRESHOLD) {
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
    }

    // IV (Intraday Reversal): earlier momentum-only signal - MACD curl + support/
    // resistance confluence, no RSI divergence required. Suppressed in a run where
    // full confluence just fired for the same move, since IV is meant to be the
    // EARLIER signal (an earlier cron run), not a concurrent duplicate of the full one.
    let ivFired: string | null = null

    if (!fullConfluenceFired) {
      for (const direction of ['bullish', 'bearish'] as const) {
        const directional = perSymbolSignals.filter(s => s.macdCurl === direction)
        if (directional.length < 2) continue

        const representative = directional.find(s => s.symbol === 'SPY') || directional[0]
        const levels = await getSupportResistanceLevels(representative.symbol, representative.candles)
        const ivResult = detectIVSignal(direction, representative.entryPrice, levels, directional.map(s => s.symbol))

        if (!ivResult) continue

        const ivIndices = directional.map(s => s.symbol)
        const entryTime = new Date()

        const { data, error } = await supabase
          .from('day_trade_alerts')
          .insert({
            symbol: ivIndices.join('/'),
            ttf_status: 'IV',
            rsi_divergence: null,
            macd_curl: direction,
            indices_triggered: ivIndices,
            entry_price: representative.entryPrice,
            entry_time: entryTime,
            target_50ema: representative.target50EMA,
            confluence_type: ivResult.confluenceType,
            confluence_level: ivResult.confluenceLevel,
            confidence: ivResult.confidence,
            pdh: levels.pdh,
            pdl: levels.pdl,
            pdc: levels.pdc,
            orh: levels.orh,
            orl: levels.orl,
            gap_up: levels.gapUp,
            gap_down: levels.gapDown,
            timestamp: entryTime
          })
          .select()

        if (error) throw error

        if (data && data[0]) {
          await supabase.from('profit_targets').insert(
            directional.map(s => {
              const milestones = deriveMilestonePrices(s.entryPrice, s.target50EMA)
              return {
                day_trade_alert_id: data[0].id,
                symbol: s.symbol,
                entry_price: s.entryPrice,
                entry_time: entryTime,
                target_50ema_price: s.target50EMA,
                milestone_10_price: milestones.milestone10,
                milestone_20_price: milestones.milestone20,
                milestone_30_price: milestones.milestone30
              }
            })
          )

          ivFired = direction

          if (ivResult.confidence >= NOTIFICATION_CONFIDENCE_THRESHOLD) {
            await sendToTopic(
              ALERTS_TOPIC,
              `IV Alert: ${ivIndices.join('/')}`,
              `${direction === 'bullish' ? 'Bullish' : 'Bearish'} momentum - ${ivResult.confluenceType} at $${ivResult.confluenceLevel.toFixed(2)}`
            )
          }
        }
      }
    }

    res.status(200).json({ success: true, indicesTriggered: triggeredIndices, ivFired })
  } catch (error) {
    console.error('Error in scan-confluence:', error)
    res.status(500).json({ error: String(error) })
  }
}
