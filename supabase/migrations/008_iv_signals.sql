-- IV (Intraday Reversal) is a new earlier momentum-only signal (MACD curl +
-- support/resistance confluence, no RSI divergence required) alongside the
-- existing TTF/DTF/STF full-confluence signal. ttf_status is an unconstrained
-- TEXT column already, so it just gains 'IV' as an additional value - every
-- existing consumer (AlertCard, Performance tier stats, Dashboard) picks it up
-- automatically rather than needing a parallel field threaded everywhere.
ALTER TABLE day_trade_alerts
  ALTER COLUMN rsi_divergence DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS confluence_type TEXT,
  ADD COLUMN IF NOT EXISTS confluence_level DECIMAL(10, 2),
  ADD COLUMN IF NOT EXISTS confidence DECIMAL(4, 2),
  ADD COLUMN IF NOT EXISTS pdh DECIMAL(10, 2),
  ADD COLUMN IF NOT EXISTS pdl DECIMAL(10, 2),
  ADD COLUMN IF NOT EXISTS pdc DECIMAL(10, 2),
  ADD COLUMN IF NOT EXISTS orh DECIMAL(10, 2),
  ADD COLUMN IF NOT EXISTS orl DECIMAL(10, 2),
  ADD COLUMN IF NOT EXISTS gap_up BOOLEAN,
  ADD COLUMN IF NOT EXISTS gap_down BOOLEAN;

-- PDH/PDL/PDC only change once a day - cached here so IV detection doesn't
-- need a fresh daily-candle API call every 5-minute run, only once per symbol
-- per trading day.
CREATE TABLE daily_levels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol TEXT NOT NULL,
  trading_date DATE NOT NULL,
  pdh DECIMAL(10, 2) NOT NULL,
  pdl DECIMAL(10, 2) NOT NULL,
  pdc DECIMAL(10, 2) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(symbol, trading_date)
);
ALTER TABLE daily_levels ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read daily levels" ON daily_levels FOR SELECT USING (true);
