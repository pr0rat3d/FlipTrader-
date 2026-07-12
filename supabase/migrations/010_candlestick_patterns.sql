ALTER TABLE indicator_snapshots
  ADD COLUMN IF NOT EXISTS candlestick_pattern TEXT,
  ADD COLUMN IF NOT EXISTS candlestick_direction TEXT;
