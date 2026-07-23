-- DIV trend-day gate (2026-07-23): ADX measures trend STRENGTH regardless
-- of direction, distinct from the daily EMA50/200 trend direction check
-- already feeding the confidence modifier. Found live 2026-07-23: 10
-- straight bullish DIV entries fired into a real gap-down-and-continue
-- morning (SPY ADX 48.7-50.6, -DI dominating +DI at the time) and all 10
-- stopped out - DIV's reversal thesis (histogram deceleration) reads
-- identically whether it's a real turn or a shallow pause inside a strong
-- trend. Computed and stored at alert-creation time in scan-confluence.ts
-- so execute-alerts.ts's entry gate can read it without recomputing.
ALTER TABLE day_trade_alerts
  ADD COLUMN IF NOT EXISTS adx DECIMAL(6, 2);
