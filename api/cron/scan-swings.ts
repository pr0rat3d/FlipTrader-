import { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../server/supabaseAdmin.js'
import { calculateRSI } from '../../src/lib/technicalIndicators.js'
import { getDailyCandles } from '../../server/twelvedata.js'
import { isMarketOpen } from '../../server/marketHours.js'
import { sendToTopic } from '../../server/firebase-notify.js'
import { ALERTS_TOPIC } from '../register-token.js'
import { verifyCronSecret } from '../../server/verifyCronSecret.js'
import { recordSnapshot } from '../../server/snapshot.js'
import { pickBatch } from '../../server/batching.js'
import { getSwingUniverse } from '../../server/swingUniverse.js'
import { getDailyLevels } from '../../server/supportResistance.js'
import { evaluateSwingOpportunity } from '../../server/swingOptionSelection.js'

// Spec filter, applied only once a symbol's IV-rank has enough history to be
// meaningful (see MIN_IV_HISTORY_FOR_RANK in swingOptionSelection.ts) - null
// (cold start) always passes, matching the pre-options-Greeks live behavior
// rather than going silent for the ~20 trading days history takes to build.
const CALL_MAX_IV_RANK = 40
const PUT_MIN_IV_RANK = 60

// Twelve Data's free tier allows 8 credits/minute account-wide, shared with
// scan-confluence.ts (3 credits, but that one now runs every single minute -
// see that file) and scan-day-trades.ts (5 credits, every 5 min). Since
// scan-confluence.ts fires every minute, this job's 3+6=9 credits would have
// exceeded the cap on whichever minute the two coincided - reduced from 6 to 5
// so 3 (confluence, always present) + 5 (this) = 8, the safe ceiling, regardless
// of timing. The 7,22,37,52 offset still avoids colliding with scan-day-trades.ts's
// */5 grid (7 mod 5 = 2, permanent), keeping the worst case at exactly 8, never 13.
//
// Twelve Data's daily interval only updates once/day, so running this more
// often than daily doesn't fetch fresher data - the batching exists purely to
// cycle a >8-symbol universe through the fixed per-minute credit budget. Don't
// "optimize" this away under the belief it's about freshness.
const BATCH_SIZE = 5
const FOLLOWED_RESERVE = 3
const BATCH_INTERVAL_MIN = 15

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!verifyCronSecret(req, res)) return

  try {
    // Daily-interval data only updates once/day (see comment above) - without
    // this gate, this cron kept spending credits around the clock re-fetching
    // the same unchanged daily bar every 15 min overnight/weekends, a real
    // contributor to blowing through the free tier's 800-credit/day cap.
    if (!isMarketOpen()) {
      return res.status(200).json({ success: true, skipped: true, reason: 'market closed' })
    }

    const { sectorPool, followedPool, sectorBySymbol } = await getSwingUniverse()

    // A symbol that drops out of the universe entirely (its sector gets
    // deselected, or it's removed from a swing watchlist) never rotates back
    // into `batch` below - without this, its swing_trade_alerts row would sit
    // forever showing a stale RSI from whenever it was last actually checked,
    // since the refresh/delete logic further down only ever touches symbols
    // still in this run's batch. Cheap (no API cost) so it's safe to run every
    // invocation rather than only occasionally.
    const currentUniverse = new Set([...sectorPool, ...followedPool])
    const { data: existingAlerts } = await supabase.from('swing_trade_alerts').select('symbol')
    const orphanedSymbols = (existingAlerts || [])
      .map(r => r.symbol)
      .filter(symbol => !currentUniverse.has(symbol))
    if (orphanedSymbols.length > 0) {
      await supabase.from('swing_trade_alerts').delete().in('symbol', orphanedSymbols)
    }

    // Reserve slots for followed symbols; backfill unused reservation with sector-pool symbols
    const followedBatch = pickBatch(followedPool, FOLLOWED_RESERVE, BATCH_INTERVAL_MIN)
    const sectorBudget = BATCH_SIZE - followedBatch.length
    const sectorBatch = pickBatch(
      sectorPool.filter(s => !followedBatch.includes(s)),
      sectorBudget,
      BATCH_INTERVAL_MIN
    )

    const batch = Array.from(new Set([...followedBatch, ...sectorBatch]))

    const oversoldAlerts = []

    for (const symbol of batch) {
      const candles = await getDailyCandles(symbol)
      if (!candles || candles.length < 14) continue

      const closes = candles.map(c => c.close)
      await recordSnapshot(symbol, 'swing', candles)

      // Populates daily_levels (PDH/PDL/PDC + 20-day avg volume) for the whole swing
      // universe, not just the day-trade confluence indices - this alone is what
      // unlocks the gap scanner and swing RVOL, reusing the same cache-once-per-day
      // function IV detection already relies on. Passing the candles already fetched
      // above avoids a second API call on a cache-miss - without this, every symbol
      // with a cold cache would silently cost 2 credits instead of 1 in this loop.
      await getDailyLevels(symbol, candles)

      const rsiValues = calculateRSI(closes, 14)
      const currentRSI = rsiValues[rsiValues.length - 1]
      const spotPrice = closes[closes.length - 1]

      // Oversold loosened 30->35 (2026-09-02) after backtesting showed it
      // more than doubles CALL signal frequency (313->691 trades/2yr) for
      // only a ~1pt win-rate hit, while avg premium move stays solidly
      // positive (+12.9%->+6.1%) - see scripts/swingBacktestRun.ts
      // --rsi-oversold. Overbought/PUT threshold left at 70 since that side
      // isn't traded live anyway (execute-swings.ts is CALL-only, PUT
      // backtested net-losing).
      const direction: 'bullish' | 'bearish' | null =
        currentRSI < 35 ? 'bullish' : currentRSI > 70 ? 'bearish' : null

      if (direction) {
        const sector = sectorBySymbol[symbol] || 'other'
        const signalType = direction === 'bullish' ? 'CALL' : 'PUT'

        // Options/Greeks/IV-rank lookup only runs for a symbol that's actually
        // crossed an RSI threshold - same cost shape as the original
        // RSI-only version, just with a real Alpaca options lookup added on
        // top for the (much smaller) set of symbols that qualify.
        const opportunity = await evaluateSwingOpportunity(symbol, direction, spotPrice, currentRSI)
        const ivRankValue = opportunity?.ivRank?.rank ?? null
        // Cold start (ivRankValue === null, not enough IV history yet) always
        // passes - proceed on RSI alone rather than go silent for ~20 trading
        // days per symbol. Once a rank exists, apply the spec's real filter.
        const ivGatePass = ivRankValue === null
          || (signalType === 'CALL' ? ivRankValue < CALL_MAX_IV_RANK : ivRankValue > PUT_MIN_IV_RANK)

        if (!ivGatePass) {
          // RSI condition holds but premiums aren't cheap/rich enough yet per
          // a now-mature IV rank - same treatment as "not oversold/overbought
          // at all" below, rather than firing a lower-quality alert.
          await supabase.from('swing_trade_alerts').delete().eq('symbol', symbol)
          continue
        }

        // One row per symbol, kept up to date in place - a symbol that stays
        // oversold/overbought across many consecutive runs should update its
        // existing card's timestamp/RSI/options data, not stack up a new
        // duplicate card every run.
        const { data: existing } = await supabase
          .from('swing_trade_alerts')
          .select('id, entry_attempted')
          .eq('symbol', symbol)
          .maybeSingle()

        const { error } = await supabase
          .from('swing_trade_alerts')
          .upsert(
            {
              symbol, rsi_value: currentRSI, sector, oversold_date: new Date(),
              signal_type: signalType,
              option_symbol: opportunity?.strike.optionSymbol ?? null,
              expiration_date: opportunity?.strike.expirationDate ?? null,
              recommended_strike: opportunity?.strike.strikePrice ?? null,
              delta: opportunity?.strike.delta ?? null,
              gamma: opportunity?.strike.gamma ?? null,
              theta: opportunity?.strike.theta ?? null,
              vega: opportunity?.strike.vega ?? null,
              iv_current: opportunity?.strike.iv ?? null,
              iv_rank: ivRankValue,
              entry_rationale: opportunity?.rationale ?? null,
              bid_price: opportunity?.strike.bid ?? null,
              ask_price: opportunity?.strike.ask ?? null,
              ideal_entry_price: opportunity?.strike.idealEntryPrice ?? null,
              open_interest: opportunity?.strike.openInterest ?? null,
              liquidity_tier: opportunity?.strike.liquidityTier ?? null,
              // false only on a genuinely new occurrence - preserves
              // whatever execute-swings.ts already set on a re-check, so a
              // symbol that stays oversold across many runs never gets
              // re-entered (see migration 026's comment for the full
              // reasoning).
              entry_attempted: existing ? existing.entry_attempted : false
            },
            { onConflict: 'symbol' }
          )

        if (!error) {
          oversoldAlerts.push({ symbol, rsi: currentRSI, sector, signalType })
          // Only notify on a genuinely new occurrence, not every re-fire
          // while the symbol remains oversold/overbought across subsequent runs.
          if (!existing) {
            const strikeDetail = opportunity
              ? `, $${opportunity.strike.strikePrice}${signalType === 'CALL' ? 'C' : 'P'} Δ${opportunity.strike.delta.toFixed(2)}${ivRankValue !== null ? `, IV rank ${ivRankValue.toFixed(0)}%` : ''}, entry ~$${opportunity.strike.idealEntryPrice.toFixed(2)}`
              : ''
            await sendToTopic(
              ALERTS_TOPIC,
              `Swing Alert: ${symbol}`,
              `${direction === 'bullish' ? 'Oversold' : 'Overbought'} at RSI ${currentRSI.toFixed(1)} (${sector})${strikeDetail}`
            )
          }
          // Record today's real IV reading (if the options lookup succeeded)
          // for future IV-rank history - a separate write from the earlier
          // recordSnapshot call above since IV is only known after this
          // symbol was confirmed oversold/overbought.
          if (opportunity) {
            await recordSnapshot(symbol, 'swing', candles, { impliedVol: opportunity.strike.iv })
          }
        }
      } else {
        // No longer oversold or overbought - fall off the list rather than sit
        // there showing a stale RSI from whenever it last triggered.
        await supabase.from('swing_trade_alerts').delete().eq('symbol', symbol)
      }
    }

    res.status(200).json({ success: true, batch, oversoldAlerts })
  } catch (error) {
    console.error('Error in scan-swings:', error)
    res.status(500).json({ error: String(error) })
  }
}
