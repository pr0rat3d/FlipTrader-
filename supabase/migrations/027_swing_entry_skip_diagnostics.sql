-- Diagnostic gap found 2026-09-03: after loosening scan-swings.ts's
-- oversold RSI threshold (30->35, see api/cron/scan-swings.ts), 5 real
-- CALL alerts fired the same day but zero orders ever reached the swing
-- Alpaca account - execute-swings.ts marks entry_attempted=true on every
-- claim (success OR skip, see migration 026's comment), but a pre-flight
-- skip (stale/incomplete pricing/no affordable strike/sizing rejection)
-- left NO trace anywhere queryable - the skip reason only ever existed in
-- that one cron invocation's transient JSON response. Root-causing the 5
-- silent misses required a manual script replaying execute-swings.ts's
-- entire entry-decision logic by hand. These two columns close that gap.
ALTER TABLE swing_trade_alerts ADD COLUMN entry_attempted_at TIMESTAMP;
ALTER TABLE swing_trade_alerts ADD COLUMN entry_skip_reason TEXT;
