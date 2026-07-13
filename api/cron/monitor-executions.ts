import { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../server/supabaseAdmin.js'
import { verifyCronSecret } from '../../server/verifyCronSecret.js'
import { sendToTopic } from '../../server/firebase-notify.js'
import { ALERTS_TOPIC } from '../register-token.js'
import { getOrder, cancelOrder, replaceOrder, placeOrder, getBars1Min } from '../../server/execution/alpacaClient.js'
import { placeProtectiveOrders } from '../../server/execution/protectiveOrders.js'
import { clientOrderIds } from '../../server/execution/clientOrderIds.js'

export const config = {
  maxDuration: 60
}

// Intentionally does NOT check execution_settings.is_enabled - the kill switch
// only prevents new entries (see execute-alerts.ts). Pausing new entries must
// never mean "stop protecting positions already open."

// A grace period before treating a stuck 'claimed'/'entry_submitted' row as
// needing reconciliation - comfortably past a normal happy-path completion.
const RECONCILE_GRACE_MS = 2 * 60 * 1000
const MAX_RECONCILE_ATTEMPTS = 3

interface ExecutionRow {
  id: string
  profit_target_id: string
  symbol: string
  direction: 'bullish' | 'bearish'
  execution_status: string
  qty: number | null
  remaining_qty: number | null
  entry_order_id: string | null
  stop_order_id: string | null
  tier1_order_id: string | null
  tier2_order_id: string | null
  tier3_order_id: string | null
  reconciliation_attempts: number
  claimed_at: string
  profit_targets: {
    entry_price: number
    stop_loss_price: number | null
    milestone_10_price: number | null
    milestone_20_price: number | null
    milestone_30_price: number | null
  } | null
}

const cancelIfOpen = async (orderId: string | null) => {
  if (!orderId) return
  const order = await getOrder(orderId)
  if (order && ['new', 'accepted', 'partially_filled', 'pending_new'].includes(order.status)) {
    await cancelOrder(orderId)
  }
}

const notifyManualReview = async (symbol: string, reason: string) => {
  await sendToTopic(ALERTS_TOPIC, `Bot: manual review needed (${symbol})`, reason)
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!verifyCronSecret(req, res)) return

  try {
    const { data: settingsRow, error: settingsError } = await supabase
      .from('execution_settings')
      .select('hard_stop_pct')
      .eq('id', 1)
      .single()
    if (settingsError) throw settingsError
    const hardStopPct = settingsRow.hard_stop_pct as number

    const { data: rows, error: rowsError } = await supabase
      .from('trade_executions')
      .select('*, profit_targets(entry_price, stop_loss_price, milestone_10_price, milestone_20_price, milestone_30_price)')
      .in('execution_status', ['claimed', 'entry_submitted', 'entry_filled', 'protective_orders_placed', 'protective_orders_partial'])

    if (rowsError) throw rowsError

    let managed = 0
    let closed = 0

    for (const row of (rows || []) as ExecutionRow[]) {
      try {
        // --- Stuck claim/entry-submit reconciliation ---
        if (row.execution_status === 'claimed' || row.execution_status === 'entry_submitted') {
          const stuckMs = Date.now() - new Date(row.claimed_at).getTime()
          if (stuckMs < RECONCILE_GRACE_MS) continue

          if (row.execution_status === 'entry_submitted' && row.entry_order_id) {
            const entryOrder = await getOrder(row.entry_order_id)
            if (entryOrder?.status === 'filled') {
              await supabase.from('trade_executions').update({
                execution_status: 'entry_filled', qty: Math.round(parseFloat(entryOrder.filled_qty)), remaining_qty: Math.round(parseFloat(entryOrder.filled_qty))
              }).eq('id', row.id)
              continue
            }
            if (entryOrder && ['canceled', 'expired', 'rejected'].includes(entryOrder.status)) {
              await supabase.from('trade_executions').update({ execution_status: 'entry_failed' }).eq('id', row.id)
              continue
            }
          }

          const attempts = row.reconciliation_attempts + 1
          if (attempts >= MAX_RECONCILE_ATTEMPTS) {
            await supabase.from('trade_executions').update({
              needs_manual_review: true, review_reason: 'entry stuck past reconciliation retry cap', reconciliation_attempts: attempts
            }).eq('id', row.id)
            await notifyManualReview(row.symbol, 'Entry order stuck, needs manual review')
          } else {
            await supabase.from('trade_executions').update({ reconciliation_attempts: attempts }).eq('id', row.id)
          }
          continue
        }

        if (!row.profit_targets || !row.qty) continue
        managed++
        const isBullish = row.direction === 'bullish'
        const exitSide = isBullish ? 'sell' : 'buy'
        const entryPrice = row.profit_targets.entry_price

        // --- Reconciliation for partially-placed protective orders ---
        if (row.execution_status === 'protective_orders_partial' && row.reconciliation_attempts < MAX_RECONCILE_ATTEMPTS) {
          const alloc = {
            tier1: row.tier1_order_id ? 0 : Math.floor(row.qty * 0.3),
            tier2: row.tier2_order_id ? 0 : Math.floor(row.qty * 0.3),
            tier3: row.tier3_order_id ? 0 : Math.floor(row.qty * 0.3)
          }
          const result = await placeProtectiveOrders(
            {
              symbol: row.symbol, exitSide, qty: row.remaining_qty ?? row.qty,
              stopPrice: row.profit_targets.stop_loss_price ?? entryPrice,
              tierQty: alloc,
              tierPrices: {
                tier1: row.profit_targets.milestone_10_price ?? entryPrice,
                tier2: row.profit_targets.milestone_20_price ?? entryPrice,
                tier3: row.profit_targets.milestone_30_price ?? entryPrice
              },
              ids: clientOrderIds(row.profit_target_id)
            },
            { stopOrderId: row.stop_order_id, tier1OrderId: row.tier1_order_id, tier2OrderId: row.tier2_order_id, tier3OrderId: row.tier3_order_id }
          )
          const attempts = row.reconciliation_attempts + 1
          const stillPartial = !!result.failure
          await supabase.from('trade_executions').update({
            execution_status: stillPartial ? 'protective_orders_partial' : 'protective_orders_placed',
            stop_order_id: result.stopOrderId,
            tier1_order_id: result.tier1OrderId,
            tier2_order_id: result.tier2OrderId,
            tier3_order_id: result.tier3OrderId,
            reconciliation_attempts: attempts,
            needs_manual_review: stillPartial && attempts >= MAX_RECONCILE_ATTEMPTS,
            review_reason: stillPartial ? result.failure : null
          }).eq('id', row.id)
          if (stillPartial && attempts >= MAX_RECONCILE_ATTEMPTS) {
            await notifyManualReview(row.symbol, `Protective orders still incomplete after ${attempts} attempts: ${result.failure}`)
          }
          row.stop_order_id = result.stopOrderId
          row.tier1_order_id = result.tier1OrderId
          row.tier2_order_id = result.tier2OrderId
          row.tier3_order_id = result.tier3OrderId
        }

        // --- Has the resting stop already filled? ---
        if (row.stop_order_id) {
          const stopOrder = await getOrder(row.stop_order_id)
          if (stopOrder?.status === 'filled') {
            await cancelIfOpen(row.tier1_order_id)
            await cancelIfOpen(row.tier2_order_id)
            await cancelIfOpen(row.tier3_order_id)
            await supabase.from('trade_executions').update({ execution_status: 'closed_stop', remaining_qty: 0 }).eq('id', row.id)
            closed++
            continue
          }
        }

        // --- Tier fill detection + stop ratchet ---
        const tierOrderFields: Array<{ key: 'tier1' | 'tier2' | 'tier3'; id: string | null }> = [
          { key: 'tier1', id: row.tier1_order_id },
          { key: 'tier2', id: row.tier2_order_id },
          { key: 'tier3', id: row.tier3_order_id }
        ]
        let filledTierQty = 0
        let placedTierCount = 0
        let filledTierCount = 0
        for (const tier of tierOrderFields) {
          if (!tier.id) continue
          placedTierCount++
          const order = await getOrder(tier.id)
          if (!order) continue
          filledTierQty += parseFloat(order.filled_qty) || 0
          if (order.status === 'filled') filledTierCount++
        }

        const remainingQty = row.qty - Math.round(filledTierQty)

        if (remainingQty <= 0) {
          await cancelIfOpen(row.stop_order_id)
          await supabase.from('trade_executions').update({ execution_status: 'closed_target', remaining_qty: 0 }).eq('id', row.id)
          closed++
          continue
        }

        const allTiersFilled = placedTierCount > 0 && filledTierCount === placedTierCount
        const desiredStopPrice = allTiersFilled ? entryPrice : (row.profit_targets.stop_loss_price ?? entryPrice)

        if (row.stop_order_id) {
          const currentStop = await getOrder(row.stop_order_id)
          const currentQty = currentStop ? Math.round(parseFloat(currentStop.qty)) : null
          const needsQtyUpdate = currentQty !== null && currentQty !== remainingQty
          const needsPriceUpdate = allTiersFilled // only ever ratchets one direction, to breakeven
          if (currentStop && (needsQtyUpdate || needsPriceUpdate)) {
            try {
              await replaceOrder(row.stop_order_id, { qty: remainingQty, stopPrice: desiredStopPrice })
            } catch (e) {
              await supabase.from('trade_executions').update({
                needs_manual_review: true, review_reason: `failed to ratchet stop: ${String(e)}`
              }).eq('id', row.id)
              await notifyManualReview(row.symbol, `Failed to ratchet resting stop: ${String(e)}`)
            }
          }
        }

        if (remainingQty !== (row.remaining_qty ?? row.qty)) {
          await supabase.from('trade_executions').update({ remaining_qty: remainingQty }).eq('id', row.id)
        }

        // --- Catastrophic backstop: hard_stop_pct on a CLOSED 1-min candle ---
        // Independent of the resting stop above - covers gap-throughs or a
        // resting stop order that was rejected/cancelled for some reason.
        const now = new Date()
        const bars = await getBars1Min(row.symbol, new Date(now.getTime() - 10 * 60 * 1000), now)
        const closedBars = (bars || []).filter(b => new Date(b.t).getTime() + 60_000 <= now.getTime())
        const lastClosed = closedBars[closedBars.length - 1]

        if (lastClosed) {
          const adverseMove = isBullish
            ? (entryPrice - lastClosed.c) / entryPrice
            : (lastClosed.c - entryPrice) / entryPrice

          if (adverseMove >= hardStopPct) {
            await cancelIfOpen(row.stop_order_id)
            await cancelIfOpen(row.tier1_order_id)
            await cancelIfOpen(row.tier2_order_id)
            await cancelIfOpen(row.tier3_order_id)

            try {
              await placeOrder({
                symbol: row.symbol, qty: remainingQty, side: exitSide, type: 'market', timeInForce: 'day',
                clientOrderId: clientOrderIds(row.profit_target_id).hardStop
              })
              await supabase.from('trade_executions').update({
                execution_status: 'closed_hard_stop', remaining_qty: 0,
                needs_manual_review: true, review_reason: `hard stop triggered: ${(adverseMove * 100).toFixed(1)}% adverse on closed candle`
              }).eq('id', row.id)
              await notifyManualReview(row.symbol, `Hard stop triggered - flattened at market (${(adverseMove * 100).toFixed(1)}% adverse move)`)
              closed++
            } catch (e) {
              await supabase.from('trade_executions').update({
                needs_manual_review: true, review_reason: `hard stop flatten failed: ${String(e)}`
              }).eq('id', row.id)
              await notifyManualReview(row.symbol, `CRITICAL: hard stop triggered but flatten order failed: ${String(e)}`)
            }
          }
        }
      } catch (rowError) {
        console.error(`Error monitoring execution ${row.id} (${row.symbol}):`, rowError)
        await supabase.from('trade_executions').update({
          needs_manual_review: true, review_reason: String(rowError)
        }).eq('id', row.id)
      }
    }

    res.status(200).json({ success: true, managed, closed })
  } catch (error) {
    console.error('Error in monitor-executions:', error)
    res.status(500).json({ error: String(error) })
  }
}
