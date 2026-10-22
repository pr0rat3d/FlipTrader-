-- Cron heartbeats (2026-10-22). Twice now the bot died silently for weeks:
-- Supabase paused, every cron call failed, cron-job.org auto-disabled the
-- jobs after repeated failures, and unpausing Supabase alone didn't bring
-- them back - with no traffic it just re-paused a week later. Nothing
-- noticed because the only signal was "no trades", which also happens on
-- quiet days.
--
-- Every cron endpoint upserts its own row here right after auth (see
-- server/cronHeartbeat.ts), so a single job being disabled is visible, not
-- just the scanner. cron_health() is the read side, polled by
-- .github/workflows/heartbeat.yml from outside Vercel/cron-job.org - it's
-- SECURITY DEFINER + granted to anon so the workflow only needs the public
-- publishable key, and it returns nothing
-- but job names and ages.
CREATE TABLE cron_heartbeats (
  job TEXT PRIMARY KEY,
  last_run_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE cron_heartbeats ENABLE ROW LEVEL SECURITY;

-- Jobs the day-trade bot can't work without. Checked only during market
-- hours (+10 min grace after the open): their cron-job.org schedules are
-- 1-5 min, so 15 min without a run means the job is off, not just slow.
-- Holidays don't false-alarm - the jobs still get called (and record a
-- heartbeat) before any market-hours early return.
CREATE OR REPLACE FUNCTION cron_health()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  required TEXT[] := ARRAY[
    'scan-day-trades', 'scan-confluence', 'execute-alerts',
    'monitor-executions', 'track-profit-targets'
  ];
  ny TIMESTAMP := now() AT TIME ZONE 'America/New_York';
  market_open BOOLEAN := EXTRACT(ISODOW FROM ny) BETWEEN 1 AND 5
    AND ny::TIME >= TIME '09:40' AND ny::TIME < TIME '16:00';
  jobs JSON;
  stale TEXT[];
BEGIN
  SELECT COALESCE(json_agg(json_build_object(
           'job', r.job,
           'age_min', ROUND(EXTRACT(EPOCH FROM now() - h.last_run_at) / 60)
         ) ORDER BY r.job), '[]'::JSON),
         ARRAY_AGG(r.job ORDER BY r.job) FILTER (
           WHERE h.last_run_at IS NULL OR h.last_run_at < now() - INTERVAL '15 minutes'
         )
    INTO jobs, stale
    FROM unnest(required) AS r(job)
    LEFT JOIN cron_heartbeats h ON h.job = r.job;

  RETURN json_build_object(
    'ok', NOT market_open OR COALESCE(array_length(stale, 1), 0) = 0,
    'market_open', market_open,
    'stale', COALESCE(stale, ARRAY[]::TEXT[]),
    'jobs', jobs
  );
END;
$$;

REVOKE ALL ON FUNCTION cron_health() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cron_health() TO anon;
