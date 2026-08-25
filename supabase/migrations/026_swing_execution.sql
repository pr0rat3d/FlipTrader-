-- Backing schema for real swing execution (CALL/oversold signals only, per
-- user decision 2026-08-25 after backtesting showed PUT/overbought signals
-- net-losing under the same exit spec - +11.7% avg premium move for CALLs
-- vs -3.1% for PUTs over a 2-year/1,108-trade sample, see
-- scripts/swingBacktestRun.ts). scan-swings.ts stays alert-detection-only;
-- api/cron/execute-swings.ts (new) claims entry_attempted=false CALL
-- alerts and places real orders against the separate 'swing' Alpaca
-- account (server/execution/alpacaClient.ts's AlpacaAccountKey) -
-- mirrors the existing day-trading split (scan-confluence.ts detects,
-- execute-alerts.ts trades) rather than a new architecture style.

-- entry_attempted gates real execution to exactly ONE attempt per oversold
-- EPISODE (the same "!existing" transition scan-swings.ts already uses to
-- gate push notifications) - a symbol re-checked every ~15min while still
-- oversold must not re-enter a new position each time. Set false only on
-- a genuinely NEW occurrence (existing row's own value preserved
-- otherwise), true after execute-swings.ts attempts an entry (success or
-- failure - not infinitely retried, same one-shot-per-signal treatment
-- day-trading's own entry gates already give a leg).
ALTER TABLE swing_trade_alerts ADD COLUMN entry_attempted BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE swing_positions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  underlying_symbol TEXT NOT NULL,
  option_symbol TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('bullish', 'bearish')),
  contracts INTEGER NOT NULL,
  premium_entry NUMERIC NOT NULL,
  strike_price NUMERIC NOT NULL,
  expiration_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'entry_submitted',
  entry_order_id TEXT,
  exit_order_id TEXT,
  exit_price NUMERIC,
  claimed_at TIMESTAMP NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMP,
  needs_manual_review BOOLEAN NOT NULL DEFAULT false,
  review_reason TEXT
);
ALTER TABLE swing_positions ENABLE ROW LEVEL SECURITY;
-- No public SELECT policy yet - bot-internal only for this first version,
-- same as option_positions (day-trading's live position tab reads
-- swing_trade_alerts for display, not option_positions directly either).
