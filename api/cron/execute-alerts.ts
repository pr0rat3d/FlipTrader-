import { VercelRequest, VercelResponse } from '@vercel/node'
import { supabase } from '../../server/supabaseAdmin.js'
import { verifyCronSecret } from '../../server/verifyCronSecret.js'
import { isMarketOpen, hasSessionClosedSince, nyDateKey } from '../../server/marketHours.js'
import { getAccount, placeOrder, getOrder, findOptionContract, getOptionQuote } from '../../server/execution/alpacaClient.js'
import {
  computeContractCount, tierPlanFor, ContractSizeSettings,
  FORCE_CLOSE_HOUR_ET, FORCE_CLOSE_MINUTE_ET, MARKET_OPEN_MINUTES_ET, IV_ELIGIBLE_AFTER_MINUTES
} from '../../server/execution/optionPositionSizing.js'
import { optionClientOrderIds } from '../../server/execution/clientOrderIds.js'
import { suggestOptionStrike } from '../../src/lib/optionSuggestion.js'
import { nyMinutesSinceMidnight } from '../../server/rvol.js'

export const config = {
  maxDuration: 60
}

// A market order should fill almost immediately in a liquid 0DTE SPY/QQQ/IWM
// chain - poll briefly rather than assuming instant fill, but don't wait long.
const FILL_POLL_ATTEMPTS = 8
const FILL_POLL_INTERVAL_MS = 1000
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// A fresh signal clearing every entry gate (confidence, IV timing, etc.) in
// the OPPOSITE direction from a currently open position means the thesis it
// was bought on has flipped - flatten everything open (any symbol, not just
// the one the new signal is on) rather than hold contracts betting against
// evidence strong enough to trigger a real new trade. Runs right before the
// atomic claim for a qualifying leg, so it only fires when the bot is
// actually about to act on the opposing signal, not on every scan.
const closeOpposingPositions = async (newDirection: 'bullish' | 'bearish'): Promise<number> => {
  const { data: openPositions, error } = await supabase
    .from('option_positions')
    .select('id, underlying_symbol, option_symbol, remaining_contracts, direction')
    .eq('status', 'open')
  if (error) throw error

  const opposing = (openPositions || []).filter(p => p.direction !== newDirection && p.option_symbol && p.remaining_contracts > 0)
  let closed = 0

  for (const pos of opposing) {
    try {
      // placeOrder throws on failure - reaching the update below means it
      // genuinely succeeded.
      await placeOrder({
        symbol: pos.option_symbol, qty: pos.remaining_contracts, side: 'sell', type: 'market', timeInForce: 'day',
        clientOrderId: `opposing-flip-${pos.id}-${Date.now()}`
      })
      await supabase.from('option_positions').update({
        status: 'closed_manual', remaining_contracts: 0, closed_at: new Date().toISOString(),
        review_reason: `Closed automatically - a fresh ${newDirection} signal cleared entry gates while this ${pos.direction} position was still open`
      }).eq('id', pos.id)
      closed++
    } catch (e) {
      await supabase.from('option_positions').update({
        needs_manual_review: true, review_reason: `opposing-direction flatten failed: ${String(e)}`
      }).eq('id', pos.id)
    }
  }

  return closed
}

// Same-symbol+direction re-entry after a prior position in that direction
// already closed today requires proof the move actually paused first - the
// MACD histogram must have crossed back through zero at some point since the
// close, not just still be the same continuous trend the 30-bar rolling
// lookback (scan-confluence.ts) keeps calling "bullish"/"bearish" scan after
// scan. Without this, IV/ORB's own re-fire-every-few-minutes behavior (see
// the strike-selection comment below) would let the bot re-enter the
// identical move repeatedly with no new information behind it. Reads
// indicator_snapshots rather than profit_targets/day_trade_alerts because
// those only get a row when a signal condition already fires - the snapshot
// table is written every scan-confluence run regardless, so it's the only
// place with a continuous histogram history to detect a reset against.
const hasMomentumReset = async (symbol: string, direction: 'bullish' | 'bearish', sinceIso: string): Promise<boolean> => {
  const { data, error } = await supabase
    .from('indicator_snapshots')
    .select('macd_histogram')
    .eq('symbol', symbol)
    .eq('category', 'day_trade')
    .gt('timestamp', sinceIso)
    .not('macd_histogram', 'is', null)
  if (error) throw error
  if (!data || data.length === 0) return false
  return direction === 'bullish' ? data.some(r => r.macd_histogram <= 0) : data.some(r => r.macd_histogram >= 0)
}

