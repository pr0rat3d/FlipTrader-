import { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../server/supabaseAdmin.js'
import { verifyCronSecret } from '../../server/verifyCronSecret.js'
import { isMarketOpen } from '../../server/marketHours.js'
import { getAccount, getOrder, getOptionQuote, getBars5Min, placeOrder, describeAlpacaError } from '../../server/execution/alpacaClient.js'
import { computeSwingContractCount, MIN_CONTRACTS, MAX_POSITION_DOLLARS, PROFIT_TARGET_PCT, STOP_LOSS_PCT, DAYS_TO_EXPIRY_FORCE_CLOSE } from '../../server/execution/swingPositionSizing.js'
import { swingClientOrderIds } from '../../server/execution/clientOrderIds.js'
import { selectSwingStrike } from '../../server/swingOptionSelection.js'
import { sendToTopic } from '../../server/firebase-notify.js'
import { ALERTS_TOPIC } from '../register-token.js'

export const config = {
  maxDuration: 60
}

// A pending alert isn't re-checked/refreshed while the market's closed
// (scan-swings.ts itself is gated on isMarketOpen, and swing_trade_alerts
// rows persist across a weekend/holiday until RSI actually moves back out
// of range) - without this, an alert sitting since Friday afternoon would
// get entered Monday morning against Friday's now-stale bid/ask/
// ideal_entry_price after a full weekend gap. More generous than
// day-trading's 5-minute LEG_STALENESS_CUTOFF_MINUTES (execute-alerts.ts)
// since swing pricing doesn't need 0DTE-grade freshness, but still a real
// cutoff, not none at all.
const STALENESS_CUTOFF_MINUTES = 90

// Real swing execution (2026-08-25) - CALL/oversold signals ONLY, per user
// decision after scripts/swingBacktestRun.ts showed PUT/overbought signals
// net-losing under the same exit spec (+11.7% avg premium move for CALLs
// vs -3.1% for PUTs, 2-year/1,108-trade sample). scan-swings.ts stays
// alert-detection-only; this claims `entry_attempted=false` CALL alerts
// and places real orders against the separate 'swing' Alpaca account
// (server/execution/alpacaClient.ts) - mirrors the existing day-trading
// split (scan-confluence.ts detects, execute-alerts.ts trades).
//
// Also owns exit management (originally a separate monitor-swing-
// executions.ts, merged into this file 2026-08-25 - the Vercel Hobby plan
// caps a deployment at 12 serverless functions, and this project was
// already at 11 before adding any swing endpoints at all). One cadence
// for both isn't a real cost: entries need a tighter check to catch fresh
// alerts before STALENESS_CUTOFF_MINUTES, and running exit checks on that
// same schedule is cheap (a few lightweight queries/quote calls per open
// position, not per-minute heavy work the way 0DTE's monitor-executions.ts
// is) - unlike that file, this was never a Fluid Active CPU concern in the
// first place.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!verifyCronSecret(req, res)) return

  try {
    if (!isMarketOpen()) {
      return res.status(200).json({ success: true, skipped: true, reason: 'market closed' })
    }

    let reconciled = 0
    let closedCount = 0

    // --- Reconcile entry fills ---
    const { data: submitted } = await supabase
      .from('swing_positions')
      .select('id, entry_order_id, premium_entry')
      .eq('status', 'entry_submitted')

    for (const position of submitted ?? []) {
      if (!position.entry_order_id) continue
      const order = await getOrder(position.entry_order_id, 'swing')
      if (order?.status === 'filled') {
        const fillPrice = order.filled_avg_price ? parseFloat(order.filled_avg_price) : position.premium_entry
        await supabase.from('swing_positions').update({ status: 'open', premium_entry: fillPrice }).eq('id', position.id)
        reconciled++
      } else if (order && ['canceled', 'expired', 'rejected'].includes(order.status)) {
        await supabase.from('swing_positions').update({ status: 'entry_failed', closed_at: new Date().toISOString() }).eq('id', position.id)
        reconciled++
      }
      // else: still resting - nothing to do, day-TIF order will fill,
      // expire, or get checked again next invocation.
    }

    // --- Manage open positions against the single full-exit spec (+30%
    // target / -35% stop / exit within 3 trading days of expiry - no tier
    // ladder, swing sizes are too small to scale out of) ---
    const { data: open } = await supabase
      .from('swing_positions')
      .select('id, underlying_symbol, option_symbol, contracts, premium_entry, expiration_date')
      .eq('status', 'open')

    const now = new Date()

    for (const position of open ?? []) {
      const quote = await getOptionQuote(position.option_symbol, 'swing')
      if (!quote || quote.bid <= 0) continue

      const pctMove = (quote.bid - position.premium_entry) / position.premium_entry
      const daysToExpiry = Math.round((new Date(position.expiration_date).getTime() - now.getTime()) / (24 * 60 * 60 * 1000))

      let closeReason: 'closed_target' | 'closed_stop' | 'closed_time_exit' | null = null
      if (pctMove >= PROFIT_TARGET_PCT) closeReason = 'closed_target'
      else if (pctMove <= -STOP_LOSS_PCT) closeReason = 'closed_stop'
      else if (daysToExpiry <= DAYS_TO_EXPIRY_FORCE_CLOSE) closeReason = 'closed_time_exit'

      if (!closeReason) continue

      try {
        const ids = swingClientOrderIds(position.id)
        await placeOrder({
          symbol: position.option_symbol,
          qty: position.contracts,
          side: 'sell',
          type: 'market',
          timeInForce: 'day',
          clientOrderId: ids.exit(1)
        }, 'swing')

        await supabase.from('swing_positions').update({
          status: closeReason,
          exit_price: quote.bid,
          closed_at: now.toISOString()
        }).eq('id', position.id)

        closedCount++
        await sendToTopic(
          ALERTS_TOPIC,
          `Swing exit: ${position.underlying_symbol}`,
          `${closeReason.replace('closed_', '')} at ${(pctMove * 100).toFixed(1)}% (${daysToExpiry}d to expiry)`
        )
      } catch (error) {
        await supabase.from('swing_positions').update({
          needs_manual_review: true,
          review_reason: `exit order failed (${closeReason}): ${describeAlpacaError(error)}`
        }).eq('id', position.id)
        await sendToTopic(ALERTS_TOPIC, `Swing bot: manual review (${position.underlying_symbol})`, `Exit order failed - ${describeAlpacaError(error)}`)
      }
    }

    // --- New entries: claims entry_attempted=false CALL alerts, sizes via
    // swingPositionSizing.ts, places a LIMIT order at the already-computed
    // ideal_entry_price (not market - defeats the point of the liquidity-
    // aware entry pricing otherwise) ---
    const { data: pending } = await supabase
      .from('swing_trade_alerts')
      .select('id, symbol, signal_type, option_symbol, expiration_date, recommended_strike, ideal_entry_price, bid_price, ask_price, oversold_date')
      .eq('signal_type', 'CALL')
      .eq('entry_attempted', false)
      .not('option_symbol', 'is', null)

    const entryResults: { symbol: string; outcome: string }[] = []

    if (pending && pending.length > 0) {
      const { count: openCount } = await supabase
        .from('swing_positions')
        .select('*', { count: 'exact', head: true })
        .in('status', ['entry_submitted', 'open'])
      let currentOpenPositions = openCount ?? 0

      const account = await getAccount('swing')

      for (const alert of pending) {
        // Marked attempted regardless of outcome below (success or any
        // failure) - one shot per oversold episode, same as every other
        // entry gate in this app.
        await supabase.from('swing_trade_alerts').update({ entry_attempted: true }).eq('id', alert.id)

        if (!account) {
          entryResults.push({ symbol: alert.symbol, outcome: 'skipped: swing account unavailable (check ALPACA_SWING_API_KEY_ID/SECRET)' })
          continue
        }
        if (!alert.ideal_entry_price || !alert.ask_price || !alert.recommended_strike || !alert.expiration_date) {
          entryResults.push({ symbol: alert.symbol, outcome: 'skipped: incomplete pricing data' })
          continue
        }

        const ageMinutes = (Date.now() - new Date(alert.oversold_date).getTime()) / 60_000
        if (ageMinutes > STALENESS_CUTOFF_MINUTES) {
          entryResults.push({ symbol: alert.symbol, outcome: `skipped: stale (${ageMinutes.toFixed(0)}min old pricing)` })
          continue
        }

        // The alert's own strike (picked purely by delta-closest-to-0.40,
        // see swingOptionSelection.ts) may be too rich to afford
        // MIN_CONTRACTS within MAX_POSITION_DOLLARS - "move out a few
        // strikes to make it fit" (user's framing, 2026-08-26) rather than
        // skip a real signal over one specific strike being pricey.
        // Re-runs strike selection with an affordability filter, biased
        // toward a fresh live spot (5-min bar close, Alpaca - not another
        // Twelve Data credit spend) rather than reusing the alert's own
        // possibly-stale spot-derived numbers.
        let optionSymbol = alert.option_symbol!
        let strikePrice = alert.recommended_strike
        let entryPrice = alert.ideal_entry_price
        let askPrice = alert.ask_price

        const maxPremium = MAX_POSITION_DOLLARS / (MIN_CONTRACTS * 100)
        if (askPrice > maxPremium) {
          const bars = await getBars5Min(alert.symbol, 2, 'swing')
          const spot = bars && bars.length > 0 ? bars[bars.length - 1].close : null
          const cheaper = spot
            ? await selectSwingStrike(alert.symbol, 'bullish', alert.expiration_date, spot, maxPremium)
            : null

          if (!cheaper) {
            entryResults.push({ symbol: alert.symbol, outcome: `skipped: no affordable strike found under $${MAX_POSITION_DOLLARS}/${MIN_CONTRACTS}` })
            continue
          }
          optionSymbol = cheaper.optionSymbol
          strikePrice = cheaper.strikePrice
          entryPrice = cheaper.idealEntryPrice
          askPrice = cheaper.ask
        }

        const sizing = computeSwingContractCount({
          buyingPower: account.buying_power,
          premiumAsk: askPrice,
          currentOpenPositions
        })

        if (!sizing.ok) {
          entryResults.push({ symbol: alert.symbol, outcome: `skipped: ${sizing.reason}` })
          continue
        }

        try {
          const ids = swingClientOrderIds(alert.id)
          const order = await placeOrder({
            symbol: optionSymbol,
            qty: sizing.contracts,
            side: 'buy',
            type: 'limit',
            timeInForce: 'day',
            limitPrice: entryPrice,
            clientOrderId: ids.entry
          }, 'swing')

          await supabase.from('swing_positions').insert({
            underlying_symbol: alert.symbol,
            option_symbol: optionSymbol,
            direction: 'bullish',
            contracts: sizing.contracts,
            premium_entry: entryPrice,
            strike_price: strikePrice,
            expiration_date: alert.expiration_date,
            status: 'entry_submitted',
            entry_order_id: order.id
          })

          currentOpenPositions++
          entryResults.push({ symbol: alert.symbol, outcome: `submitted: ${sizing.contracts}x @ $${entryPrice} (strike $${strikePrice})` })
          await sendToTopic(ALERTS_TOPIC, `Swing entry: ${alert.symbol}`, `${sizing.contracts}x $${strikePrice}C exp ${alert.expiration_date}, limit $${entryPrice}`)
        } catch (error) {
          entryResults.push({ symbol: alert.symbol, outcome: `order failed: ${describeAlpacaError(error)}` })
        }
      }
    }

    res.status(200).json({ success: true, reconciled, closed: closedCount, entriesAttempted: pending?.length ?? 0, entryResults })
  } catch (error) {
    console.error('Error in execute-swings:', error)
    res.status(500).json({ success: false, error: String(error) })
  }
}
