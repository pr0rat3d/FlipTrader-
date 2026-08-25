import { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../server/supabaseAdmin.js'
import { verifyCronSecret } from '../../server/verifyCronSecret.js'
import { isMarketOpen } from '../../server/marketHours.js'
import { getOrder, getOptionQuote, placeOrder, describeAlpacaError } from '../../server/execution/alpacaClient.js'
import { swingClientOrderIds } from '../../server/execution/clientOrderIds.js'
import { PROFIT_TARGET_PCT, STOP_LOSS_PCT, DAYS_TO_EXPIRY_FORCE_CLOSE } from '../../server/execution/swingPositionSizing.js'
import { sendToTopic } from '../../server/firebase-notify.js'
import { ALERTS_TOPIC } from '../register-token.js'

export const config = {
  maxDuration: 60
}

// Manages already-placed swing positions (server/execution/
// swingPositionSizing.ts's spec: +30% target / -35% stop / exit within 3
// trading days of expiry, single full exit - no tier ladder, swing sizes
// are too small (1-3 contracts) to scale out of). Deliberately meant to run
// at a MUCH coarser cadence than monitor-executions.ts's once-a-minute
// (a few times a day is plenty for a multi-day hold, and this is
// effectively free on the Vercel CPU budget that mattered for the 0DTE
// side - see project memory's 2026-08-24 Fluid Active CPU section) - the
// external cron-job.org schedule controls that, this code has no cadence
// assumption baked in.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!verifyCronSecret(req, res)) return

  try {
    if (!isMarketOpen()) {
      return res.status(200).json({ success: true, skipped: true, reason: 'market closed' })
    }

    let reconciled = 0
    let closed = 0

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

    // --- Manage open positions ---
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

        closed++
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

    res.status(200).json({ success: true, reconciled, closed })
  } catch (error) {
    console.error('Error in monitor-swing-executions:', error)
    res.status(500).json({ success: false, error: String(error) })
  }
}