interface OpenLeg {
  id: string
  symbol: string
  entry_price: number
  entry_time: string
  target_50ema_price: number
  // See execute-alerts.ts git history (2026-07-14) for why this is a single
  // object, not an array - a many-to-one FK embeds as an object in PostgREST.
  day_trade_alerts: {
    macd_curl: 'bullish' | 'bearish'
    confidence: number | null
    ttf_status: string
    confluence_level: number | null
    indices_triggered: string[]
  } | null
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

    // A brand-new 0DTE position opened after the force-close cutoff would get
    // immediately flattened by monitor-executions.ts on its very next poll -
    // a pointless round-trip that only pays the bid-ask spread for zero
    // chance to develop. No new entries once we're past that point.
    if (nyMinutesSinceMidnight(new Date()) >= FORCE_CLOSE_HOUR_ET * 60 + FORCE_CLOSE_MINUTE_ET) {
      return res.status(200).json({ success: true, skipped: true, reason: 'past force-close cutoff, no new entries' })
    }

    // Hard cap on total entries per NY trading day - not contract count, not
    // buy/sell activity, just how many separate positions get opened (e.g.
    // 2 contracts on an IV attempt + 4 on one ORB breakout + 2 on another ORB
    // breakout = 3 entries, done for the day). Counted as any position that
    // actually got a real order placed (entry_order_id set), regardless of
    // how it later resolved - an attempt that got skipped/rejected before
    // placing an order doesn't consume a slot.
    const { data: recentEntries, error: recentEntriesError } = await supabase
      .from('option_positions')
      .select('claimed_at')
      .not('entry_order_id', 'is', null)
      .order('claimed_at', { ascending: false })
      .limit(50)
    if (recentEntriesError) throw recentEntriesError

    const today = nyDateKey(new Date())
    // Mutable - re-checked inside the per-leg loop too (see below), not just
    // once here, so a single run that finds multiple qualifying legs at once
    // can't blow through the cap in one pass.
    let entriesToday = (recentEntries || []).filter(e => nyDateKey(e.claimed_at) === today).length
    if (entriesToday >= settingsRow.max_daily_entries) {
      return res.status(200).json({
        success: true, skipped: true, reason: `daily entry cap reached (${entriesToday}/${settingsRow.max_daily_entries})`
      })
    }

    const sizeSettings: ContractSizeSettings = {
      minAccountEquity: settingsRow.min_account_equity,
      maxAccountEquity: settingsRow.max_account_equity
    }

    const { data: legs, error: legsError } = await supabase
      .from('profit_targets')
      .select('id, symbol, entry_price, entry_time, target_50ema_price, day_trade_alerts(macd_curl, confidence, ttf_status, confluence_level, indices_triggered)')
      .eq('status', 'open')

    if (legsError) throw legsError
    if (!legs || legs.length === 0) {
      return res.status(200).json({ success: true, processed: 0 })
    }

    const { data: existing, error: existingError } = await supabase
      .from('option_positions')
      .select('profit_target_id')
      .in('profit_target_id', legs.map((l: any) => l.id))
    if (existingError) throw existingError
    const alreadyClaimed = new Set((existing || []).map((e: any) => e.profit_target_id))

    let processed = 0
    let entered = 0

