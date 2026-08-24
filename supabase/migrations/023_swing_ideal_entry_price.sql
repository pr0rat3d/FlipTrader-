-- Adds a realistic "best price possible" limit-entry recommendation to
-- swing_trade_alerts, on top of the strike/Greeks already added in 022 -
-- see server/swingOptionSelection.ts's computeIdealEntryPrice/
-- classifyLiquidity for the math (bid-to-mid blend driven by a worst-of
-- open-interest/spread-width liquidity tier). bid_price/ask_price are the
-- real quote the entry was derived from, open_interest/liquidity_tier are
-- the inputs, kept alongside for transparency on the card.
ALTER TABLE swing_trade_alerts
  ADD COLUMN bid_price NUMERIC,
  ADD COLUMN ask_price NUMERIC,
  ADD COLUMN ideal_entry_price NUMERIC,
  ADD COLUMN open_interest INTEGER,
  ADD COLUMN liquidity_tier TEXT CHECK (liquidity_tier IN ('tight', 'moderate', 'wide'));
