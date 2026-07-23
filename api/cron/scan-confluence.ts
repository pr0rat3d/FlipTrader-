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
import { calculateATR, calculateADX } from '../../src/lib/technicalIndicators.js'
import { deriveMilestonePrices } from '../../server/alertOutcomes.js'
import { getSupportResistanceLevels, getDailyLevels, calculateOpeningRange } from '../../server/supportResistance.js'
import { detectIVSignal } from '../../server/signalDetection.js'
import { detectCandlestickPattern } from '../../server/candlestickPatterns.js'
import { applyConfidenceModifiers, isPrimeTime } from '../../server/confidenceModifiers.js'
import { detectORBBreakout, filterORBCandidates, isDailyTrendAligned, orbBaseConfidence, continuationTargetPrice } from '../../server/orb.js'
import { getQuote } from '../../server/finnhub.js'

// VIXY (VIX-futures ETF proxy - see confidenceModifiers.ts) via Finnhub, not
// Twelve Data - a separate quota from the per-minute credit budget the three
// confluence indices already fully commit between them.
const VIX_PROXY_SYMBOL = 'VIXY'

// How far back a MACD cross can be and still "back" a fresh breakout/
// continuation - a fixed, continuously-rolling window (NOT reset at each
// session's calendar-day boundary, which was tried first and found to miss
// crosses from late in the prior session - see analyzeCandles/git history,
// 2026-07-15). 30 bars on 5-min candles = ~2.5 trading hours; long enough to
// catch a cross from earlier today or late yesterday, short enough that a
// genuinely multi-day-stale cross still doesn't count as "recent."
const MACD_CURL_LOOKBACK_BARS = 30

// How far back an RSI divergence can be and still count, mirroring
// MACD_CURL_LOOKBACK_BARS above but deliberately much smaller - a
// divergence is a specific price-extreme EVENT (a bar where price hit a
// new high/low that RSI didn't confirm), not a durable state like "MACD is
// still on the bullish side of its signal line." By the time several bars
// have passed, price has usually already moved on and invalidated the
// setup the divergence pointed at. 5 bars on 5-min candles = ~25 min -
// comfortably covers the ~12-minute divergence-to-MACD-cross gap found
// live 2026-07-15 (SPY: divergence at 2:36pm ET, cross at 2:48pm) with
// some margin, without going stale.
const RSI_DIVERGENCE_LOOKBACK_BARS = 5

// How many consecutive shrinking-toward-zero histogram bars
// detectHistogramDeceleration requires before calling it a real turn
// rather than single-bar noise. 3 bars = ~15 min of sustained deceleration.
const HISTOGRAM_DECELERATION_BARS = 3

// Stop-loss = entry price minus (bullish) or plus (bearish) 1.5x ATR - a common
// day-trading default, not load-bearing anywhere downstream, easy to tune.
const ATR_STOP_MULTIPLIER = 1.5

// Split out from scan-day-trades.ts so the latency-sensitive TTTF/DTTF/STTF/IV
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

// Twelve Data's free tier also caps TOTAL usage at 800 credits/day, separate from
// the 8/min cap above - running this every single market-open minute costs up to
// 390 min x 3 credits = 1,170/day, well over the daily cap on its own (discovered
// when the daily cap got hit mid-session and silently stopped all snapshot
// recording for the rest of the day, since a failed Twelve Data call just skips
// that symbol rather than throwing). Full 1-min cadence is kept ONLY during prime
// time (the first/last 45 min of the session - the highest-value, most-volume
// window) and throttled to every 3rd minute otherwise: (90 x 3) + (100 x 3) = 570
// credits/day, leaving real headroom for scan-day-trades.ts/scan-swings.ts.
const THROTTLE_INTERVAL_MIN = 3

export const shouldRunThisMinute = (now: Date): boolean => isPrimeTime(now) || now.getMinutes() % THROTTLE_INTERVAL_MIN === 0

// Below this, an alert still gets recorded (and tracked in Performance) but doesn't
// push a notification - filters out the single weakest tier from each signal family
// (STF's 0.55, and IV's weakest 2-index gap-fill case at 0.585) while still notifying
// on everything else. Adjust freely; nothing downstream depends on this exact value.
const NOTIFICATION_CONFIDENCE_THRESHOLD = 0.6

