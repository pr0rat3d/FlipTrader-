-- Real stop-hit detection. profit_targets.status previously only ever
-- transitioned to 'target_hit' or 'expired', so a leg that actually got
-- stopped out mid-session looked identical (still 'open') to a perfectly
-- fine one, right up until end-of-session lumped it in with 'expired'. This
-- fed a real Dashboard bug: an alert-consolidation "continuation" streak
-- kept citing an original entry/stop as still valid even after price had
-- already blown through it.
DO $$
DECLARE
  existing_constraint text;
BEGIN
  SELECT con.conname INTO existing_constraint
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  WHERE rel.relname = 'profit_targets' AND con.contype = 'c' AND pg_get_constraintdef(con.oid) LIKE '%status%';

  IF existing_constraint IS NOT NULL THEN
    EXECUTE format('ALTER TABLE profit_targets DROP CONSTRAINT %I', existing_constraint);
  END IF;
END $$;

ALTER TABLE profit_targets ADD CONSTRAINT profit_targets_status_check
  CHECK (status IN ('open', 'target_hit', 'expired', 'stopped_out'));

ALTER TABLE profit_targets ADD COLUMN stopped_out_at TIMESTAMPTZ;
