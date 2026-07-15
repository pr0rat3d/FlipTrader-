import { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../server/supabaseAdmin.js'
import { verifyCronSecret } from '../../server/verifyCronSecret.js'
import { sendToTopic } from '../../server/firebase-notify.js'
import { ALERTS_TOPIC } from '../register-token.js'
import { getOrder, placeOrder, getOptionQuote } from '../../server/execution/alpacaClient.js'
import { optionClientOrderIds } from '../../server/execution/clientOrderIds.js'
import {
  RUNNER_TIME_LOCK_HOUR_ET, RUNNER_TIME_LOCK_MINUTE_ET, RUNNER_TIME_LOCK_MIN_PCT,
  FORCE_CLOSE_HOUR_ET, FORCE_CLOSE_MINUTE_ET
} from '../../server/execution/optionPositionSizing.js'
import { nyMinutesSinceMidnight } from '../../server/rvol.js'

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

interface Tier {
  id: string
  tier_number: number
  is_runner: boolean
  target_pct: number
  filled_at: string | null
}

interface Position {
  id: string
  profit_target_id: string
  underlying_symbol: string
  option_symbol: string | null
  status: string
  contracts: number | null
  remaining_contracts: number | null
  premium_entry: number | null
  stop_pct: number | null
  entry_order_id: string | null
  claimed_at: string
  reconciliation_attempts: number
  option_position_tiers: Tier[]
}

const notifyManualReview = async (symbol: string, reason: string) => {
  await sendToTopic(ALERTS_TOPIC, `Options bot: manual review (${symbol})`, reason)
}

const sellAtMarket = async (optionSymbol: string, qty: number, clientOrderId: string): Promise<{ orderId: string | null; failure: string | null }> => {
  try {
    const order = await placeOrder({ symbol: optionSymbol, qty, side: 'sell', type: 'market', timeInForce: 'day', clientOrderId })
    return { orderId: order.id, failure: null }
  } catch (e) {
    return { orderId: null, failure: String(e) }
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!verifyCronSecret(req, res)) return

  try {
    const { data: positions, error: positionsError } = await supabase
      .from('option_positions')
      .select('*, option_position_tiers(*)')
      .in('status', ['claimed', 'entry_submitted', 'open'])

    if (positionsError) throw positionsError
    if (!positions || positions.length === 0) {
      return res.status(200).json({ success: true, managed: 0, closed: 0 })
    }

    const now = new Date()
    const minutesNow = nyMinutesSinceMidnight(now)
    const pastForceClose = minutesNow >= FORCE_CLOSE_HOUR_ET * 60 + FORCE_CLOSE_MINUTE_ET
    const pastTimeLock = minutesNow >= RUNNER_TIME_LOCK_HOUR_ET * 60 + RUNNER_TIME_LOCK_MINUTE_ET

    let managed = 0
    let closed = 0

    for (const position of (positions || []) as Position[]) {
      const ids = optionClientOrderIds(position.profit_target_id)

      try {
        // --- Stuck claim/entry-submit reconciliation ---
        if (position.status === 'claimed' || position.status === 'entry_submitted') {
          const stuckMs = Date.now() - new Date(position.claimed_at).getTime()
          if (stuckMs < RECONCILE_GRACE_MS) continue

          if (position.status === 'entry_submitted' && position.entry_order_id) {
            const entryOrder = await getOrder(position.entry_order_id)
            if (entryOrder?.status === 'filled') {
              await supabase.from('option_positions').update({
                status: 'open',
                premium_entry: entryOrder.filled_avg_price ? parseFloat(entryOrder.filled_avg_price) : null,
                remaining_contracts: Math.round(parseFloat(entryOrder.filled_qty))
              }).eq('id', position.id)
              continue
            }
            if (entryOrder && ['canceled', 'expired', 'rejected'].includes(entryOrder.status)) {
              await supabase.from('option_positions').update({ status: 'entry_failed' }).eq('id', position.id)
              continue
            }
          }

          const attempts = position.reconciliation_attempts + 1
          if (attempts >= MAX_RECONCILE_ATTEMPTS) {
            await supabase.from('option_positions').update({
              needs_manual_review: true, review_reason: 'entry stuck past reconciliation retry cap', reconciliation_attempts: attempts
            }).eq('id', position.id)
            await notifyManualReview(position.underlying_symbol, 'Entry order stuck, needs manual review')
          } else {
            await supabase.from('option_positions').update({ reconciliation_attempts: attempts }).eq('id', position.id)
          }
          continue
        }

        if (!position.option_symbol || !position.remaining_contracts || position.remaining_contracts <= 0 || position.premium_entry === null) continue
        managed++

        // --- Force-close: unconditional past 3:45pm ET, regardless of any
        // other condition - 0DTE contracts should never ride into expiration
        // mechanics unmonitored. ---
        if (pastForceClose) {
          const result = await sellAtMarket(position.option_symbol, position.remaining_contracts, ids.forceClose)
          if (result.orderId) {
            await supabase.from('option_positions').update({
              status: 'closed_force_close', remaining_contracts: 0, closed_at: now.toISOString()
            }).eq('id', position.id)
            closed++
          } else {
            await supabase.from('option_positions').update({
              needs_manual_review: true, review_reason: `force-close flatten failed: ${result.failure}`
            }).eq('id', position.id)
            await notifyManualReview(position.underlying_symbol, `CRITICAL: 3:45pm force-close failed to flatten - ${result.failure}`)
          }
          continue
        }

        const quote = await getOptionQuote(position.option_symbol)
        if (!quote) continue

        // --- Hard stop: on the option's current bid, checked every poll.
        // Originally designed as a CLOSED 1-min candle check (mirroring the
        // shares model's catastrophic backstop, "not a wick"), but Alpaca's
        // options bars endpoint requires a separate signed OPRA agreement -
        // found live 2026-07-15 that it 403s on this account
        // ("OPRA agreement is not signed"), meaning getOptionBars1Min always
        // returned null and this check had NEVER ONCE EXECUTED since the bot
        // went live. Three real positions ran 40-80% past this exact
        // threshold with zero protection before that was caught. A quote-
        // based check trades away the "closed candle, not a wick" smoothing
        // for a check that actually runs - options quotes were already
        // proven reliable (they're what tier fills/runner logic use every
        // poll) where bars were not. stop_pct starts at
        // execution_settings.hard_stop_pct (30%) and ratchets to 0
        // (breakeven) the moment the first tier sells.
        {
          const adverseMove = (position.premium_entry - quote.bid) / position.premium_entry
          const stopPct = position.stop_pct ?? 0.30

          if (adverseMove >= stopPct) {
            const result = await sellAtMarket(position.option_symbol, position.remaining_contracts, ids.hardStop)
            if (result.orderId) {
              await supabase.from('option_positions').update({
                status: stopPct > 0 ? 'closed_hard_stop' : 'closed_stop',
                remaining_contracts: 0, closed_at: now.toISOString(),
                review_reason: `stop triggered: ${(adverseMove * 100).toFixed(1)}% adverse on live quote (threshold ${(stopPct * 100).toFixed(0)}%)`
              }).eq('id', position.id)
              await notifyManualReview(position.underlying_symbol, `Stop triggered - flattened at market (${(adverseMove * 100).toFixed(1)}% adverse)`)
              closed++
            } else {
              await supabase.from('option_positions').update({
                needs_manual_review: true, review_reason: `stop flatten failed: ${result.failure}`
              }).eq('id', position.id)
              await notifyManualReview(position.underlying_symbol, `CRITICAL: stop triggered but flatten failed - ${result.failure}`)
            }
            continue
          }
        }

        // --- Tier fills: fixed tiers in ascending order, then the runner ---
        const tiers = (position.option_position_tiers || []).sort((a, b) => a.tier_number - b.tier_number)
        const unfilledFixed = tiers.filter(t => !t.is_runner && !t.filled_at)
        const runner = tiers.find(t => t.is_runner)

        const currentPct = (quote.bid - position.premium_entry) / position.premium_entry
        let remaining = position.remaining_contracts
        let anyTierFilledThisRun = false

        for (const tier of unfilledFixed) {
          // Tiers are ascending by target_pct - stop at the first threshold
          // not yet met rather than checking the rest.
          if (currentPct < tier.target_pct) break
          if (remaining <= 1) break // always leave the runner's 1 contract

          const result = await sellAtMarket(position.option_symbol, 1, ids.tier(tier.tier_number))
          if (!result.orderId) {
            await supabase.from('option_positions').update({
              needs_manual_review: true, review_reason: `tier ${tier.tier_number} sell failed: ${result.failure}`
            }).eq('id', position.id)
            await notifyManualReview(position.underlying_symbol, `Tier ${tier.tier_number} sell failed - ${result.failure}`)
            break
          }
          await supabase.from('option_position_tiers').update({
            filled_at: now.toISOString(), fill_price: quote.bid, order_id: result.orderId
          }).eq('id', tier.id)
          remaining -= 1
          anyTierFilledThisRun = true
        }

        // --- Runner: hard +100% target, or a post-3pm lock-in at +50% if it
        // hasn't reached target yet. Otherwise left alone to settle wherever
        // it lands until either fires or the 3:45 force-close takes it. ---
        let runnerClosed = false
        if (runner && !runner.filled_at && remaining >= 1) {
          const hitTarget = currentPct >= runner.target_pct
          const timeLockEligible = pastTimeLock && currentPct >= RUNNER_TIME_LOCK_MIN_PCT

          if (hitTarget || timeLockEligible) {
            const result = await sellAtMarket(position.option_symbol, remaining, ids.tier(runner.tier_number))
            if (result.orderId) {
              await supabase.from('option_position_tiers').update({
                filled_at: now.toISOString(), fill_price: quote.bid, order_id: result.orderId
              }).eq('id', runner.id)
              await supabase.from('option_positions').update({
                status: hitTarget ? 'closed_target' : 'closed_time_lock',
                remaining_contracts: 0, closed_at: now.toISOString()
              }).eq('id', position.id)
              runnerClosed = true
              closed++
            } else {
              await supabase.from('option_positions').update({
                needs_manual_review: true, review_reason: `runner sell failed: ${result.failure}`
              }).eq('id', position.id)
              await notifyManualReview(position.underlying_symbol, `Runner sell failed - ${result.failure}`)
            }
          }
        }

        if (!runnerClosed && anyTierFilledThisRun) {
          await supabase.from('option_positions').update({ remaining_contracts: remaining, stop_pct: 0 }).eq('id', position.id)
        }
      } catch (positionError) {
        console.error(`Error managing option position ${position.id} (${position.underlying_symbol}):`, positionError)
        await supabase.from('option_positions').update({
          needs_manual_review: true, review_reason: String(positionError)
        }).eq('id', position.id)
      }
    }

    res.status(200).json({ success: true, managed, closed })
  } catch (error) {
    console.error('Error in monitor-executions:', error)
    res.status(500).json({ error: String(error) })
  }
}
