-- Options execution replaces the share-based trade_executions model entirely -
-- the user clarified the bot should trade options contracts (calls/puts) on
-- SPY/QQQ/IWM, not shares of the underlying. trade_executions/profit_targets'
-- fixed 3-tier design doesn't fit anyway: contract counts are small (2-5) and
-- variable, so the number of scale-out tiers varies per position (1-4 tiers +
-- a runner), unlike shares' fixed 30/30/30/10 split. trade_executions had zero
-- real rows ever (confirmed empirically before this migration), so there's no
-- historical data this displaces.

CREATE TABLE option_positions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Same atomic-claim-per-leg safety property the old trade_executions had -
  -- a UNIQUE FK means two overlapping cron invocations can't both claim the
  -- same signal leg.
  profit_target_id UUID NOT NULL UNIQUE REFERENCES profit_targets(id),
  underlying_symbol TEXT NOT NULL,
  option_symbol TEXT,
  contract_type TEXT CHECK (contract_type IN ('call', 'put')),
  strike_price DECIMAL(12,2),
  expiration_date DATE,
  direction TEXT NOT NULL CHECK (direction IN ('bullish', 'bearish')),
  contracts INT,
  remaining_contracts INT,
  premium_entry DECIMAL(12,4),
  entry_order_id TEXT,
  -- Current stop threshold as a fraction of premium_entry - starts at
  -- execution_settings.hard_stop_pct (0.30), ratchets to 0 (breakeven) the
  -- moment the first tier fills.
  stop_pct DECIMAL(6,4),
  status TEXT NOT NULL DEFAULT 'claimed' CHECK (status IN (
    'claimed', 'entry_submitted', 'open',
    'closed_target', 'closed_stop', 'closed_hard_stop',
    'closed_time_lock', 'closed_force_close', 'closed_manual',
    'entry_failed', 'skipped_bad_data', 'needs_manual_review'
  )),
  needs_manual_review BOOLEAN NOT NULL DEFAULT false,
  review_reason TEXT,
  account_equity_at_entry DECIMAL(12,2),
  reconciliation_attempts INT NOT NULL DEFAULT 0,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX option_positions_status_idx ON option_positions (status);

-- One row per scale-out tier for a position, including the runner
-- (tier_number 99, is_runner true) - a variable-length list rather than
-- fixed tier1/tier2/tier3 columns, since tier count depends on contracts
-- (2 contracts -> 1 fixed tier + runner, 5 contracts -> 4 fixed tiers + runner).
CREATE TABLE option_position_tiers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  option_position_id UUID NOT NULL REFERENCES option_positions(id),
  tier_number INT NOT NULL,
  is_runner BOOLEAN NOT NULL DEFAULT false,
  target_pct DECIMAL(6,4) NOT NULL,
  order_id TEXT,
  filled_at TIMESTAMPTZ,
  fill_price DECIMAL(12,4),
  UNIQUE(option_position_id, tier_number)
);

ALTER TABLE option_positions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read option positions" ON option_positions FOR SELECT USING (true);

ALTER TABLE option_position_tiers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read option position tiers" ON option_position_tiers FOR SELECT USING (true);
