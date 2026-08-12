import { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../server/supabaseAdmin.js'
import { verifyCronSecret } from '../../server/verifyCronSecret.js'
import { sendToTopic } from '../../server/firebase-notify.js'
import { ALERTS_TOPIC } from '../register-token.js'
import { getOrder, getOpenOrders, placeOrder, cancelOrder, getOptionQuote, describeAlpacaError } from '../../server/execution/alpacaClient.js'
import { optionClientOrderIds } from '../../server/execution/clientOrderIds.js'
import {
  RUNNER_TIME_LOCK_HOUR_ET, RUNNER_TIME_LOCK_MINUTE_ET, RUNNER_TIME_LOCK_MIN_PCT,
  FORCE_CLOSE_HOUR_ET, FORCE_CLOSE_MINUTE_ET, BREAKEVEN_PROTECTION_STOP_PCT
} from '../../server/execution/optionPositionSizing.js'
import { nyMinutesSinceMidnight } from '../../server/rvol.js'

export const config = {
  maxDuration: 60
}

// cron-job.org's free tier has no sub-minute scheduling option, so this still
// gets triggered once a minute externally - but loops internally for a
// faster checking cadence within one invocation, same pattern
// track-profit-targets.ts already uses. Originally had NO internal loop at
// all (a single check per ~60s external trigger) - found live 2026-07-15
// that this mattered for the (then bot-polled) hard stop: a trigger could
// sit up to a minute behind a fast-moving 0DTE option before the next
// external trigger even noticed. Added a 3-checks/18s-gaps loop the same
// day, but found live 2026-07-16 that the resulting ~36s response time was
// long enough to blow past cron-job.org's own client-side request timeout
// (well under 30s on their free tier) - showing up as "failed/timeout" in
// their job history even though the Vercel function completed successfully
// every time. The real risk wasn't lost work, it was cron-job.org retrying
// a "failed" job while the first invocation was still finishing - two
// overlapping runs racing each other (e.g. a duplicate tier sell, or a
// cancel/replace race on the resting stop order).
//
// Tightened significantly, and it's safe to: the hard stop's own real-time
// protection now runs on Alpaca's resting stop order (2026-07-16), not this
// poll's cadence at all - a slower poll here only affects how quickly tier
// fills/runner targets/stop-order-fill bookkeeping get noticed, not whether
// a fast adverse move gets caught.
const CHECK_INTERVAL_MS = 6_000
const CHECKS_PER_INVOCATION = 2

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

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
  order_id: string | null
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
    return { orderId: null, failure: describeAlpacaError(e) }
  }
}

// Best-effort cleanup of any still-resting tier limit orders once a position
// is closing through some OTHER path (stop fill, force-close) - those orders
// were sized against contracts that are about to be (or already are) gone.
// Never blocks the close itself: Alpaca would reject/expire a stale resting
// sell on its own once there's nothing left to sell against it anyway, this
// just avoids leaving orphaned orders sitting around unnecessarily.
const cancelUnfilledTierOrders = async (tiers: Tier[]) => {
  for (const tier of tiers) {
    if (tier.order_id && !tier.filled_at) {
      try { await cancelOrder(tier.order_id) } catch { /* best-effort */ }
    }
  }
}