interface PerSymbolSignal {
  symbol: string
  rsiDivergence: string | null
  macdCurl: string | null
  histogramDeceleration: string | null
  entryPrice: number
  target50EMA: number
  atr: number | null
  // Trend STRENGTH (not direction) - see execute-alerts.ts's
  // DIV_ADX_TREND_GATE for why this is computed here (2026-07-23).
  adx: number | null
  candles: Candle[]
}

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

    if (!shouldRunThisMinute(new Date())) {
      return res.status(200).json({ success: true, skipped: true, reason: 'throttled (off-cadence minute outside prime time)' })
    }

    // Fetched once per run (not per signal type/direction) and reused everywhere
    // below - a null here (quote fetch failed) just means the VIX modifier sits
    // out this run, same as a null daily-trend EMA already does elsewhere.
    const vixQuote = await getQuote(VIX_PROXY_SYMBOL)
    const vixChangePct: number | null = vixQuote?.dp ?? null

    // One entry per scanned symbol regardless of whether the full signal condition is
    // met - analyzeCandles always computes rsiDivergence/macdCurl/entryPrice/
    // target50EMA, and IV detection needs the MACD-curl-only symbols too.
    const perSymbolSignals: PerSymbolSignal[] = []

    for (const symbol of CONFLUENCE_INDICES) {
      const candles = await getIntradayCandles(symbol)
      if (!candles) continue

      const closes = candles.map(c => c.close)
      const vwap = calculateSessionVWAP(candles)
      await recordSnapshot(symbol, 'day_trade', candles, { vwap })

      // A MACD cross within the last ~2.5 trading hours still backs a
      // breakout/continuation that plays out later - see analyzeCandles for
      // why a bare latest-bar-only check misses exactly this (SPY,
      // 2026-07-14: crossed bullish at the open, broke the opening range 17
      // min later with MACD never having given back the signal line - zero
      // alerts fired all session because the cross and the breakout bar
      // differed). A calendar-day session boundary was tried first and
      // found to still miss this: IWM's cross on 2026-07-15 turned out to
      // have happened 3:40pm ET the PRIOR day (only 20 bars back), which a
      // "since today's open" reset can never see regardless of how far into
      // the current session it gets. A fixed trailing-bar count that rolls
      // forward continuously (no reset) catches both cases.
      const signal = analyzeCandles(closes, MACD_CURL_LOOKBACK_BARS, RSI_DIVERGENCE_LOOKBACK_BARS, HISTOGRAM_DECELERATION_BARS)

      if (signal) {
        const atrValues = calculateATR(candles.map(c => c.high), candles.map(c => c.low), closes, 14)
        const adxValues = calculateADX(candles.map(c => c.high), candles.map(c => c.low), closes, 14)
        perSymbolSignals.push({
          symbol,
          rsiDivergence: signal.rsiDivergence,
          macdCurl: signal.macdCurl,
          histogramDeceleration: signal.histogramDeceleration,
          entryPrice: signal.entryPrice,
          target50EMA: signal.target50EMA,
          atr: atrValues[atrValues.length - 1] ?? null,
          adx: adxValues[adxValues.length - 1]?.adx ?? null,
          candles
        })
      }
    }

    // Full confluence (TTTF/DTTF/STTF): RSI divergence + MACD curl agreeing.
    const signalResults = perSymbolSignals.filter(s => s.rsiDivergence && s.rsiDivergence === s.macdCurl)
    const triggeredIndices = signalResults.map(r => r.symbol)
    let fullConfluenceFired = false

    if (signalResults.length > 0) {
      fullConfluenceFired = true
      const ttfStatus = triggeredIndices.length === 3 ? 'TTTF' : triggeredIndices.length === 2 ? 'DTTF' : 'STTF'
      // Same confidence scale the user's original spec proposed for full confluence -
      // scales with how many indices agree, same idea as IV's index-count scaling.
      const baseConfidence = ttfStatus === 'TTTF' ? 0.95 : ttfStatus === 'DTTF' ? 0.75 : 0.55
      const representative = signalResults[0]
      const entryTime = new Date()

      // Layer in daily-trend alignment, same-bar candlestick confluence, and
      // session-timing quality on top of the tier-based base confidence.
      const dailyLevels = await getDailyLevels(representative.symbol)
      const patternMatch = detectCandlestickPattern(representative.candles)
      const openingRange = calculateOpeningRange(representative.candles)
      const orbDirection = detectORBBreakout(representative.candles, openingRange?.orh ?? null, openingRange?.orl ?? null)
      const confidence = applyConfidenceModifiers(baseConfidence, {
        direction: representative.rsiDivergence as 'bullish' | 'bearish',
        dailyEma50: dailyLevels?.dailyEma50 ?? null,
        dailyEma200: dailyLevels?.dailyEma200 ?? null,
        candlestickDirection: patternMatch?.direction ?? null,
        orbBreakoutDirection: orbDirection,
        vixChangePct,
        now: entryTime
      })

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
          stop_loss_price: stopLossFor(representative.rsiDivergence as 'bullish' | 'bearish', representative.entryPrice, representative.atr),
          orb_breakout_direction: orbDirection,
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
              stop_loss_price: stopLossFor(r.rsiDivergence as 'bullish' | 'bearish', r.entryPrice, r.atr),
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

    // DIV (Divergence, pre-confirmation): RSI divergence (now with the same
    // trailing-lookback grace MACD's curl already has) confirmed by histogram
    // DECELERATION rather than a confirmed MACD cross - catches a reversal at
    // the moment the divergence itself appears, instead of waiting the extra
    // several bars a real crossover can take to arrive (see
    // RSI_DIVERGENCE_LOOKBACK_BARS above for the live case this was built
    // for). Deliberately a SEPARATE, lower-confidence tier rather than folded
    // into TTTF/DTTF/STTF's own confidence - a real crossover is still
    // stronger evidence than deceleration alone, and "TTTF fired" should keep
    // meaning "a crossover actually happened," not "probably about to."
    // Reversal thesis like full confluence (not a continuation play like
    // IV/ORB), so it targets the raw 50 EMA the same way full confluence
    // does, not continuationTargetPrice. Not suppressed by IV/ORB firing in
    // the same run (or vice versa) - each tests independent conditions - but
    // still suppressed by full confluence itself, since a real crossover
    // already happening supersedes a "crossover coming soon" read on the
    // same move.
    let divFired: string | null = null

    if (!fullConfluenceFired) {
      for (const direction of ['bullish', 'bearish'] as const) {
        const divergent = perSymbolSignals.filter(s => s.rsiDivergence === direction && s.histogramDeceleration === direction)
        if (divergent.length < 1) continue

        const representative = divergent.find(s => s.symbol === 'SPY') || divergent[0]
        const divIndices = divergent.map(s => s.symbol)
        const entryTime = new Date()

        const dailyLevels = await getDailyLevels(representative.symbol)
        const patternMatch = detectCandlestickPattern(representative.candles)
        const openingRange = calculateOpeningRange(representative.candles)
        const orbDirection = detectORBBreakout(representative.candles, openingRange?.orh ?? null, openingRange?.orl ?? null)
        // Scales with index-count agreement same as every other tier here,
        // but pinned BELOW the matching full-confluence tier at every count
        // (0.80/0.65/0.50 vs TTTF/DTTF/STTF's 0.95/0.75/0.55) - less
        // confirmed evidence should never outscore more confirmed evidence
        // for the same index count.
        const baseConfidence = divIndices.length === 3 ? 0.80 : divIndices.length === 2 ? 0.65 : 0.50
        const confidence = applyConfidenceModifiers(baseConfidence, {
          direction,
          dailyEma50: dailyLevels?.dailyEma50 ?? null,
          dailyEma200: dailyLevels?.dailyEma200 ?? null,
          candlestickDirection: patternMatch?.direction ?? null,
          orbBreakoutDirection: orbDirection,
          vixChangePct,
          now: entryTime
        })

        const { data, error } = await supabase
          .from('day_trade_alerts')
          .insert({
            symbol: divIndices.join('/'),
            ttf_status: 'DIV',
            rsi_divergence: direction,
            macd_curl: direction,
            indices_triggered: divIndices,
            entry_price: representative.entryPrice,
            entry_time: entryTime,
            target_50ema: representative.target50EMA,
            confidence,
            stop_loss_price: stopLossFor(direction, representative.entryPrice, representative.atr),
            orb_breakout_direction: orbDirection,
            adx: representative.adx,
            timestamp: entryTime
          })
          .select()

        if (error) throw error

        if (data && data[0]) {
          await supabase.from('profit_targets').insert(
            divergent.map(s => {
              const milestones = deriveMilestonePrices(s.entryPrice, s.target50EMA)
              return {
                day_trade_alert_id: data[0].id,
                symbol: s.symbol,
                entry_price: s.entryPrice,
                entry_time: entryTime,
                target_50ema_price: s.target50EMA,
                stop_loss_price: stopLossFor(direction, s.entryPrice, s.atr),
                milestone_10_price: milestones.milestone10,
                milestone_20_price: milestones.milestone20,
                milestone_30_price: milestones.milestone30
              }
            })
          )

          divFired = direction

          if (confidence >= NOTIFICATION_CONFIDENCE_THRESHOLD) {
            await sendToTopic(
              ALERTS_TOPIC,
              `DIV Alert: ${divIndices.join('/')}`,
              `${direction === 'bullish' ? 'Bullish' : 'Bearish'} divergence, MACD turning but not yet crossed - ${representative.symbol} $${representative.entryPrice.toFixed(2)}`
            )
          }
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
        const ivResult = detectIVSignal(direction, representative.entryPrice, levels, directional.map(s => s.symbol), representative.candles)

        if (!ivResult) continue

        const ivIndices = directional.map(s => s.symbol)
        const entryTime = new Date()

        // Same three modifiers as the full-confluence path - daily trend, same-bar
        // candlestick confluence, and session-timing quality on top of IV's own
        // S/R-tier and index-count base confidence.
        const patternMatch = detectCandlestickPattern(representative.candles)
        const orbDirection = detectORBBreakout(representative.candles, levels.orh, levels.orl)
        const confidence = applyConfidenceModifiers(ivResult.confidence, {
          direction,
          dailyEma50: levels.dailyEma50,
          dailyEma200: levels.dailyEma200,
          candlestickDirection: patternMatch?.direction ?? null,
          orbBreakoutDirection: orbDirection,
          vixChangePct,
          now: entryTime
        })

        // IV's thesis is "reject off this level and continue," not reversion
        // to the 50 EMA (which the field name misleadingly suggests) - see
        // continuationTargetPrice's comment for why the raw 50 EMA broke
        // both stop-hit detection and (formerly) the shares-model's
        // scale-out orders, found live 2026-07-15 on 72 of that day's 99 IV
        // legs.
        const representativeStop = stopLossFor(direction, representative.entryPrice, representative.atr)

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
            target_50ema: continuationTargetPrice(direction, representative.entryPrice, representativeStop),
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
            stop_loss_price: representativeStop,
            orb_breakout_direction: orbDirection,
            timestamp: entryTime
          })
          .select()

        if (error) throw error

        if (data && data[0]) {
          await supabase.from('profit_targets').insert(
            directional.map(s => {
              const legStop = stopLossFor(direction, s.entryPrice, s.atr)
              const legTarget = continuationTargetPrice(direction, s.entryPrice, legStop)
              const milestones = deriveMilestonePrices(s.entryPrice, legTarget)
              return {
                day_trade_alert_id: data[0].id,
                symbol: s.symbol,
                entry_price: s.entryPrice,
                entry_time: entryTime,
                target_50ema_price: legTarget,
                stop_loss_price: legStop,
                milestone_10_price: milestones.milestone10,
                milestone_20_price: milestones.milestone20,
                milestone_30_price: milestones.milestone30
              }
            })
          )

          ivFired = direction

          if (confidence >= NOTIFICATION_CONFIDENCE_THRESHOLD) {
            await sendToTopic(
              ALERTS_TOPIC,
              `IV Alert: ${ivIndices.join('/')}`,
              `${direction === 'bullish' ? 'Bullish' : 'Bearish'} momentum - ${ivResult.confluenceType} at $${ivResult.confluenceLevel.toFixed(2)}`
            )
          }
        }
      }
    }

    // ORB (Opening Range Breakout): standalone continuation strategy, hard-gated
    // on daily trend alignment - "especially on supertrend days" made concrete as
    // a requirement to fire, not just a soft confidence modifier. Same suppression
    // as IV (skipped if full confluence already fired this run for the same move).
    // IV and ORB are independent of each other - both can fire in the same run,
    // since they test near-mutually-exclusive conditions (IV wants price NEAR a
    // level, ORB wants price already CLOSED beyond the opening range).
    let orbFired: string | null = null

    if (!fullConfluenceFired) {
      for (const direction of ['bullish', 'bearish'] as const) {
        const qualifyingSymbols = filterORBCandidates(perSymbolSignals, direction)
        if (qualifyingSymbols.length < 1) continue

        const candidates = perSymbolSignals.filter(s => qualifyingSymbols.includes(s.symbol))
        const representative = candidates.find(s => s.symbol === 'SPY') || candidates[0]
        const dailyLevels = await getDailyLevels(representative.symbol)

        if (!isDailyTrendAligned(direction, dailyLevels?.dailyEma50 ?? null, dailyLevels?.dailyEma200 ?? null)) continue

        const openingRange = calculateOpeningRange(representative.candles)
        const entryTime = new Date()

        // Trend and ORB-direction are deliberately NOT passed here - trend
        // alignment is already a hard requirement to reach this point, and
        // re-applying the ORB modifier to the ORB signal itself would just be
        // circular multiplication by a constant, not real information. VIX IS
        // passed - unlike those two, it isn't derived from ORB's own detection
        // logic, so it's real independent information here too.
        const patternMatch = detectCandlestickPattern(representative.candles)
        const confidence = applyConfidenceModifiers(orbBaseConfidence(qualifyingSymbols.length), {
          direction,
          dailyEma50: null,
          dailyEma200: null,
          candlestickDirection: patternMatch?.direction ?? null,
          orbBreakoutDirection: null,
          vixChangePct,
          now: entryTime
        })

        const representativeStop = stopLossFor(direction, representative.entryPrice, representative.atr)

        const { data, error } = await supabase
          .from('day_trade_alerts')
          .insert({
            symbol: qualifyingSymbols.join('/'),
            ttf_status: 'ORB',
            rsi_divergence: null,
            macd_curl: direction,
            indices_triggered: qualifyingSymbols,
            entry_price: representative.entryPrice,
            entry_time: entryTime,
            target_50ema: continuationTargetPrice(direction, representative.entryPrice, representativeStop),
            confidence,
            orh: openingRange?.orh ?? null,
            orl: openingRange?.orl ?? null,
            stop_loss_price: representativeStop,
            orb_breakout_direction: direction,
            timestamp: entryTime
          })
          .select()

        if (error) throw error

        if (data && data[0]) {
          await supabase.from('profit_targets').insert(
            candidates.map(s => {
              const legStop = stopLossFor(direction, s.entryPrice, s.atr)
              const legTarget = continuationTargetPrice(direction, s.entryPrice, legStop)
              const milestones = deriveMilestonePrices(s.entryPrice, legTarget)
              return {
                day_trade_alert_id: data[0].id,
                symbol: s.symbol,
                entry_price: s.entryPrice,
                entry_time: entryTime,
                target_50ema_price: legTarget,
                stop_loss_price: legStop,
                milestone_10_price: milestones.milestone10,
                milestone_20_price: milestones.milestone20,
                milestone_30_price: milestones.milestone30
              }
            })
          )

          orbFired = direction

          if (confidence >= NOTIFICATION_CONFIDENCE_THRESHOLD) {
            await sendToTopic(
              ALERTS_TOPIC,
              `ORB Alert: ${qualifyingSymbols.join('/')}`,
              `${direction === 'bullish' ? 'Bullish' : 'Bearish'} breakout continuation beyond the opening range`
            )
          }
        }
      }
    }

    res.status(200).json({ success: true, indicesTriggered: triggeredIndices, divFired, ivFired, orbFired })
  } catch (error) {
    console.error('Error in scan-confluence:', error)
    res.status(500).json({ error: String(error) })
  }
}
