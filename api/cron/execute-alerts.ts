import { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../server/supabaseAdmin.js'
import { verifyCronSecret } from '../../server/verifyCronSecret.js'
import { isMarketOpen, hasSessionClosedSince } from '../../server/marketHours.js'
import { getQuote } from '../../server/finnhub.js'
import { getAccount, placeOrder, getOrder } from '../../server/execution/alpacaClient.js'
import { computeOrderPlan, allocateScaleOutQty, isQuietSkipReason, OrderPlanSettings } from '../../server/execution/positionSizing.js'
import { clientOrderIds } from '../../server/execution/clientOrderIds.js'
import { placeProtectiveOrders } from '../../server/execution/protectiveOrders.js'

export const config = {
  maxDuration: 60
}

// A market order should fill almost immediately in liquid names like these -
// poll briefly rather than assuming instant fill, but don't wait long.
const FILL_POLL_ATTEMPTS = 8
const FILL_POLL_INTERVAL_MS = 1000
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// A market order chasing a signal that already moved is worse than no trade -
// skip if the current price has drifted too far from the alert's entry_price
// since this cron runs on a 1-2 min cadence, not instantly on signal creation.
const STALENESS_THRESHOLD_PCT = 0.005

interface OpenLeg {
  id: string
  symbol: string
  entry_price: number
  entry_time: string
  stop_loss_price: number | null
  milestone_10_price: number | null
  milestone_20_price: number | null
  milestone_30_price: number | null
  // A profit_targets row's day_trade_alert_id is a many-to-one FK (many legs,
  // one alert) - PostgREST embeds a many-to-one relationship as a single
  // object, not an array. Confirmed empirically against the live API (2026-
  // 07-14): a leg.day_trade_alerts?.[0]?.macd_curl read here was silently
  // undefined on every single leg, forever, since `[0]` indexes into a plain
  // object rather than an array - the execution bot had never once actually
  // claimed a trade since it was built, despite legs clearing confidence and
  // is_enabled being true the whole time.
  day_trade_alerts: { macd_curl: 'bullish' | 'bearish'; confidence: number | null } | null
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!verifyCronSecret(req, res)) return

  try {
    const { data: settingsRow, error: settingsError } = await supabase
      .from('execution_settings')
      .select('*')
      .eq('id', 1)
      .single()

    if (settingsError) throw settingsError
    if (!settingsRow.is_enabled) {
      return res.status(200).json({ success: true, skipped: true, reason: 'execution disabled' })
    }

    if (!isMarketOpen()) {
      return res.status(200).json({ success: true, skipped: true, reason: 'market closed' })
    }

    const settings: OrderPlanSettings = {
      riskPct: settingsRow.risk_pct,
      minQty: settingsRow.min_qty,
      maxQty: settingsRow.max_qty,
      minAccountEquity: settingsRow.min_account_equity,
      maxAccountEquity: settingsRow.max_account_equity
    }

    const { data: legs, error: legsError } = await supabase
      .from('profit_targets')
      .select('id, symbol, entry_price, entry_time, stop_loss_price, milestone_10_price, milestone_20_price, milestone_30_price, day_trade_alerts(macd_curl, confidence)')
      .eq('status', 'open')

    if (legsError) throw legsError
    if (!legs || legs.length === 0) {
      return res.status(200).json({ success: true, processed: 0 })
    }

    // Skip legs that already have a trade_executions row (claimed by this or a
    // prior overlapping invocation) in one query rather than N.
    const { data: existing, error: existingError } = await supabase
      .from('trade_executions')
      .select('profit_target_id')
      .in('profit_target_id', legs.map((l: any) => l.id))
    if (existingError) throw existingError
    const alreadyClaimed = new Set((existing || []).map((e: any) => e.profit_target_id))

    let processed = 0
    let entered = 0

    // supabase-js's inferred type for this embed says array (it can't statically
    // know the FK is many-to-one), but the actual runtime shape - confirmed
    // empirically against the live API - is a single object. Cast through
    // unknown rather than "fixing" this back to array indexing, which is
    // exactly the mismatch that caused this bug in the first place.
    for (const leg of legs as unknown as OpenLeg[]) {
      if (alreadyClaimed.has(leg.id)) continue

      const direction = leg.day_trade_alerts?.macd_curl
      const confidence = leg.day_trade_alerts?.confidence ?? 0
      if (!direction) continue
      if (confidence < settingsRow.min_confidence) continue

      // Atomic claim - INSERT ... ON CONFLICT DO NOTHING is safe by construction
      // (unique-index conflict resolution), unlike a SELECT-then-UPDATE pattern
      // which would be vulnerable to two overlapping cron invocations both
      // reading "unclaimed" before either writes.
      const { data: claimed, error: claimError } = await supabase
        .from('trade_executions')
        .insert({ profit_target_id: leg.id, symbol: leg.symbol, direction })
        .select()
      if (claimError) {
        // Unique violation just means another invocation claimed it first - skip silently.
        if ((claimError as any).code === '23505') continue
        throw claimError
      }
      if (!claimed || claimed.length === 0) continue

      const executionId = claimed[0].id
      processed++

      try {
        if (hasSessionClosedSince(new Date(leg.entry_time))) {
          await supabase.from('trade_executions').update({ execution_status: 'skipped_session_closed' }).eq('id', executionId)
          continue
        }

        const account = await getAccount()
        if (!account) {
          await supabase.from('trade_executions').update({
            execution_status: 'needs_manual_review', needs_manual_review: true, review_reason: 'failed to fetch Alpaca account'
          }).eq('id', executionId)
          continue
        }

        const plan = computeOrderPlan({
          direction,
          entryPrice: leg.entry_price,
          stopLossPrice: leg.stop_loss_price,
          milestone10Price: leg.milestone_10_price,
          milestone20Price: leg.milestone_20_price,
          milestone30Price: leg.milestone_30_price,
          accountEquity: account.equity,
          buyingPower: account.buying_power
        }, settings)

        if (!plan.ok) {
          await supabase.from('trade_executions').update({
            execution_status: isQuietSkipReason(plan.reason) ? 'skipped_bad_data' : 'needs_manual_review',
            needs_manual_review: !isQuietSkipReason(plan.reason),
            review_reason: plan.reason,
            account_equity_at_entry: account.equity
          }).eq('id', executionId)
          continue
        }

        const quote = await getQuote(leg.symbol)
        if (quote?.c && Math.abs(quote.c - leg.entry_price) / leg.entry_price > STALENESS_THRESHOLD_PCT) {
          await supabase.from('trade_executions').update({
            execution_status: 'skipped_stale', account_equity_at_entry: account.equity
          }).eq('id', executionId)
          continue
        }

        const ids = clientOrderIds(leg.id)
        const isBullish = direction === 'bullish'
        const entrySide = isBullish ? 'buy' : 'sell'
        const exitSide = isBullish ? 'sell' : 'buy'

        let entryOrder
        try {
          entryOrder = await placeOrder({
            symbol: leg.symbol, qty: plan.qty, side: entrySide, type: 'market', timeInForce: 'day', clientOrderId: ids.entry
          })
        } catch (e) {
          // Buying-power/PDT-style rejections are an expected, handled outcome
          // for a small account trading higher-priced tickers - not exceptional.
          await supabase.from('trade_executions').update({
            execution_status: 'entry_failed', account_equity_at_entry: account.equity, review_reason: String(e)
          }).eq('id', executionId)
          continue
        }

        await supabase.from('trade_executions').update({
          execution_status: 'entry_submitted',
          qty: plan.qty,
          account_equity_at_entry: account.equity,
          entry_order_id: entryOrder.id,
          entry_client_order_id: ids.entry
        }).eq('id', executionId)

        let filled = false
        for (let i = 0; i < FILL_POLL_ATTEMPTS; i++) {
          const status = await getOrder(entryOrder.id)
          if (status?.status === 'filled') { filled = true; break }
          if (status && ['canceled', 'expired', 'rejected'].includes(status.status)) break
          await sleep(FILL_POLL_INTERVAL_MS)
        }

        if (!filled) {
          await supabase.from('trade_executions').update({
            execution_status: 'needs_manual_review', needs_manual_review: true,
            review_reason: 'entry order did not confirm filled within poll window'
          }).eq('id', executionId)
          continue
        }

        await supabase.from('trade_executions').update({ execution_status: 'entry_filled', remaining_qty: plan.qty }).eq('id', executionId)
        entered++

        // Protective orders: a resting native stop for the FULL qty (primary
        // protection independent of the monitor cron running at all), plus the
        // scale-out tier limits. Tiers that round to 0 shares are skipped -
        // see allocateScaleOutQty.
        const alloc = allocateScaleOutQty(plan.qty)
        const result = await placeProtectiveOrders(
          {
            symbol: leg.symbol,
            exitSide,
            qty: plan.qty,
            stopPrice: plan.stopLossPrice,
            tierQty: alloc,
            tierPrices: plan.tierPrices,
            ids
          },
          { stopOrderId: null, tier1OrderId: null, tier2OrderId: null, tier3OrderId: null }
        )

        await supabase.from('trade_executions').update({
          execution_status: result.failure ? 'protective_orders_partial' : 'protective_orders_placed',
          needs_manual_review: !!result.failure,
          review_reason: result.failure,
          stop_order_id: result.stopOrderId,
          stop_client_order_id: ids.stop,
          tier1_order_id: result.tier1OrderId,
          tier2_order_id: result.tier2OrderId,
          tier3_order_id: result.tier3OrderId
        }).eq('id', executionId)
      } catch (legError) {
        console.error(`Error executing leg ${leg.id} (${leg.symbol}):`, legError)
        await supabase.from('trade_executions').update({
          execution_status: 'needs_manual_review', needs_manual_review: true, review_reason: String(legError)
        }).eq('id', executionId)
      }
    }

    res.status(200).json({ success: true, processed, entered })
  } catch (error) {
    console.error('Error in execute-alerts:', error)
    res.status(500).json({ error: String(error) })
  }
}
