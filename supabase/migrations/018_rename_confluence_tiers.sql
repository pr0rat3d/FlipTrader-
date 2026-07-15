-- Renaming the full-confluence tier codes for clarity: TTF/DTF/STF ->
-- TTTF/DTTF/STTF (Triple/Double/Single-index Triple Time Frame). ttf_status
-- is an unconstrained TEXT column (see 008_iv_signals.sql), so this is a pure
-- data backfill - without it, today's already-recorded TTF/DTF/STF rows would
-- silently stop matching the Performance page's tier grouping the moment the
-- app code switches to writing/reading the new codes.
UPDATE day_trade_alerts SET ttf_status = 'TTTF' WHERE ttf_status = 'TTF';
UPDATE day_trade_alerts SET ttf_status = 'DTTF' WHERE ttf_status = 'DTF';
UPDATE day_trade_alerts SET ttf_status = 'STTF' WHERE ttf_status = 'STF';
