-- swing_trade_alerts previously got a new row every single cron run (every 15 min)
-- for as long as a symbol stayed oversold, producing dozens of duplicate cards for
-- the same ongoing condition. Moving to one row per symbol, upserted in place.

-- Dedupe existing rows first - keep only the most recent per symbol
DELETE FROM swing_trade_alerts a USING swing_trade_alerts b
  WHERE a.symbol = b.symbol AND a.oversold_date < b.oversold_date;

ALTER TABLE swing_trade_alerts ADD CONSTRAINT swing_trade_alerts_symbol_unique UNIQUE (symbol);
