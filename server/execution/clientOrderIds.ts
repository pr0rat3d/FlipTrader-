// Deterministic per-leg client_order_ids - the same profit_target_id always
// produces the same ids, so even if our own code path somehow calls Alpaca
// twice for the same leg (ambiguous timeout, retry after a crash), Alpaca's
// own dedup on client_order_id is a second line of defense behind the
// trade_executions UNIQUE-constraint claim.
export const clientOrderIds = (profitTargetId: string) => ({
  entry: `entry-${profitTargetId}`,
  stop: `stop-${profitTargetId}`,
  tier1: `tier1-${profitTargetId}`,
  tier2: `tier2-${profitTargetId}`,
  tier3: `tier3-${profitTargetId}`,
  hardStop: `hardstop-${profitTargetId}`
})

// Options positions have a variable number of tiers (1-4 fixed tiers + a
// runner, depending on contract count), unlike shares' fixed tier1/2/3 - a
// tier(n) function instead of fixed named keys.
export const optionClientOrderIds = (profitTargetId: string) => ({
  entry: `opt-entry-${profitTargetId}`,
  hardStop: `opt-hardstop-${profitTargetId}`,
  timeLock: `opt-timelock-${profitTargetId}`,
  forceClose: `opt-forceclose-${profitTargetId}`,
  tier: (tierNumber: number) => `opt-tier${tierNumber}-${profitTargetId}`,
  // The resting broker-side stop (2026-07-16) gets cancelled and re-placed
  // each time a tier fills (qty shrinks, and on the first fill the price
  // ratchets to breakeven) - Alpaca's client_order_id uniqueness applies
  // even to already-cancelled orders, so `hardStop`'s id can't be reused.
  // `attempt` = how many tiers have filled so far, keeping each replacement
  // deterministic/traceable rather than a raw timestamp.
  stopReplace: (attempt: number) => `opt-stopreplace${attempt}-${profitTargetId}`,
  // Restoring the SAME stop after a tier-fallback sell attempt failed post-
  // cancel (2026-07-29 fix - see options-bot memory for the "uncovered
  // option contracts" root cause) - a raw timestamp here, not an attempt
  // counter, since this is a rare recovery path with no natural sequence
  // number and just needs to be unique per attempt.
  stopRestore: () => `opt-stoprestore-${Date.now()}-${profitTargetId}`,
  // Auto-heal placement when the stop-health check finds a position with no
  // resting stop at all (2026-08-11 fix) - same "raw timestamp, no natural
  // sequence number" reasoning as stopRestore, since this can in principle
  // fire on repeated polls if healing itself keeps failing.
  stopHeal: () => `opt-stopheal-${Date.now()}-${profitTargetId}`,
  // Market-flatten variant of the above (2026-08-11 fix) - used instead of
  // stopHeal when price has already breached the intended stop level by the
  // time the heal check runs, so a passive stop order would be invalid
  // (Alpaca rejects a sell-stop priced above the current market).
  stopHealMarketSell: () => `opt-stophealsell-${Date.now()}-${profitTargetId}`
})

// Swing execution (2026-08-25) - keyed off swing_trade_alerts.id, distinct
// namespace prefix (`sw-`) from the 0DTE `opt-`/plain ids above so a stray
// collision between the two systems is structurally impossible, not just
// unlikely.
export const swingClientOrderIds = (alertId: string) => ({
  entry: `sw-entry-${alertId}`,
  exit: (attempt: number) => `sw-exit${attempt}-${alertId}`
})
