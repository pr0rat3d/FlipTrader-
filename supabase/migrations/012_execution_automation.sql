-- Automated paper-trading execution: a kill-switch-gated settings row plus a
-- per-leg execution ledger, atomically claimed via UNIQUE + ON CONFLICT DO
-- NOTHING (not a status column on profit_targets, which already has its own
-- status concern consumed by track-profit-targets.ts).

CREATE TABLE execution_settings (
  id INT PRIMARY KEY CHECK (id = 1),
  is_enabled BOOLEAN NOT NULL DEFAULT false,
  -- Same 0-1 scale as day_trade_alerts.confidence (e.g. TTF fires at 0.95,
  -- the existing push-notification threshold elsewhere is 0.6) - NOT 0-100.
  min_confidence DECIMAL(4,3) NOT NULL DEFAULT 0.70,
  risk_pct DECIMAL(5,4) NOT NULL DEFAULT 0.01,
  min_qty INT NOT NULL DEFAULT 2,
  max_qty INT NOT NULL DEFAULT 10,
  min_account_equity DECIMAL(12,2) NOT NULL DEFAULT 500,
  max_account_equity DECIMAL(12,2) NOT NULL DEFAULT 5000,
  hard_stop_pct DECIMAL(5,4) NOT NULL DEFAULT 0.30,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO execution_settings (id) VALUES (1);

ALTER TABLE execution_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read execution settings" ON execution_settings
  FOR SELECT USING (true);

CREATE POLICY "Authenticated can update execution settings" ON execution_settings
  FOR UPDATE TO authenticated USING (true);

CREATE TABLE trade_executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profit_target_id UUID NOT NULL UNIQUE REFERENCES profit_targets(id),
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('bullish', 'bearish')),
  execution_status TEXT NOT NULL DEFAULT 'claimed' CHECK (execution_status IN (
    'claimed', 'entry_submitted', 'entry_filled',
    'protective_orders_placed', 'protective_orders_partial',
    'closed_target', 'closed_stop', 'closed_hard_stop',
    'closed_manual', 'entry_failed', 'skipped_bad_data',
    'skipped_stale', 'skipped_session_closed', 'needs_manual_review'
  )),
  qty INT,
  remaining_qty INT,
  account_equity_at_entry DECIMAL(12,2),
  entry_order_id TEXT,
  entry_client_order_id TEXT,
  stop_order_id TEXT,
  stop_client_order_id TEXT,
  tier1_order_id TEXT,
  tier2_order_id TEXT,
  tier3_order_id TEXT,
  needs_manual_review BOOLEAN NOT NULL DEFAULT false,
  review_reason TEXT,
  reconciliation_attempts INT NOT NULL DEFAULT 0,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX trade_executions_status_idx ON trade_executions (execution_status);

ALTER TABLE trade_executions ENABLE ROW LEVEL SECURITY;

-- Read-only for clients (audit/history view) - all writes are service-role only,
-- matching how profit_targets writes already work.
CREATE POLICY "Anyone can read trade executions" ON trade_executions
  FOR SELECT USING (true);
