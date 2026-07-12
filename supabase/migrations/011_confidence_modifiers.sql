-- Daily-timeframe EMA50/200, cached alongside PDH/PDL/PDC/avg volume since they
-- come from the same getDailyCandles call - used to check whether a day-trade
-- signal agrees with the higher-timeframe trend before scoring its confidence.
ALTER TABLE daily_levels
  ADD COLUMN IF NOT EXISTS daily_ema_50 DECIMAL(12, 4),
  ADD COLUMN IF NOT EXISTS daily_ema_200 DECIMAL(12, 4);
