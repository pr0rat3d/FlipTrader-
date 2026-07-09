ALTER TABLE profit_targets
  ADD COLUMN milestone_10_price DECIMAL(10, 2),
  ADD COLUMN milestone_10_hit_at TIMESTAMPTZ,
  ADD COLUMN milestone_20_price DECIMAL(10, 2),
  ADD COLUMN milestone_20_hit_at TIMESTAMPTZ,
  ADD COLUMN milestone_30_price DECIMAL(10, 2),
  ADD COLUMN milestone_30_hit_at TIMESTAMPTZ,
  ADD COLUMN max_favorable_price DECIMAL(10, 2),
  ADD COLUMN max_favorable_pct DECIMAL(6, 2),
  ADD COLUMN max_favorable_at TIMESTAMPTZ,
  ADD COLUMN status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'target_hit', 'expired'));

-- Backfill status for any pre-existing rows (none expected yet, but safe either way)
UPDATE profit_targets SET status = 'target_hit' WHERE target_hit_at IS NOT NULL;

-- profit_targets moves from "1 row per alert" to "1 row per triggered symbol per alert" -
-- safe since no unique constraint on day_trade_alert_id exists today and no frontend
-- code currently consumes this table.
ALTER TABLE profit_targets ADD CONSTRAINT profit_targets_alert_symbol_unique UNIQUE (day_trade_alert_id, symbol);

-- Was missing entirely - the frontend's anon key could not read this table until now
CREATE POLICY "Anyone can read profit targets" ON profit_targets FOR SELECT USING (true);

-- Cheap fidelity win for best-entry/max-favorable-excursion analysis: the full OHLC
-- candle is already fetched into memory every cron run, high/low were just discarded.
ALTER TABLE indicator_snapshots ADD COLUMN high_price DECIMAL(12, 4), ADD COLUMN low_price DECIMAL(12, 4);