// Old bot-computed quote-threshold + market-sell path for a single tier -
// used only when that tier's own resting order failed to place at entry, or
// landed in a terminal bad state (canceled/expired/rejected) unexpectedly.
// Not the primary mechanism anymore (see the tier-fill loop in runOnce).
//
// 2026-07-29 fix: confirmed empirically that this is now effectively the
// ONLY mechanism that can ever fire, for every position. A resting
// broker-side stop for the position's full remaining quantity (placed at
// entry) permanently reserves that entire quantity - any additional sell
// order (a tier's own resting limit at entry, OR this fallback's market
// sell) gets rejected with "account not eligible to trade uncovered option
// contracts", confirmed by hitting the live API directly against a real
// stuck position. Also confirmed live that Alpaca's option orders don't
// support order_class 'oco'/bracket ("complex orders not supported for
// options trading"), which would have solved this more cleanly - not
// available on this account. So: cancel the resting stop first to free the
// quantity, THEN attempt the sell. If the sell still fails for some other
// reason, restore the SAME stop (same qty/price) immediately rather than
// leave the position naked - the caller persists the restored order id.
const attemptFallbackTierSell = async (
  optionSymbol: string, tier: Tier, bid: number, remaining: number, currentPct: number, pastTimeLock: boolean,
  symbolForNotify: string, tierClientOrderId: string,
  stopOrderId: string | null, stopPrice: number, restoreClientOrderId: string
): Promise<{ filled: boolean; fillPrice: number; orderId: string | null; closeStatus: string | null; stopOrderIdAfterAttempt: string | null }> => {
  const hitTarget = currentPct >= tier.target_pct
  const timeLockEligible = tier.is_runner && pastTimeLock && currentPct >= RUNNER_TIME_LOCK_MIN_PCT
  const conditionMet = tier.is_runner ? (hitTarget || timeLockEligible) : hitTarget
  if (!conditionMet) return { filled: false, fillPrice: 0, orderId: null, closeStatus: null, stopOrderIdAfterAttempt: stopOrderId }

  if (stopOrderId) await cancelOrder(stopOrderId)

  const qtyToSell = tier.is_runner ? remaining : 1
  const result = await sellAtMarket(optionSymbol, qtyToSell, tierClientOrderId)

  if (!result.orderId) {
    let restoredStopId: string | null = null
    if (stopOrderId) {
      try {
        const restored = await placeOrder({
          symbol: optionSymbol, qty: remaining, side: 'sell', type: 'stop',
          stopPrice, timeInForce: 'day', clientOrderId: restoreClientOrderId
        })
        restoredStopId = restored.id
      } catch (e) {
        await notifyManualReview(symbolForNotify, `CRITICAL: stop cancelled to attempt a tier sell, the sell then failed, AND restoring the stop ALSO failed - position is naked: ${describeAlpacaError(e)}`)
      }
    }
    await notifyManualReview(symbolForNotify, `Tier ${tier.tier_number}${tier.is_runner ? ' (runner)' : ''} fallback sell failed - ${result.failure}${restoredStopId ? ' (stop restored)' : ''}`)
    return { filled: false, fillPrice: 0, orderId: null, closeStatus: null, stopOrderIdAfterAttempt: restoredStopId }
  }

  return {
    filled: true, fillPrice: bid, orderId: result.orderId,
    closeStatus: tier.is_runner ? (hitTarget ? 'closed_target' : 'closed_time_lock') : null,
    // Intentionally not restored - the caller's existing tier-fill branch
    // places the correctly-ratcheted (breakeven, reduced qty) replacement.
    stopOrderIdAfterAttempt: null
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
        await cancelUnfilledTierOrders(position.option_position_tiers || [])

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
          await cancelUnfilledTierOrders(position.option_position_tiers || [])
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
          // Found live 2026-08-06: this read of position.stop_order_id can be
          // STALE relative to Alpaca's actual state - a concurrent overlapping
          // invocation (the exact race this file's header comment already
          // warns about) can be mid-way through the tier-fill ratchet below
          // (cancel old stop -> place new one -> write new stop_order_id),
          // and if THIS invocation's query landed between the cancel and the
          // DB write, it sees a genuinely-canceled order against a row that
          // just hasn't caught up yet - a false "unprotected" alarm on a
          // position a concurrent invocation is actively re-protecting.
          // Confirmed: the flagged Aug 6 position had stop_pct already
          // ratchet to breakeven+5%, proving the replace really did succeed,
          // and it closed at target with no gap in real protection - only
          // the alert itself was wrong. Same idempotent recheck the 07-31 fix
          // added to the placement step itself: before concluding the
          // position is really unprotected, ask Alpaca directly whether a
          // replacement stop already exists.
          const openOrders = await getOpenOrders(position.option_symbol)
          const replacementStop = openOrders?.find(o => o.type === 'stop' && o.side === 'sell') ?? null

          if (replacementStop) {
            if (replacementStop.id !== position.stop_order_id) {
              position.stop_order_id = replacementStop.id
              await supabase.from('option_positions').update({ stop_order_id: replacementStop.id }).eq('id', position.id)
            }
          } else {
            // Genuinely no resting stop - found live 2026-08-11: a real
            // position sat unprotected for the rest of the session after
            // the tier-fill ratchet's own placement attempt (further below,
            // "anyTierFilledThisRun") failed for some reason (exact cause
            // not recoverable - Vercel's log retention had already rotated
            // it out by the time this was investigated). The ratchet only
            // ever runs ONCE, in the same poll a tier fill is detected -
            // once that attempt fails, nothing ever retries it, since the
            // tier already has filled_at set and won't trigger the ratchet
            // branch again. This check now doubles as that missing retry:
            // instead of only alerting and hoping a human sees it in time,
            // attempt to place a fresh protective stop right here, every
            // poll, for as long as one is missing.
            const healAdverseMove = (position.premium_entry - quote.bid) / position.premium_entry
            const healStopPct = position.stop_pct ?? 0.25
            const healStopPrice = position.premium_entry * (1 - healStopPct)

            if (healAdverseMove >= healStopPct) {
              // Found live 2026-08-11 (same incident): by the time this ran,
              // price had ALREADY fallen through the intended stop level
              // (the gap between the ratchet's original failed attempt and
              // this retry was enough for the underlying to move that far).
              // A passive stop order priced above the current market is
              // invalid - Alpaca rejects it outright ("stop price must be
              // less than current price") - so this kept retrying and
              // failing every single poll instead of ever protecting
              // anything. Mirrors the sibling "no stop_order_id at all"
              // fallback path below: once the level's already breached,
              // there's nothing a passive order can do - flatten at market
              // immediately instead.
              const result = await sellAtMarket(position.option_symbol, position.remaining_contracts, ids.stopHealMarketSell())
              if (result.orderId) {
                await cancelUnfilledTierOrders(position.option_position_tiers || [])
                await supabase.from('option_positions').update({
                  status: healStopPct > 0 ? 'closed_hard_stop' : 'closed_stop',
                  remaining_contracts: 0, closed_at: now.toISOString(),
                  review_reason: `protective stop order ${stopOrder.status} unexpectedly, and price had already breached the stop level by the time this was caught (${(healAdverseMove * 100).toFixed(1)}% adverse, threshold ${(healStopPct * 100).toFixed(0)}%) - flattened at market instead of attempting an invalid stop`
                }).eq('id', position.id)
                await notifyManualReview(position.underlying_symbol, `Protective stop was ${stopOrder.status} unexpectedly and price already breached the stop level - flattened at market (${(healAdverseMove * 100).toFixed(1)}% adverse)`)
                closed++
                continue
              } else {
                await supabase.from('option_positions').update({
                  needs_manual_review: true,
                  review_reason: `protective stop order ${stopOrder.status} unexpectedly, price already breached the stop level, AND the market flatten also failed - position unprotected: ${result.failure}`
                }).eq('id', position.id)
                await notifyManualReview(position.underlying_symbol, `CRITICAL: protective stop is ${stopOrder.status}, price already breached the stop level, AND market flatten failed - ${result.failure}`)
              }
            } else {
              try {
                const healedStop = await placeOrder({
                  symbol: position.option_symbol, qty: position.remaining_contracts, side: 'sell', type: 'stop',
                  stopPrice: healStopPrice, timeInForce: 'day', clientOrderId: ids.stopHeal()
                })
                position.stop_order_id = healedStop.id
                await supabase.from('option_positions').update({
                  stop_order_id: healedStop.id, needs_manual_review: true,
                  review_reason: `protective stop order ${stopOrder.status} unexpectedly - auto-healed with a fresh stop at $${healStopPrice.toFixed(2)}, please verify`
                }).eq('id', position.id)
                await notifyManualReview(position.underlying_symbol, `Protective stop was ${stopOrder.status} unexpectedly - auto-healed with a new stop at $${healStopPrice.toFixed(2)}, please verify`)
              } catch (e) {
                await supabase.from('option_positions').update({
                  needs_manual_review: true,
                  review_reason: `protective stop order ${stopOrder.status} unexpectedly, AND the auto-heal placement also failed - position unprotected: ${describeAlpacaError(e)}`
                }).eq('id', position.id)
                await notifyManualReview(position.underlying_symbol, `CRITICAL: protective stop is ${stopOrder.status} AND auto-heal failed - position unprotected - ${describeAlpacaError(e)}`)
              }
            }
          }
        }
      } else {
        const adverseMove = (position.premium_entry - quote.bid) / position.premium_entry
        const stopPct = position.stop_pct ?? 0.25

        if (adverseMove >= stopPct) {
          const result = await sellAtMarket(position.option_symbol, position.remaining_contracts, ids.hardStop)
          if (result.orderId) {
            await cancelUnfilledTierOrders(position.option_position_tiers || [])
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

        // 2026-08-12: a position with no stop_order_id at all (e.g. the
        // initial placement at entry failed - execute-alerts.ts already
        // flags this loudly when it happens) used to rely PERMANENTLY on
        // the once-a-minute threshold check above instead of ever getting
        // a real resting stop - unlike the "had one, then lost it" case
        // above (which now self-heals), this path never attempted to
        // place one. The level hasn't been breached yet here (checked
        // above), so it's still safe to place a passive stop - best-effort,
        // silent on failure since the bot-polled check above still
        // protects this position every poll regardless of whether this
        // succeeds; not a new CRITICAL condition on its own.
        const healStopPrice = position.premium_entry * (1 - stopPct)
        try {
          const healedStop = await placeOrder({
            symbol: position.option_symbol, qty: position.remaining_contracts, side: 'sell', type: 'stop',
            stopPrice: healStopPrice, timeInForce: 'day', clientOrderId: ids.stopHeal()
          })
          await supabase.from('option_positions').update({ stop_order_id: healedStop.id }).eq('id', position.id)
          console.log(`Placed missing resting stop for ${position.underlying_symbol} (${position.id}) at $${healStopPrice.toFixed(2)} - previously relying on bot-polled fallback only`)
        } catch {
          // Best-effort, will retry next poll - bot-polled threshold check
          // above already covers this position in the meantime.
        }
      }

      // --- Tier fills: each tier (fixed AND runner) got its own resting
      // broker-side limit sell order placed at entry (execute-alerts.ts,
      // 2026-07-16) - mirrors the stop's design so a fast move fills the
      // real order instantly instead of waiting for this poll to notice a
      // bot-computed threshold. Found live 2026-07-16: SPY/QQQ calls ran up
      // well past their tier targets and then reversed all the way into the
      // hard stop between polls, with zero profit taken along the way.
      //
      // Checked independently per tier, not sequential/threshold-gated like
      // the old design - a large gap can in principle fill a higher tier
      // before a lower one's resting order, and each order covers a
      // disjoint 1-contract slice of the position, so there's no
      // overlap/oversell risk either way `remaining` unwinds.
      //
      // Falls back to the old bot-computed quote-threshold + market-sell
      // only for a tier whose resting order failed to place at entry, or
      // landed in a terminal bad state (canceled/expired/rejected)
      // unexpectedly - belt-and-suspenders, not the primary mechanism.
      const tiers = (position.option_position_tiers || []).sort((a, b) => a.tier_number - b.tier_number)
      const unfilledTiers = tiers.filter(t => !t.filled_at)
      const hasRunner = tiers.some(t => t.is_runner)
      const currentPct = (quote.bid - position.premium_entry) / position.premium_entry

      let remaining = position.remaining_contracts
      let anyTierFilledThisRun = false
      // How many fixed tiers have already filled, including this run - used
      // only to keep the ratchet's replacement stop order's client_order_id
      // unique/traceable (see clientOrderIds.ts).
      let stopReplaceAttempt = tiers.filter(t => !t.is_runner && t.filled_at).length
      let closeStatus: string | null = null
      // The fallback tier sell below cancels this to free up quantity Alpaca
      // would otherwise reject the sell as "uncovered" against - tracked
      // locally (and persisted immediately if it changes) so a later tier in
      // the SAME run, or a later run, always cancels/checks the real current
      // resting order, never a stale id.
      let currentStopOrderId = position.stop_order_id
      const currentStopPrice = position.premium_entry * (1 - (position.stop_pct ?? 0.25))

      for (const tier of unfilledTiers) {
        let filled = false
        let fillPrice = quote.bid

        if (tier.order_id) {
          const order = await getOrder(tier.order_id)

          if (order?.status === 'filled') {
            filled = true
            fillPrice = order.filled_avg_price ? parseFloat(order.filled_avg_price) : quote.bid
            await supabase.from('option_position_tiers').update({
              filled_at: now.toISOString(), fill_price: fillPrice
            }).eq('id', tier.id)
            if (tier.is_runner) closeStatus = 'closed_target'
          } else if (tier.is_runner && pastTimeLock && currentPct >= RUNNER_TIME_LOCK_MIN_PCT &&
            order && !['canceled', 'expired', 'rejected'].includes(order.status)) {
            // Runner hasn't hit its own +100% target yet, but the post-3pm
            // lock-in floor has been reached - cancel the resting target
            // order and take the smaller guaranteed win at market rather
            // than risk riding it back down into the 3:45 force-close.
            await cancelOrder(tier.order_id)
            const result = await sellAtMarket(position.option_symbol, remaining, ids.tier(tier.tier_number))
            if (result.orderId) {
              filled = true
              fillPrice = quote.bid
              closeStatus = 'closed_time_lock'
              await supabase.from('option_position_tiers').update({
                filled_at: now.toISOString(), fill_price: fillPrice, order_id: result.orderId
              }).eq('id', tier.id)
            } else {
              await notifyManualReview(position.underlying_symbol, `Runner time-lock sell failed - ${result.failure}`)
            }
          } else if (order && ['canceled', 'expired', 'rejected'].includes(order.status)) {
            await notifyManualReview(position.underlying_symbol, `Tier ${tier.tier_number} resting order ${order.status} unexpectedly - falling back to bot-polled close`)
            const fb = await attemptFallbackTierSell(
              position.option_symbol, tier, quote.bid, remaining, currentPct, pastTimeLock, position.underlying_symbol, ids.tier(tier.tier_number),
              currentStopOrderId, currentStopPrice, ids.stopRestore()
            )
            if (fb.filled) {
              filled = true
              fillPrice = fb.fillPrice
              closeStatus = fb.closeStatus ?? closeStatus
              await supabase.from('option_position_tiers').update({
                filled_at: now.toISOString(), fill_price: fb.fillPrice, order_id: fb.orderId
              }).eq('id', tier.id)
            } else if (fb.stopOrderIdAfterAttempt !== currentStopOrderId) {
              currentStopOrderId = fb.stopOrderIdAfterAttempt
              await supabase.from('option_positions').update({ stop_order_id: currentStopOrderId }).eq('id', position.id)
            }
          }
          // else: still resting (new/accepted/pending_new) below any
          // fallback trigger - nothing to do, let it ride.
        } else {
          // No resting order (placement failed at entry) - old bot-computed
          // path. Only reserve the runner's own contract here: the
          // resting-order path above doesn't need this, each order already
          // covers its own disjoint 1 contract.
          if (!tier.is_runner && hasRunner && remaining <= 1) continue
          const fb = await attemptFallbackTierSell(
            position.option_symbol, tier, quote.bid, remaining, currentPct, pastTimeLock, position.underlying_symbol, ids.tier(tier.tier_number),
            currentStopOrderId, currentStopPrice, ids.stopRestore()
          )
          if (fb.filled) {
            filled = true
            fillPrice = fb.fillPrice
            closeStatus = fb.closeStatus ?? closeStatus
            await supabase.from('option_position_tiers').update({
              filled_at: now.toISOString(), fill_price: fb.fillPrice, order_id: fb.orderId
            }).eq('id', tier.id)
          } else if (fb.stopOrderIdAfterAttempt !== currentStopOrderId) {
            currentStopOrderId = fb.stopOrderIdAfterAttempt
            await supabase.from('option_positions').update({ stop_order_id: currentStopOrderId }).eq('id', position.id)
          }
        }

        if (filled) {
          const qtyFilled = tier.is_runner ? remaining : 1
          remaining -= qtyFilled
          anyTierFilledThisRun = true
          if (!tier.is_runner) stopReplaceAttempt++
        }
      }

      if (remaining <= 0) {
        // Every tier (fixed + runner, or just fixed on a no-runner plan)
        // has now filled - nothing left for the resting protective stop to
        // guard. Fixes a latent gap in the old design: a no-runner 2-
        // contract plan's last fixed-tier fill never closed the position at
        // all (there was no runner branch to do it), leaving remaining_
        // contracts at 0 but status stuck 'open' indefinitely.
        // currentStopOrderId (not position.stop_order_id) - the fallback
        // sell above already cancelled the resting stop to free quantity for
        // the sell itself, so this is normally a harmless no-op on an
        // already-gone order, kept for the rare case nothing above touched it.
        if (currentStopOrderId) await cancelOrder(currentStopOrderId)
        await supabase.from('option_positions').update({
          status: closeStatus ?? 'closed_target', remaining_contracts: 0, closed_at: now.toISOString()
        }).eq('id', position.id)
        closed++
      } else if (anyTierFilledThisRun) {
        // Ratchet the resting protective stop: cancel the old one (sized/
        // priced for the pre-tier-fill position) and place a fresh one at
        // the new remaining quantity and the breakeven+5% price. Cancel-
        // then-recreate, not Alpaca's PATCH replace endpoint - verified
        // empirically 2026-07-16 that replace 422s on an options order still
        // in "accepted" status ("cannot replace order in accepted status"),
        // while cancel+new placeOrder works cleanly regardless of status.
        const newStopPrice = position.premium_entry * (1 - BREAKEVEN_PROTECTION_STOP_PCT)
        let newStopOrderId: string | null = null
        let ratchetFailure: string | null = null

        // 2026-08-11 fix: cancelOrder and the first findRestingStop() call
        // below used to sit outside any try/catch - if EITHER threw (found
        // live: a real position sat with a stale stop_order_id all session
        // after one of these failed, exact cause not recoverable since
        // Vercel's log retention had already rotated it out by the time this
        // was investigated), execution jumped straight to this function's
        // OUTER catch, which never reaches the final DB update below at all -
        // remaining_contracts stays wrong (still shows the pre-tier-fill
        // count) AND stop_order_id stays pointed at the now-genuinely-
        // canceled old order, with only a generic outer-catch message
        // instead of a clear trail. Wrapping the whole ratchet attempt
        // ensures the final update (correct remaining_contracts, stop_order_id
        // explicitly nulled rather than left stale) always runs, and the
        // stop-health check above now self-heals a missing stop on the very
        // next poll regardless of why this attempt failed.
        try {
          if (currentStopOrderId) await cancelOrder(currentStopOrderId)

          // 2026-07-31 fix: a concurrent overlapping invocation (cron-job.org
          // retrying a "timed out" request while the first is still running -
          // see this file's own header comment on that risk) can reach this
          // exact step at the same time, both computing the same
          // stopReplaceAttempt and racing to place a stop with the identical
          // client_order_id. Found live: the loser's placeOrder failed with
          // "client_order_id must be unique", and its failure handler then
          // blindly wrote stop_order_id: null over the winner's already-
          // correct value - a real, working resting stop protecting a real
          // live position became invisible to the DB and every future poll.
          // Checking Alpaca's own open orders first (not just trusting our
          // own placeOrder outcome, before AND after attempting it) makes
          // this idempotent: whichever invocation actually created the stop,
          // we adopt it rather than risk overwriting it with null.
          const optionSymbol = position.option_symbol
          const findRestingStop = async () => {
            const openOrders = await getOpenOrders(optionSymbol)
            return openOrders?.find(o => o.type === 'stop' && o.side === 'sell') ?? null
          }

          const preExistingStop = await findRestingStop()
          if (preExistingStop) {
            newStopOrderId = preExistingStop.id
          } else {
            try {
              const newStopOrder = await placeOrder({
                symbol: position.option_symbol, qty: remaining, side: 'sell', type: 'stop',
                stopPrice: newStopPrice, timeInForce: 'day', clientOrderId: ids.stopReplace(stopReplaceAttempt)
              })
              newStopOrderId = newStopOrder.id
            } catch (e) {
              // Could be a genuine failure, OR we lost a race that placed the
              // real stop between the check above and this attempt - re-check
              // before concluding the position is actually unprotected.
              const raceWinnerStop = await findRestingStop()
              if (raceWinnerStop) {
                newStopOrderId = raceWinnerStop.id
              } else {
                ratchetFailure = describeAlpacaError(e)
              }
            }
          }
        } catch (e) {
          ratchetFailure = describeAlpacaError(e)
        }

        if (ratchetFailure) {
          await notifyManualReview(position.underlying_symbol, `CRITICAL: stop replace failed after tier fill - position now unprotected - ${ratchetFailure}`)
        }

        await supabase.from('option_positions').update({
          remaining_contracts: remaining, stop_pct: BREAKEVEN_PROTECTION_STOP_PCT, stop_order_id: newStopOrderId,
          ...(ratchetFailure ? { needs_manual_review: true, review_reason: `stop replace after tier fill failed - position unprotected: ${ratchetFailure}` } : {})
        }).eq('id', position.id)
      }
    } catch (positionError) {
      console.error(`Error managing option position ${position.id} (${position.underlying_symbol}):`, positionError)
      await supabase.from('option_positions').update({
        needs_manual_review: true, review_reason: describeAlpacaError(positionError)
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
    res.status(500).json({ error: describeAlpacaError(error) })
  }
}