    for (const leg of legs as unknown as OpenLeg[]) {
      if (entriesToday >= settingsRow.max_daily_entries) break
      if (alreadyClaimed.has(leg.id)) continue

      const direction = leg.day_trade_alerts?.macd_curl
      const confidence = leg.day_trade_alerts?.confidence ?? 0
      if (!direction) continue
      if (confidence < settingsRow.min_confidence) continue

      // IV only - ORB's own 15-min opening-range window is already a
      // sufficient "wait," see optionPositionSizing.ts.
      if (
        leg.day_trade_alerts?.ttf_status === 'IV' &&
        nyMinutesSinceMidnight(new Date()) < MARKET_OPEN_MINUTES_ET + IV_ELIGIBLE_AFTER_MINUTES
      ) continue

      // Don't pyramid into the same symbol+direction while a position is
      // already open there - a same-direction re-fire (e.g. QQQ 713C already
      // open, a fresh alert re-fires at 714C a dollar later as price
      // drifted) doesn't need its own separate position; the existing one
      // already has the trade on. Skip entirely rather than claim/enter -
      // this is a "no action needed," not a failure to record.
      const { data: sameDirectionOpen, error: sameDirectionError } = await supabase
        .from('option_positions')
        .select('id')
        .eq('underlying_symbol', leg.symbol)
        .eq('direction', direction)
        .eq('status', 'open')
        .limit(1)
      if (sameDirectionError) throw sameDirectionError
      if (sameDirectionOpen && sameDirectionOpen.length > 0) continue

      // A prior same-symbol+direction position that already closed TODAY
      // (any resolution) still guards re-entry until momentum actually
      // resets - see hasMomentumReset above. Only today's close matters; a
      // resolved position from a prior session has no bearing on a fresh
      // session's first move. IV and ORB are exactly the repetitive-re-fire
      // case this gate targets (re-firing every few minutes off the same
      // static level/breakout with no new price structure behind it) - but
      // TTF/DTF/STF is exempt, since RSI divergence requires a genuinely NEW
      // price extreme with RSI failing to confirm it (detectRSIDivergence)
      // to fire at all. A second full-confluence signal later in the day
      // already IS the proof of a fresh pullback-and-turn; gating it on the
      // histogram too would risk blocking a legitimate high-confidence
      // re-entry during a strong, persistently one-sided trend day where the
      // histogram simply never dips back through zero.
      const ttfStatus = leg.day_trade_alerts?.ttf_status
      if (ttfStatus === 'IV' || ttfStatus === 'ORB') {
        const { data: lastClosedRows, error: lastClosedError } = await supabase
          .from('option_positions')
          .select('closed_at')
          .eq('underlying_symbol', leg.symbol)
          .eq('direction', direction)
          .not('closed_at', 'is', null)
          .order('closed_at', { ascending: false })
          .limit(1)
        if (lastClosedError) throw lastClosedError
        const lastClosedAt = lastClosedRows?.[0]?.closed_at
        if (lastClosedAt && nyDateKey(lastClosedAt) === today) {
          const reset = await hasMomentumReset(leg.symbol, direction, lastClosedAt)
          if (!reset) continue
        }
      }

      // This leg has cleared every entry gate - if that means the bot is
      // about to act on a signal opposite to something already open (any
      // symbol), flatten the old position(s) first.
      await closeOpposingPositions(direction)

      const { data: claimed, error: claimError } = await supabase
        .from('option_positions')
        .insert({ profit_target_id: leg.id, underlying_symbol: leg.symbol, direction })
        .select()
      if (claimError) {
        if ((claimError as any).code === '23505') continue
        throw claimError
      }
      if (!claimed || claimed.length === 0) continue

      const positionId = claimed[0].id
      processed++

      try {
        if (hasSessionClosedSince(new Date(leg.entry_time))) {
          await supabase.from('option_positions').update({ status: 'skipped_bad_data', review_reason: 'session already closed' }).eq('id', positionId)
          continue
        }

        const account = await getAccount()
        if (!account) {
          await supabase.from('option_positions').update({
            status: 'needs_manual_review', needs_manual_review: true, review_reason: 'failed to fetch Alpaca account'
          }).eq('id', positionId)
          continue
        }

        // Always entry_price, never confluence_level, here. confluence_level
        // is where IV's reversal ORIGINALLY triggered (a fixed, mostly-static
        // reference like PDH that doesn't move intraday) - fine as manual-
        // trading guidance ("don't chase, let it come to you" - AlertCard's
        // Ideal Entry line), but IV re-fires every few minutes for as long as
        // the setup holds, and the bot enters at whatever entry_price the
        // FIRST re-fire that clears min_confidence happens to have - which
        // can be well after the level was first tested. Found live 2026-07-15:
        // a SPY IV bearish alert fired at entry_price $750.27, ~$4.59 already
        // below its confluence_level of $754.86 (that day's PDH) by the time
        // it cleared 0.7 confidence - using confluence_level as the strike
        // basis bought a 755 put (deep ITM relative to the ACTUAL $750.27
        // entry) instead of a strike anywhere near where the position
        // actually opened.
        const suggestion = suggestOptionStrike(direction, leg.entry_price, leg.target_50ema_price)
        const contractType = direction === 'bullish' ? 'call' : 'put'
        const expirationDate = nyDateKey(new Date())

        const contract = await findOptionContract(leg.symbol, expirationDate, suggestion.entryStrike, contractType)
        if (!contract) {
          await supabase.from('option_positions').update({
            status: 'skipped_bad_data', review_reason: `no ${contractType} contract found for ${leg.symbol} ${expirationDate} near $${suggestion.entryStrike}`,
            account_equity_at_entry: account.equity
          }).eq('id', positionId)
          continue
        }

        const quote = await getOptionQuote(contract.symbol)
        if (!quote) {
          await supabase.from('option_positions').update({
            status: 'needs_manual_review', needs_manual_review: true, review_reason: `no quote for ${contract.symbol}`,
            account_equity_at_entry: account.equity
          }).eq('id', positionId)
          continue
        }

        const sizeResult = computeContractCount({
          accountEquity: account.equity,
          buyingPower: account.buying_power,
          riskPct: settingsRow.risk_pct,
          premiumAsk: quote.ask
        }, sizeSettings)

        if (!sizeResult.ok) {
          // insufficient_buying_power at even the 2-contract floor is a normal,
          // expected outcome on a small account and an expensive premium - a
          // quiet skip, not a flag. equity_out_of_band/invalid_premium suggest
          // something is actually wrong upstream.
          const quiet = sizeResult.reason === 'insufficient_buying_power'
          await supabase.from('option_positions').update({
            status: quiet ? 'skipped_bad_data' : 'needs_manual_review',
            needs_manual_review: !quiet,
            review_reason: sizeResult.reason,
            account_equity_at_entry: account.equity,
            option_symbol: contract.symbol, contract_type: contractType, strike_price: contract.strikePrice, expiration_date: expirationDate
          }).eq('id', positionId)
          continue
        }

        const ids = optionClientOrderIds(leg.id)

        let entryOrder
        try {
          entryOrder = await placeOrder({
            symbol: contract.symbol, qty: sizeResult.contracts, side: 'buy', type: 'market', timeInForce: 'day', clientOrderId: ids.entry
          })
        } catch (e) {
          await supabase.from('option_positions').update({
            status: 'entry_failed', account_equity_at_entry: account.equity, review_reason: String(e),
            option_symbol: contract.symbol, contract_type: contractType, strike_price: contract.strikePrice, expiration_date: expirationDate
          }).eq('id', positionId)
          continue
        }

        await supabase.from('option_positions').update({
          status: 'entry_submitted',
          option_symbol: contract.symbol, contract_type: contractType, strike_price: contract.strikePrice, expiration_date: expirationDate,
          contracts: sizeResult.contracts, account_equity_at_entry: account.equity, entry_order_id: entryOrder.id
        }).eq('id', positionId)
        // Counts toward the daily cap the moment an order is actually placed
        // (matches the entry_order_id-not-null criterion the pre-loop count
        // above uses), not only once a fill is confirmed - an order that's
        // out at the broker already consumed a slot for the day regardless
        // of how the fill poll below resolves.
        entriesToday++

        let filled = false
        let fillPrice: number | null = null
        for (let i = 0; i < FILL_POLL_ATTEMPTS; i++) {
          const status = await getOrder(entryOrder.id)
          if (status?.status === 'filled') {
            filled = true
            fillPrice = status.filled_avg_price ? parseFloat(status.filled_avg_price) : quote.ask
            break
          }
          if (status && ['canceled', 'expired', 'rejected'].includes(status.status)) break
          await sleep(FILL_POLL_INTERVAL_MS)
        }

        if (!filled || fillPrice === null) {
          await supabase.from('option_positions').update({
            status: 'needs_manual_review', needs_manual_review: true,
            review_reason: 'entry order did not confirm filled within poll window'
          }).eq('id', positionId)
          continue
        }

        await supabase.from('option_positions').update({
          status: 'open',
          premium_entry: fillPrice,
          remaining_contracts: sizeResult.contracts,
          stop_pct: settingsRow.hard_stop_pct
        }).eq('id', positionId)
        entered++

        const tiers = tierPlanFor(sizeResult.contracts)
        const { error: tiersError } = await supabase.from('option_position_tiers').insert(
          tiers.map(t => ({
            option_position_id: positionId,
            tier_number: t.tierNumber,
            is_runner: t.isRunner,
            target_pct: t.targetPct
          }))
        )
        if (tiersError) {
          await supabase.from('option_positions').update({
            needs_manual_review: true, review_reason: `entered but tier rows failed to insert: ${tiersError.message}`
          }).eq('id', positionId)
        }
      } catch (legError) {
        console.error(`Error executing leg ${leg.id} (${leg.symbol}):`, legError)
        await supabase.from('option_positions').update({
          status: 'needs_manual_review', needs_manual_review: true, review_reason: String(legError)
        }).eq('id', positionId)
      }
    }

    res.status(200).json({ success: true, processed, entered })
  } catch (error) {
    console.error('Error in execute-alerts:', error)
    res.status(500).json({ error: String(error) })
  }
}
