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
  stopReplace: (attempt: number) => `opt-stopreplace${attempt}-${profitTargetId}`
})
