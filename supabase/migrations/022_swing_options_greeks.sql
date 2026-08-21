-- Extends the existing RSI-only swing_trade_alerts feature with options
-- Greeks + IV rank + a put/overbought side, computed in-house (see
-- server/optionsGreeks.ts, server/swingOptionSelection.ts) off real Alpaca
-- options quotes - all nullable so existing oversold-only rows, and any
-- symbol still in IV-rank cold start, keep working unchanged.
ALTER TABLE swing_trade_alerts
  ADD COLUMN signal_type TEXT NOT NULL DEFAULT 'CALL' CHECK (signal_type IN ('CALL', 'PUT')),
  ADD COLUMN option_symbol TEXT,
  ADD COLUMN expiration_date DATE,
  ADD COLUMN recommended_strike DECIMAL(10, 2),
  ADD COLUMN delta DECIMAL(5, 3),
  ADD COLUMN gamma DECIMAL(6, 4),
  ADD COLUMN theta DECIMAL(6, 3),
  ADD COLUMN vega DECIMAL(6, 3),
  ADD COLUMN iv_current DECIMAL(6, 4),
  ADD COLUMN iv_rank DECIMAL(5, 2),
  ADD COLUMN entry_rationale TEXT;

-- Daily implied-vol reading per symbol, accumulated via the existing
-- one-row-per-symbol-per-day 'swing' category convention in
-- indicator_snapshots (server/snapshot.ts) - this history is what
-- computeIvRank (server/swingOptionSelection.ts) percentile-ranks against.
-- Nullable/only populated once a real quote-derived IV was computed for
-- that symbol that day.
ALTER TABLE indicator_snapshots ADD COLUMN implied_vol DECIMAL(6, 4);
