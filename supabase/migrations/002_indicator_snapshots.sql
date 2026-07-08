-- Indicator snapshots: recorded on every cron run regardless of whether
-- an alert condition is met, so trend-toward-trigger can be charted over time.
CREATE TABLE indicator_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol TEXT NOT NULL,
  category TEXT NOT NULL, -- 'day_trade' | 'swing'
  close_price DECIMAL(12, 4),
  rsi DECIMAL(6, 2),
  macd_line DECIMAL(12, 6),
  macd_signal DECIMAL(12, 6),
  macd_histogram DECIMAL(12, 6),
  ema_50 DECIMAL(12, 4),
  ema_200 DECIMAL(12, 4),
  timestamp TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW()
);
ALTER TABLE indicator_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read indicator snapshots" ON indicator_snapshots FOR SELECT USING (true);

CREATE INDEX idx_indicator_snapshots_symbol_timestamp ON indicator_snapshots (symbol, timestamp DESC);

ALTER PUBLICATION supabase_realtime ADD TABLE indicator_snapshots;
