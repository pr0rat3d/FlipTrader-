-- Daily-loss circuit breaker (2026-07-24): pauses NEW entries for the rest
-- of the trading day once realized loss hits a configurable fraction of
-- the day's starting equity - the intentional, recoverable replacement for
-- the accidental equity-band lockout found/fixed 2026-07-17 (see project
-- memory). Built and backtest-wired 2026-07-18 (scripts/backtestRun.ts
-- --daily-loss-limit-pct, +$900-950 over a 90-day window at 15-20%) but
-- never shipped live until now.
--
-- Alpaca's own account.last_equity field (documented as "equity as of
-- previous trading day close") was checked empirically before relying on
-- it and came back 0 for this account - unusable, would have silently
-- disabled the breaker forever. Tracking our own starting-equity snapshot
-- instead: execute-alerts.ts records it once per trading day (its own
-- first successful run, at/after market open) and compares current equity
-- against that stored value on every subsequent run the same day.
CREATE TABLE daily_equity_snapshots (
  trading_date DATE PRIMARY KEY,
  starting_equity DECIMAL(12, 2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE daily_equity_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read daily equity snapshots" ON daily_equity_snapshots FOR SELECT USING (true);

-- NULL = disabled (matches min_account_equity/max_account_equity's existing
-- style of a plain settings column, not a separate feature-flag column).
ALTER TABLE execution_settings
  ADD COLUMN IF NOT EXISTS daily_loss_limit_pct DECIMAL(4, 3);

-- Shipped live at 15% - the backtest showed 15% and 20% landing on
-- virtually identical total P&L (both ~+$900-950 over 90 days) with fewer
-- circuit-breaker trips at 20% (1 of 62 days) vs 15% (2 of 62) - 15% chosen
-- as the more protective of two backtested-equivalent options.
UPDATE execution_settings SET daily_loss_limit_pct = 0.15 WHERE id = 1;
