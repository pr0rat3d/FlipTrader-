-- Broker-side stop orders (2026-07-16): the hard stop/breakeven protection
-- moves from a bot-polled market-sell check to a real resting stop order
-- placed with Alpaca at entry time, so protection runs on the broker's own
-- matching engine instead of depending on the next cron poll noticing in
-- time. stop_order_id tracks which resting order is currently protecting
-- a position, so monitor-executions.ts knows what to check/cancel/replace.
ALTER TABLE option_positions ADD COLUMN stop_order_id TEXT;
