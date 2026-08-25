import { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../server/supabaseAdmin.js'
import { verifyCronSecret } from '../../server/verifyCronSecret.js'
import { isMarketOpen } from '../../server/marketHours.js'
import { getAccount, placeOrder, describeAlpacaError } from '../../server/execution/alpacaClient.js'
import { computeSwingContractCount } from '../../server/execution/swingPositionSizing.js'
import { swingClientOrderIds } from '../../server/execution/clientOrderIds.js'
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
// Trades against the alert row's ALREADY-COMPUTED strike/price data (from
// the same scan-swings.ts run that just fired it) rather than re-fetching
// a fresh quote first - unlike 0DTE, a multi-week swing entry doesn't need
// to chase a fast-moving price, and this keeps the entry price consistent
// with what evaluateSwingOpportunity's ideal-entry-price math actually
// computed.
//
// LIMIT order at ideal_entry_price, not market - the whole point of this
// project's liquidity-tier-aware entry pricing (server/swingOptionSelection.
// ts's computeIdealEntryPrice) is defeated by a market order that just
// pays the ask regardless.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!verifyCronSecret(req, res)) return

  try {
    if (!isMarketOpen()) {
      return res.status(200).json({ success: true, skipped: true, reason: 'market closed' })
    }

    const { data: pending } = await supabase
      .from('swing_trade_alerts')
      .select('id, symbol, signal_type, option_symbol, expiration_date, recommended_strike, ideal_entry_price, bid_price, ask_price, oversold_date')
      .eq('signal_type', 'CALL')
      .eq('entry_attempted', false)
      .not('option_symbol', 'is', null)

    if (!pending || pending.length === 0) {
      return res.status(200).json({ success: true, entriesAttempted: 0 })
    }

    const { count: openCount } = await supabase
      .from('swing_positions')
      .select('*', { count: 'exact', head: true })
      .in('status', ['entry_submitted', 'open'])
    let currentOpenPositions = openCount ?? 0

    const account = await getAccount('swing')
    if (!account) {
      return res.status(200).json({ success: false, reason: 'could not fetch swing account - is ALPACA_SWING_API_KEY_ID/SECRET set?' })
    }

    const results: { symbol: string; outcome: string }[] = []

    for (const alert of pending) {
      // Marked attempted regardless of outcome below (success or any
      // failure) - one shot per oversold episode, same as every other
      // entry gate in this app. Done first so a thrown error partway
      // through this alert's own handling still can't loop-retry it
      // forever on the next invocation.
      await supabase.from('swing_trade_alerts').update({ entry_attempted: true }).eq('id', alert.id)

      if (!alert.ideal_entry_price || !alert.ask_price || !alert.recommended_strike || !alert.expiration_date) {
        results.push({ symbol: alert.symbol, outcome: 'skipped: incomplete pricing data' })
        continue
      }

      const ageMinutes = (Date.now() - new Date(alert.oversold_date).getTime()) / 60_000
      if (ageMinutes > STALENESS_CUTOFF_MINUTES) {
        results.push({ symbol: alert.symbol, outcome: `skipped: stale (${ageMinutes.toFixed(0)}min old pricing)` })
        continue
      }

      const sizing = computeSwingContractCount({
        buyingPower: account.buying_power,
        riskPct: 0.15,
        premiumAsk: alert.ask_price,
        currentOpenPositions
      })

      if (!sizing.ok) {
        results.push({ symbol: alert.symbol, outcome: `skipped: ${sizing.reason}` })
        continue
      }

      try {
        const ids = swingClientOrderIds(alert.id)
        const order = await placeOrder({
          symbol: alert.option_symbol!,
          qty: sizing.contracts,
          side: 'buy',
          type: 'limit',
          timeInForce: 'day',
          limitPrice: alert.ideal_entry_price,
          clientOrderId: ids.entry
        }, 'swing')

        await supabase.from('swing_positions').insert({
          underlying_symbol: alert.symbol,
          option_symbol: alert.option_symbol,
          direction: 'bullish',
          contracts: sizing.contracts,
          premium_entry: alert.ideal_entry_price,
          strike_price: alert.recommended_strike,
          expiration_date: alert.expiration_date,
          status: 'entry_submitted',
          entry_order_id: order.id
        })

        currentOpenPositions++
        results.push({ symbol: alert.symbol, outcome: `submitted: ${sizing.contracts}x @ $${alert.ideal_entry_price}` })
        await sendToTopic(ALERTS_TOPIC, `Swing entry: ${alert.symbol}`, `${sizing.contracts}x $${alert.recommended_strike}C exp ${alert.expiration_date}, limit $${alert.ideal_entry_price}`)
      } catch (error) {
        results.push({ symbol: alert.symbol, outcome: `order failed: ${describeAlpacaError(error)}` })
      }
    }

    res.status(200).json({ success: true, entriesAttempted: pending.length, results })
  } catch (error) {
    console.error('Error in execute-swings:', error)
    res.status(500).json({ success: false, error: String(error) })
  }
}
