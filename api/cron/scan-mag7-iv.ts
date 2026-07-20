import { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../server/supabaseAdmin.js'
import { getBars5Min } from '../../server/execution/alpacaClient.js'
import { analyzeCandles } from '../../server/indicators.js'
import { isMarketOpen } from '../../server/marketHours.js'
import { sendToTopic } from '../../server/firebase-notify.js'
import { ALERTS_TOPIC } from '../register-token.js'
import { verifyCronSecret } from '../../server/verifyCronSecret.js'
import { calculateATR } from '../../src/lib/technicalIndicators.js'
import { deriveMilestonePrices } from '../../server/alertOutcomes.js'
import { getSupportResistanceLevels } from '../../server/supportResistance.js'
import { detectSingleSymbolIVSignal } from '../../server/signalDetection.js'
import { detectCandlestickPattern } from '../../server/candlestickPatterns.js'
import { applyConfidenceModifiers } from '../../server/confidenceModifiers.js'
import { detectORBBreakout, continuationTargetPrice } from '../../server/orb.js'
import { getQuote } from '../../server/finnhub.js'

// Phase 1 of the Mag7 IV scanner (spec'd + built 2026-07-20): ALERTS ONLY,
// not wired into execute-alerts.ts. Deliberately kept off the live trading
// path until a few sessions of real signal data can be reviewed the same
// way every other signal type has been this month - see
// detectSingleSymbolIVSignal's comment for why this can't just reuse
// detectIVSignal's confluence logic wholesale.
//
// Data source is Alpaca, NOT Twelve Data - the existing scan-confluence.ts/
// scan-day-trades.ts/scan-swings.ts trio already fully commits Twelve
// Data's 8-credit/min free-tier budget. Alpaca's data API is a completely
// separate quota (confirmed empirically 2026-07-20: 200 req/window) and is
// already the proven data source for this whole project's backtesting.
const MAG7 = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NVDA', 'TSLA']

const VIX_PROXY_SYMBOL = 'VIXY'
const MACD_CURL_LOOKBACK_BARS = 30
const ATR_STOP_MULTIPLIER = 1.5

// Same threshold scan-confluence.ts uses - filters out the single weakest
// tier while still notifying on everything else.
const NOTIFICATION_CONFIDENCE_THRESHOLD = 0.6

const stopLossFor = (direction: 'bullish' | 'bearish', entryPrice: number, atr: number | null): number | null => {
  if (atr === null) return null
  return direction === 'bullish' ? entryPrice - ATR_STOP_MULTIPLIER * atr : entryPrice + ATR_STOP_MULTIPLIER * atr
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!verifyCronSecret(req, res)) return

  try {
    if (!isMarketOpen()) {
      return res.status(200).json({ success: true, skipped: true, reason: 'market closed' })
    }

    const vixQuote = await getQuote(VIX_PROXY_SYMBOL)
    const vixChangePct: number | null = vixQuote?.dp ?? null

    let fired = 0
    const results: Record<string, string> = {}

    for (const symbol of MAG7) {
      const candles = await getBars5Min(symbol)
      if (!candles || candles.length < 26) {
        results[symbol] = 'no data'
        continue
      }

      const closes = candles.map(c => c.close)
      const signal = analyzeCandles(closes, MACD_CURL_LOOKBACK_BARS)
      if (!signal || !signal.macdCurl) {
        results[symbol] = 'no macd curl'
        continue
      }

      const direction = signal.macdCurl
      const levels = await getSupportResistanceLevels(symbol, candles)
      const ivResult = detectSingleSymbolIVSignal(direction, signal.entryPrice, levels, candles)
      if (!ivResult) {
        results[symbol] = `${direction}, no level confluence`
        continue
      }

      const atrValues = calculateATR(candles.map(c => c.high), candles.map(c => c.low), closes, 14)
      const atr = atrValues[atrValues.length - 1] ?? null
      const patternMatch = detectCandlestickPattern(candles)
      const orbDirection = detectORBBreakout(candles, levels.orh, levels.orl)
      const entryTime = new Date()
      const confidence = applyConfidenceModifiers(ivResult.confidence, {
        direction,
        dailyEma50: levels.dailyEma50,
        dailyEma200: levels.dailyEma200,
        candlestickDirection: patternMatch?.direction ?? null,
        orbBreakoutDirection: orbDirection,
        vixChangePct,
        now: entryTime
      })

      const stopPrice = stopLossFor(direction, signal.entryPrice, atr)
      const targetPrice = continuationTargetPrice(direction, signal.entryPrice, stopPrice)
      const milestones = deriveMilestonePrices(signal.entryPrice, targetPrice)

      const { data, error } = await supabase
        .from('day_trade_alerts')
        .insert({
          symbol,
          ttf_status: 'MAG7_IV',
          rsi_divergence: null,
          macd_curl: direction,
          indices_triggered: [symbol],
          entry_price: signal.entryPrice,
          entry_time: entryTime,
          target_50ema: targetPrice,
          confluence_type: ivResult.confluenceType,
          confluence_level: ivResult.confluenceLevel,
          confidence,
          pdh: levels.pdh,
          pdl: levels.pdl,
          pdc: levels.pdc,
          orh: levels.orh,
          orl: levels.orl,
          gap_up: levels.gapUp,
          gap_down: levels.gapDown,
          stop_loss_price: stopPrice,
          orb_breakout_direction: orbDirection,
          timestamp: entryTime
        })
        .select()

      if (error) throw error

      if (data && data[0]) {
        await supabase.from('profit_targets').insert({
          day_trade_alert_id: data[0].id,
          symbol,
          entry_price: signal.entryPrice,
          entry_time: entryTime,
          target_50ema_price: targetPrice,
          stop_loss_price: stopPrice,
          milestone_10_price: milestones.milestone10,
          milestone_20_price: milestones.milestone20,
          milestone_30_price: milestones.milestone30
        })

        fired++
        results[symbol] = `FIRED ${direction} ${ivResult.confluenceType} conf=${confidence.toFixed(2)}`

        if (confidence >= NOTIFICATION_CONFIDENCE_THRESHOLD) {
          await sendToTopic(
            ALERTS_TOPIC,
            `Mag7 IV Alert: ${symbol}`,
            `${direction === 'bullish' ? 'Bullish' : 'Bearish'} - ${ivResult.confluenceType} at $${ivResult.confluenceLevel.toFixed(2)}`
          )
        }
      }
    }

    res.status(200).json({ success: true, fired, results })
  } catch (error) {
    console.error('Error in scan-mag7-iv:', error)
    res.status(500).json({ error: String(error) })
  }
}
