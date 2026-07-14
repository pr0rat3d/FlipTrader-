-- EMA9 for the Indicators charts - a faster-reacting trend line than EMA50/EMA200,
-- meant to cut through noise on both the day-trade and swing charts.
ALTER TABLE indicator_snapshots ADD COLUMN ema_9 DECIMAL(12, 4);
