import { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../server/supabaseAdmin.js'
import { verifyCronSecret } from '../../server/verifyCronSecret.js'
import { isMarketOpen } from '../../server/marketHours.js'
import { getAccount, getOrder, getOpenOrders, getOptionQuote, getBars5Min, placeOrder, cancelOrder, describeAlpacaError } from '../../server/execution/alpacaClient.js'
import { computeSwingContractCount, MIN_CONTRACTS, MAX_POSITION_DOLLARS, PROFIT_TARGET_PCT, STOP_LOSS_PCT, DAYS_TO_EXPIRY_FORCE_CLOSE } from '../../server/execution/swingPositionSizing.js'
import { swingClientOrderIds } from '../../server/execution/clientOrderIds.js'
import { isFomcDay, isCpiDay } from '../../server/economicCalendar.js'
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

// Confirmed live 2026-09-10: a market sell on a thin swing contract (COST
// $980C, effectively no volume since entry) filled at $0.01 against a
// stop trigger that had read the bid at $0.25 moments earlier - the
// underlying hadn't even moved against the position. A market order has no
// floor, so on an empty book it fills at whatever price is resting, however
// far from the last real quote. Exits now place a marketable LIMIT at the
// just-read bid instead (same floor logic as entries' liquidity-aware
// pricing) and poll briefly for the fill - bounds the worst case to "no
// worse than the price that triggered the close" instead of "whatever the
// book has."
const EXIT_FILL_POLL_ATTEMPTS = 5
const EXIT_FILL_POLL_DELAY_MS = 500

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

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
      .select('id, underlying_symbol, option_symbol, entry_order_id, premium_entry, contracts')
      .eq('status', 'entry_submitted')

    for (const position of submitted ?? []) {
      if (!position.entry_order_id) continue
      const order = await getOrder(position.entry_order_id, 'swing')
      if (order?.status === 'filled') {
        const fillPrice = order.filled_avg_price ? parseFloat(order.filled_avg_price) : position.premium_entry

        // Broker-side stop, placed immediately on fill (2026-09-19) - same
        // reasoning as option_positions' stop_order_id (migration 019):
        // protection now runs on Alpaca's own matching engine instead of
        // depending on the next invocation of this cron noticing in time.
        // Found live that the old poll-and-sell approach (quote.bid checked
        // only whenever this cron happened to run, ~15-75min apart) let
        // thin-liquidity contracts (COST, UNP) run 67-90% down before the
        // bot ever caught the 50% STOP_LOSS_PCT breach.
        const stopIds = swingClientOrderIds(position.id)
        const stopPrice = fillPrice * (1 - STOP_LOSS_PCT)
        let stopOrderId: string | null = null
        let stopPlacementError: string | null = null
        try {
          const stopOrder = await placeOrder({
            symbol: position.option_symbol, qty: position.contracts, side: 'sell', type: 'stop',
            stopPrice, timeInForce: 'day', clientOrderId: stopIds.stopPlace()
          }, 'swing')
          stopOrderId = stopOrder.id
        } catch (e) {
          stopPlacementError = describeAlpacaError(e)
        }

        await supabase.from('swing_positions').update({
          status: 'open',
          premium_entry: fillPrice,
          stop_order_id: stopOrderId,
          // A fill with no protective stop is naked - flag it loudly rather
          // than let it look like any other open position (same reasoning
          // as execute-alerts.ts's identical check on the day-trade side).
          needs_manual_review: stopOrderId === null,
          review_reason: stopOrderId === null ? `entry filled but protective stop order failed to place: ${stopPlacementError}` : null
        }).eq('id', position.id)
        if (stopOrderId === null) {
          await sendToTopic(ALERTS_TOPIC, `Swing bot: manual review (${position.underlying_symbol})`, `CRITICAL: ${position.option_symbol} filled but has NO protective stop - ${stopPlacementError}`)
        }
        reconciled++
      } else if (order && ['canceled', 'expired', 'rejected'].includes(order.status)) {
        await supabase.from('swing_positions').update({
          status: 'entry_failed', closed_at: new Date().toISOString(),
          review_reason: `entry order ${order.status}, never filled at limit $${position.premium_entry}`
        }).eq('id', position.id)
        reconciled++
      }
      // else: still resting - nothing to do, day-TIF order will fill,
      // expire, or get checked again next invocation.
    }

    // --- Manage open positions against the single full-exit spec (+30%
    // target / -50% stop / exit within 3 trading days of expiry - no tier
    // ladder, swing sizes are too small to scale out of). The stop itself
    // is now a real resting order at the broker (placed on entry fill,
    // migration 028) - this loop's job on the stop side is to keep that
    // resting order honest (re-arm it if it's gone missing), not to detect
    // the breach itself the way it used to.
    const { data: open } = await supabase
      .from('swing_positions')
      .select('id, underlying_symbol, option_symbol, contracts, premium_entry, expiration_date, stop_order_id')
      .eq('status', 'open')

    const now = new Date()

    type OpenSwingPosition = { id: string; underlying_symbol: string; option_symbol: string; contracts: number; premium_entry: number; expiration_date: string; stop_order_id: string | null }

    // Shared by both the "target/time-exit hit" path and the "stop already
    // gapped through while unprotected" heal path - places a marketable
    // limit at the just-read bid (not a market order: a thin-liquidity
    // contract with no resting size can fill a bare market order far below
    // the quote that triggered it, confirmed live 2026-09-10 on COST) and
    // polls briefly for the fill.
    const exitAtBid = async (
      position: OpenSwingPosition, bid: number,
      closeReason: 'closed_target' | 'closed_stop' | 'closed_time_exit', note: string
    ): Promise<boolean> => {
      const ids = swingClientOrderIds(position.id)
      try {
        const order = await placeOrder({
          symbol: position.option_symbol, qty: position.contracts, side: 'sell',
          type: 'limit', timeInForce: 'day', limitPrice: bid, clientOrderId: ids.exit()
        }, 'swing')

        let filled = order.status === 'filled' ? order : null
        for (let attempt = 0; !filled && attempt < EXIT_FILL_POLL_ATTEMPTS; attempt++) {
          await sleep(EXIT_FILL_POLL_DELAY_MS)
          const polled = await getOrder(order.id, 'swing')
          if (polled?.status === 'filled') filled = polled
          else if (polled && ['canceled', 'expired', 'rejected'].includes(polled.status)) break
        }

        if (filled) {
          const fillPrice = filled.filled_avg_price ? parseFloat(filled.filled_avg_price) : bid
          await supabase.from('swing_positions').update({
            status: closeReason, exit_price: fillPrice, exit_order_id: order.id, closed_at: now.toISOString()
          }).eq('id', position.id)
          await sendToTopic(ALERTS_TOPIC, `Swing exit: ${position.underlying_symbol}`, note)
          return true
        }

        // Didn't fill against the bid within the poll window (or came back
        // canceled/expired/rejected on its own) - cancel any remainder so
        // nothing's left resting, and leave the position as 'open'
        // untouched. Next invocation re-evaluates against a fresh quote and
        // retries with a fresh client_order_id, rather than chasing a stale
        // limit price across cycles.
        await cancelOrder(order.id, 'swing')
        return false
      } catch (error) {
        await supabase.from('swing_positions').update({
          needs_manual_review: true,
          review_reason: `exit order failed (${closeReason}): ${describeAlpacaError(error)}`
        }).eq('id', position.id)
        await sendToTopic(ALERTS_TOPIC, `Swing bot: manual review (${position.underlying_symbol})`, `Exit order failed - ${describeAlpacaError(error)}`)
        return false
      }
    }

    for (const position of (open ?? []) as OpenSwingPosition[]) {
      // --- Keep the resting broker-side stop honest before anything else.
      // A day-TIF options stop expires every night, so "no longer resting"
      // is the EXPECTED state on the first check of every trading day a
      // position stays open past one session - re-arming it here is
      // routine, not an anomaly, unlike the day-trade bot's 0DTE stop
      // (which lives and dies within a single session, so any cancellation
      // there really is unexpected and worth flagging every time). Only a
      // genuinely-unprotected gap - price already through the stop level,
      // or the re-arm itself failing - gets flagged here; the routine
      // nightly reroll does not, or every open swing position would flag
      // for manual review every single morning.
      const stopPrice = position.premium_entry * (1 - STOP_LOSS_PCT)
      let stopStillResting = false

      if (position.stop_order_id) {
        const stopOrder = await getOrder(position.stop_order_id, 'swing')
        if (stopOrder?.status === 'filled') {
          const fillPrice = stopOrder.filled_avg_price ? parseFloat(stopOrder.filled_avg_price) : stopPrice
          await supabase.from('swing_positions').update({
            status: 'closed_stop', exit_price: fillPrice, exit_order_id: stopOrder.id, closed_at: now.toISOString()
          }).eq('id', position.id)
          closedCount++
          await sendToTopic(ALERTS_TOPIC, `Swing exit: ${position.underlying_symbol}`, `stop (broker-side) at $${fillPrice.toFixed(2)}`)
          continue
        }
        stopStillResting = !!stopOrder && !['canceled', 'expired', 'rejected'].includes(stopOrder.status)
      }

      if (!stopStillResting) {
        // Race safety, same pattern monitor-executions.ts uses for the
        // day-trade bot: a concurrent overlapping invocation may already be
        // mid-way through replacing this exact stop - ask Alpaca directly
        // before concluding there's really no protection.
        const openOrders = await getOpenOrders(position.option_symbol, 'swing')
        const replacementStop = openOrders?.find(o => o.type === 'stop' && o.side === 'sell') ?? null

        if (replacementStop) {
          if (replacementStop.id !== position.stop_order_id) {
            position.stop_order_id = replacementStop.id
            await supabase.from('swing_positions').update({ stop_order_id: replacementStop.id }).eq('id', position.id)
          }
        } else {
          const gapQuote = await getOptionQuote(position.option_symbol, 'swing')

          if (gapQuote && gapQuote.bid > 0 && gapQuote.bid <= stopPrice) {
            // Already breached by the time we caught the gap (an overnight
            // move most likely, since that's the only time the stop is
            // reliably not resting) - a passive stop order priced above the
            // current market is invalid, so flatten instead of placing one
            // that would just get rejected.
            const flattened = await exitAtBid(position, gapQuote.bid, 'closed_stop',
              `stop gapped through while unprotected - flattened at $${gapQuote.bid.toFixed(2)} (intended stop $${stopPrice.toFixed(2)})`)
            if (flattened) {
              closedCount++
              await sendToTopic(ALERTS_TOPIC, `Swing bot: manual review (${position.underlying_symbol})`,
                `Protective stop was not resting and price had already breached $${stopPrice.toFixed(2)} - flattened at $${gapQuote.bid.toFixed(2)}`)
              continue
            }
            // Flatten didn't fill either (thin book) - fall through and
            // re-arm the stop below so it's not left fully naked either way.
          }

          const stopIds = swingClientOrderIds(position.id)
          try {
            const healedStop = await placeOrder({
              symbol: position.option_symbol, qty: position.contracts, side: 'sell', type: 'stop',
              stopPrice, timeInForce: 'day', clientOrderId: stopIds.stopPlace()
            }, 'swing')
            position.stop_order_id = healedStop.id
            await supabase.from('swing_positions').update({ stop_order_id: healedStop.id }).eq('id', position.id)
          } catch (e) {
            await supabase.from('swing_positions').update({
              needs_manual_review: true,
              review_reason: `protective stop re-arm failed - position unprotected: ${describeAlpacaError(e)}`
            }).eq('id', position.id)
            await sendToTopic(ALERTS_TOPIC, `Swing bot: manual review (${position.underlying_symbol})`, `CRITICAL: protective stop re-arm failed - position unprotected - ${describeAlpacaError(e)}`)
          }
        }
      }

      // --- Target / time-exit: still a bot-polled bid check (no resting
      // profit-target order - swing sizes don't warrant one), but the
      // resting stop has to be cancelled first since Alpaca won't let the
      // same contracts back a second resting sell order.
      const quote = await getOptionQuote(position.option_symbol, 'swing')
      if (!quote || quote.bid <= 0) continue

      const pctMove = (quote.bid - position.premium_entry) / position.premium_entry
      const daysToExpiry = Math.round((new Date(position.expiration_date).getTime() - now.getTime()) / (24 * 60 * 60 * 1000))

      let closeReason: 'closed_target' | 'closed_time_exit' | null = null
      if (pctMove >= PROFIT_TARGET_PCT) closeReason = 'closed_target'
      else if (daysToExpiry <= DAYS_TO_EXPIRY_FORCE_CLOSE) closeReason = 'closed_time_exit'

      if (!closeReason) continue

      const currentStopId = position.stop_order_id
      if (currentStopId) {
        const canceled = await cancelOrder(currentStopId, 'swing')
        if (!canceled) {
          // Could already be filled (thin window between the check above
          // and now) - re-check rather than risk trying to sell contracts
          // still committed to a live resting order.
          const recheck = await getOrder(currentStopId, 'swing')
          if (recheck?.status === 'filled') {
            const fillPrice = recheck.filled_avg_price ? parseFloat(recheck.filled_avg_price) : stopPrice
            await supabase.from('swing_positions').update({
              status: 'closed_stop', exit_price: fillPrice, exit_order_id: recheck.id, closed_at: now.toISOString()
            }).eq('id', position.id)
            closedCount++
            await sendToTopic(ALERTS_TOPIC, `Swing exit: ${position.underlying_symbol}`, `stop (broker-side) at $${fillPrice.toFixed(2)}`)
            continue
          }
        }
      }

      const closed = await exitAtBid(position, quote.bid, closeReason,
        `${closeReason.replace('closed_', '')} at ${(pctMove * 100).toFixed(1)}% (${daysToExpiry}d to expiry)`)

      if (closed) {
        closedCount++
      } else if (currentStopId) {
        // Exit didn't fill and the protective stop was already cancelled to
        // make room for it - don't leave the position naked until the next
        // invocation, put a stop back before moving on.
        const stopIds = swingClientOrderIds(position.id)
        try {
          const restoredStop = await placeOrder({
            symbol: position.option_symbol, qty: position.contracts, side: 'sell', type: 'stop',
            stopPrice, timeInForce: 'day', clientOrderId: stopIds.stopPlace()
          }, 'swing')
          await supabase.from('swing_positions').update({ stop_order_id: restoredStop.id }).eq('id', position.id)
        } catch (e) {
          await supabase.from('swing_positions').update({
            needs_manual_review: true,
            review_reason: `stop cancelled to attempt a ${closeReason} sell, sell didn't fill, AND restoring the stop failed - position unprotected: ${describeAlpacaError(e)}`
          }).eq('id', position.id)
          await sendToTopic(ALERTS_TOPIC, `Swing bot: manual review (${position.underlying_symbol})`, `CRITICAL: stop cancelled for exit attempt, exit failed, restore also failed - position unprotected - ${describeAlpacaError(e)}`)
        }
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

      // Checked once per invocation, not per-alert - a fresh option entry on
      // a scheduled binary-event day (Fed rate decision, CPI print) carries
      // outsized gap/IV-crush risk that has nothing to do with the RSI signal
      // itself. Blocks new entries only - never touches exits, and both
      // dates come from the Fed's/BLS's own published calendars
      // (economicCalendar.ts), not a fitted/backtested signal, so this is
      // safe to ship without the backtest the fuzzier commodity-correlation
      // idea still needs (see swingOptionSelection.ts's buildMacroNote).
      const macroBlackout = isFomcDay() || isCpiDay()

      for (const alert of pending) {
        // Marked attempted regardless of outcome below (success or any
        // failure) - one shot per oversold episode, same as every other
        // entry gate in this app. entry_skip_reason stays null here (set
        // below on whichever pre-flight gate actually rejects, if any) -
        // added 2026-09-03 after 5 real CALL alerts fired the same day the
        // oversold threshold loosened (30->35) and every single one
        // silently vanished with entry_attempted=true and no order ever
        // reaching Alpaca - the skip reason previously only existed in
        // this invocation's transient JSON response, making root-causing
        // it after the fact require replaying this entire function by
        // hand in a one-off script instead of just querying the DB.
        const attemptedAt = new Date().toISOString()
        await supabase.from('swing_trade_alerts').update({ entry_attempted: true, entry_attempted_at: attemptedAt }).eq('id', alert.id)
        const markSkipped = (reason: string) =>
          supabase.from('swing_trade_alerts').update({ entry_skip_reason: reason }).eq('id', alert.id)

        if (macroBlackout) {
          await markSkipped('macro blackout: FOMC/CPI release today')
          entryResults.push({ symbol: alert.symbol, outcome: 'skipped: macro blackout: FOMC/CPI release today' })
          continue
        }

        if (!account) {
          await markSkipped('swing account unavailable')
          entryResults.push({ symbol: alert.symbol, outcome: 'skipped: swing account unavailable (check ALPACA_SWING_API_KEY_ID/SECRET)' })
          continue
        }
        if (!alert.ideal_entry_price || !alert.ask_price || !alert.recommended_strike || !alert.expiration_date) {
          await markSkipped('incomplete pricing data')
          entryResults.push({ symbol: alert.symbol, outcome: 'skipped: incomplete pricing data' })
          continue
        }

        const ageMinutes = (Date.now() - new Date(alert.oversold_date).getTime()) / 60_000
        if (ageMinutes > STALENESS_CUTOFF_MINUTES) {
          await markSkipped(`stale (${ageMinutes.toFixed(0)}min old pricing)`)
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
            await markSkipped(`no affordable strike found under $${MAX_POSITION_DOLLARS}/${MIN_CONTRACTS}`)
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
          await markSkipped(sizing.reason)
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
          await markSkipped(`order failed: ${describeAlpacaError(error)}`)
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
