-- Every TIMESTAMP column (no time zone) was recorded as a UTC instant server-side,
-- but Postgres/PostgREST serializes it without a 'Z'/offset suffix. JS's Date parser
-- treats a timezone-less ISO string as LOCAL time, so every displayed time was
-- silently wrong (e.g. a 10:37 PM UTC event displayed as "10:37 PM" in whatever
-- timezone the viewer's browser is in, instead of converting to it).
-- Converting to TIMESTAMPTZ, reinterpreting the existing naive values as UTC
-- (which is what they always represented).

ALTER TABLE user_preferences
  ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at AT TIME ZONE 'UTC',
  ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at AT TIME ZONE 'UTC';

ALTER TABLE watchlists
  ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at AT TIME ZONE 'UTC';

ALTER TABLE day_trade_alerts
  ALTER COLUMN entry_time TYPE TIMESTAMPTZ USING entry_time AT TIME ZONE 'UTC',
  ALTER COLUMN timestamp TYPE TIMESTAMPTZ USING timestamp AT TIME ZONE 'UTC',
  ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at AT TIME ZONE 'UTC';

ALTER TABLE day_trade_alert_history
  ALTER COLUMN notified_at TYPE TIMESTAMPTZ USING notified_at AT TIME ZONE 'UTC',
  ALTER COLUMN dismissed_at TYPE TIMESTAMPTZ USING dismissed_at AT TIME ZONE 'UTC';

ALTER TABLE profit_targets
  ALTER COLUMN entry_time TYPE TIMESTAMPTZ USING entry_time AT TIME ZONE 'UTC',
  ALTER COLUMN target_hit_at TYPE TIMESTAMPTZ USING target_hit_at AT TIME ZONE 'UTC',
  ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at AT TIME ZONE 'UTC';

ALTER TABLE swing_trade_alerts
  ALTER COLUMN oversold_date TYPE TIMESTAMPTZ USING oversold_date AT TIME ZONE 'UTC',
  ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at AT TIME ZONE 'UTC';

ALTER TABLE price_candles
  ALTER COLUMN timestamp TYPE TIMESTAMPTZ USING timestamp AT TIME ZONE 'UTC',
  ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at AT TIME ZONE 'UTC';

ALTER TABLE indicator_snapshots
  ALTER COLUMN timestamp TYPE TIMESTAMPTZ USING timestamp AT TIME ZONE 'UTC',
  ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at AT TIME ZONE 'UTC';
