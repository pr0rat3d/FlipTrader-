import { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../server/supabaseAdmin.js'
import { verifyCronSecret } from '../../server/verifyCronSecret.js'
import { sendToTopic } from '../../server/firebase-notify.js'
import { ALERTS_TOPIC } from '../register-token.js'
import { getOrder, placeOrder, cancelOrder, getOptionQuote } from '../../server/execution/alpacaClient.js'
import { optionClientOrderIds } from '../../server/execution/clientOrderIds.js'
import {
  RUNNER_TIME_LOCK_HOUR_ET, RUNNER_TIME_LOCK_MINUTE_ET, RUNNER_TIME_LOCK_MIN_PCT,
  FORCE_CLOSE_HOUR_ET, FORCE_CLOSE_MINUTE_ET
} from '../../server/execution/optionPositionSizing.js'
import { nyMinutesSinceMidnight } from '../../server/rvol.js'

export const config = {
  maxDuration: 60
}

// cron-job.org's free tier has no sub-minute scheduling option, so this still
// gets triggered once a minute externally - but loops internally for an
// effective ~18s checking cadence within one invocation, same pattern
// track-profit-targets.ts already uses. Previously had NO internal loop at
// all (a single check per ~60s external trigger) - found live 2026-07-15
// that this mattered: a stop/breakeven trigger could sit up to a minute
// behind a fast-moving 0DTE option before the next external trigger even
// noticed (QQQ 715C's breakeven stop fired at "5.1% adverse," not the
// intended ~0%, because price had already drifted that far in the gap
// between checks). 3 checks x 18s gaps = ~36s elapsed, comfortably under the
// 60s maxDuration below.
const CHECK_INTERVAL_MS = 18_000
const CHECKS_PER_INVOCATION = 3

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// Intentionally does NOT check execution_settings.is_enabled - the kill switch
// only prevents new entries (see execute-alerts.ts). Pausing new entries must
// never mean "stop protecting positions already open."

// Protects entry+5%, not exact breakeven, once a tier fills - found live
// 2026-07-15: QQQ 715C's stop_pct=0 (exact breakeven) trigger didn't fire
// until price had ALREADY drifted 5.1% past it between polls ("5.1% adverse
// on live quote (threshold 0%)"), landing the fill below entry instead of
// at it. A negative stop_pct here means "sell once price falls to entry *
// (1 + |stop_pct|)" - same adverseMove >= stopPct comparison the hard stop
// below already uses, just with a threshold that's ahead of breakeven
// instead of at it, to absorb that same ~5% of poll-interval drift without
// giving back into a loss.
const BREAKEVEN_PROTECTION_STOP_PCT = -0.05

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
  stop_order_id: string | null
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

const runOnce = async (): Promise<{ managed: number; closed: number }> => {
  const { data: positions, error: positionsError } = await supabase
    .from('option_positions')
    .select('*, option_position_tiers(*)')
    .in('status', ['claimed', 'entry_submitted', 'open'])

  if (positionsError) throw positionsError
  if (!positions || positions.length === 0) {
    return { managed: 0, closed: 0 }
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
        // Cancel the resting protective stop first - once the market-sell
        // below flattens the position, an orphaned resting sell order for
        // contracts that no longer exist would just sit there until it
        // eventually errors out on its own. Best-effort: a failed cancel
        // here doesn't block the force-close itself, since flattening the
        // position takes priority - Alpaca will reject the stale stop's own
        // fill attempt once there's nothing left to sell against it anyway.
        if (position.stop_order_id) await cancelOrder(position.stop_order_id)

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

      // --- Hard stop / breakeven protection: primarily a resting broker-
      // side stop order now (placed at entry in execute-alerts.ts, cancelled
      // and re-placed here on every tier fill) - Alpaca's own matching
      // engine reacts in real time, independent of this poll's cadence.
      // Replaces the OLD design (originally a closed-1-min-candle check,
      // then a live-quote-polled check after the candle check turned out to
      // never execute at all - Alpaca's options bars endpoint 403s without a
      // separately-signed OPRA agreement, found live 2026-07-15 after three
      // real positions ran 40-80% past the stop with zero protection). The
      // quote-polled version worked but still had a real gap: QQQ 715C's
      // breakeven stop fired at "5.1% adverse," not ~0%, because price had
      // already drifted that far in the ~1-minute gap between polls. A
      // resting order removes that gap entirely for the stop specifically.
      //
      // Falls back to the old quote-polled check only if a position somehow
      // has no resting stop_order_id (e.g. still open from before this
      // shipped, or the stop failed to place) - belt-and-suspenders, not the
      // primary mechanism anymore.
      if (position.stop_order_id) {
        const stopOrder = await getOrder(position.stop_order_id)

        if (stopOrder?.status === 'filled') {
          const fillPrice = stopOrder.filled_avg_price ? parseFloat(stopOrder.filled_avg_price) : quote.bid
          const adverseMove = (position.premium_entry - fillPrice) / position.premium_entry
          const stopPct = position.stop_pct ?? 0.25
          await supabase.from('option_positions').update({
            status: stopPct > 0 ? 'closed_hard_stop' : 'closed_stop',
            remaining_contracts: 0, closed_at: now.toISOString(),
            review_reason: `stop order filled: ${(adverseMove * 100).toFixed(1)}% adverse, broker fill $${fillPrice.toFixed(2)} (threshold ${(stopPct * 100).toFixed(0)}%)`
          }).eq('id', position.id)
          await notifyManualReview(position.underlying_symbol, `Stop triggered (broker-side) - ${(adverseMove * 100).toFixed(1)}% adverse`)
          closed++
          continue
        }

        if (stopOrder && ['canceled', 'expired', 'rejected'].includes(stopOrder.status)) {
          // Resting stop is gone but the position is still open - flag
          // loudly, but don't `continue`: still worth managing tier/runner
          // logic below even while unprotected, rather than freezing
          // everything until a human notices.
          await supabase.from('option_positions').update({
            needs_manual_review: true, review_reason: `protective stop order ${stopOrder.status} unexpectedly - position unprotected`
          }).eq('id', position.id)
          await notifyManualReview(position.underlying_symbol, `CRITICAL: protective stop is ${stopOrder.status} - position unprotected`)
        }
      } else {
        const adverseMove = (position.premium_entry - quote.bid) / position.premium_entry
        const stopPct = position.stop_pct ?? 0.25

        if (adverseMove >= stopPct) {
          const result = await sellAtMarket(position.option_symbol, position.remaining_contracts, ids.hardStop)
          if (result.orderId) {
            await supabase.from('option_positions').update({
              status: stopPct > 0 ? 'closed_hard_stop' : 'closed_stop',
              remaining_contracts: 0, closed_at: now.toISOString(),
              review_reason: `stop triggered (fallback, no resting order): ${(adverseMove * 100).toFixed(1)}% adverse on live quote (threshold ${(stopPct * 100).toFixed(0)}%)`
            }).eq('id', position.id)
            await notifyManualReview(position.underlying_symbol, `Stop triggered (fallback) - flattened at market (${(adverseMove * 100).toFixed(1)}% adverse)`)
            closed++
          } else {
            await supabase.from('option_positions').update({
              needs_manual_review: true, review_reason: `fallback stop flatten failed: ${result.failure}`
            }).eq('id', position.id)
            await notifyManualReview(position.underlying_symbol, `CRITICAL: fallback stop triggered but flatten failed - ${result.failure}`)
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
      // How many fixed tiers have already filled, including this run -
      // used only to keep the ratchet's replacement stop order's
      // client_order_id unique/traceable (see clientOrderIds.ts).
      let stopReplaceAttempt = tiers.filter(t => !t.is_runner && t.filled_at).length

      for (const tier of unfilledFixed) {
        // Tiers are ascending by target_pct - stop at the first threshold
        // not yet met rather than checking the rest.
        if (currentPct < tier.target_pct) break
        // Only reserve the last contract when this plan actually has a
        // runner tier to reserve it for (see optionPositionSizing.ts - the
        // 2-contract plan has none, and is meant to fully exit by its last
        // fixed tier).
        if (runner && remaining <= 1) break

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
        stopReplaceAttempt++
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
            // Position is now fully closing - the resting protective stop
            // has nothing left to protect. Best-effort: don't block the
            // close itself on this succeeding.
            if (position.stop_order_id) await cancelOrder(position.stop_order_id)

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
        // Ratchet the resting protective stop: cancel the old one (sized/
        // priced for the pre-tier-fill position) and place a fresh one at
        // the new remaining quantity and the breakeven+5% price. Cancel-
        // then-recreate, not Alpaca's PATCH replace endpoint - verified
        // empirically 2026-07-16 that replace 422s on an options order still
        // in "accepted" status ("cannot replace order in accepted status"),
        // while cancel+new placeOrder works cleanly regardless of status.
        const newStopPrice = position.premium_entry * (1 - BREAKEVEN_PROTECTION_STOP_PCT)
        let newStopOrderId: string | null = null

        if (position.stop_order_id) await cancelOrder(position.stop_order_id)
        try {
          const newStopOrder = await placeOrder({
            symbol: position.option_symbol, qty: remaining, side: 'sell', type: 'stop',
            stopPrice: newStopPrice, timeInForce: 'day', clientOrderId: ids.stopReplace(stopReplaceAttempt)
          })
          newStopOrderId = newStopOrder.id
        } catch (e) {
          await supabase.from('option_positions').update({
            needs_manual_review: true, review_reason: `stop replace after tier fill failed - position unprotected: ${String(e)}`
          }).eq('id', position.id)
          await notifyManualReview(position.underlying_symbol, `CRITICAL: stop replace failed after tier fill - position now unprotected - ${String(e)}`)
        }

        await supabase.from('option_positions').update({
          remaining_contracts: remaining, stop_pct: BREAKEVEN_PROTECTION_STOP_PCT, stop_order_id: newStopOrderId
        }).eq('id', position.id)
      }
    } catch (positionError) {
      console.error(`Error managing option position ${position.id} (${position.underlying_symbol}):`, positionError)
      await supabase.from('option_positions').update({
        needs_manual_review: true, review_reason: String(positionError)
      }).eq('id', position.id)
    }
  }

  return { managed, closed }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!verifyCronSecret(req, res)) return

  try {
    let totalManaged = 0
    let totalClosed = 0

    for (let i = 0; i < CHECKS_PER_INVOCATION; i++) {
      const { managed, closed } = await runOnce()
      totalManaged += managed
      totalClosed += closed
      if (i < CHECKS_PER_INVOCATION - 1) await sleep(CHECK_INTERVAL_MS)
    }

    res.status(200).json({ success: true, managed: totalManaged, closed: totalClosed, checksRun: CHECKS_PER_INVOCATION })
  } catch (error) {
    console.error('Error in monitor-executions:', error)
    res.status(500).json({ error: String(error) })
  }
}
