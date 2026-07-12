-- ATR (volatility) and volume, needed for a stop-loss suggestion and RVOL
-- (relative volume) respectively - both derivable from data already fetched.
ALTER TABLE indicator_snapshots
  ADD COLUMN IF NOT EXISTS atr DECIMAL(12, 4),
  ADD COLUMN IF NOT EXISTS volume BIGINT;

-- Stop-loss = entry ∓ 1.5x ATR, stored per-symbol like entry/target already are.
ALTER TABLE day_trade_alerts ADD COLUMN IF NOT EXISTS stop_loss_price DECIMAL(10, 2);
ALTER TABLE profit_targets ADD COLUMN IF NOT EXISTS stop_loss_price DECIMAL(10, 2);

-- RVOL baseline - 20-day average daily volume, cached alongside PDH/PDL/PDC
-- since it comes from the same getDailyCandles call.
ALTER TABLE daily_levels ADD COLUMN IF NOT EXISTS avg_volume_20d BIGINT;
