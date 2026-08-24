-- Backing state for a periodic (roughly monthly) job that ranks the whole
-- US common-stock market by market cap and refreshes sector_universe with
-- the real top 100 - see api/cron/rank-market-cap.ts and
-- server/marketCapRanking.ts. Finnhub's free tier has no market-cap
-- screener (confirmed 2026-08-24), so this has to check ~8000 candidates
-- one at a time at Finnhub's 60/min rate limit and Vercel's 60s function
-- duration limit - both mean this spans many invocations, not one shot.
-- market_cap_candidates persists progress across those invocations so a
-- symbol never gets re-checked mid-cycle and the job can resume cleanly if
-- an invocation is missed.
CREATE TABLE market_cap_candidates (
  symbol TEXT PRIMARY KEY,
  market_cap NUMERIC,
  industry TEXT,
  checked_at TIMESTAMP
);
ALTER TABLE market_cap_candidates ENABLE ROW LEVEL SECURITY;
-- No SELECT policy - bot-internal working state only, service-role key
-- (used by every cron in this app) bypasses RLS entirely; nothing in the
-- frontend reads this table directly.

-- Single-row status tracker - avoids inferring "mid-cycle vs. just-finished
-- vs. not-due-yet" purely from candidate-table state, which is ambiguous
-- (an empty table could mean "never started" or "about to reset for the
-- next cycle").
CREATE TABLE market_cap_ranking_status (
  id INTEGER PRIMARY KEY DEFAULT 1,
  phase TEXT NOT NULL DEFAULT 'idle' CHECK (phase IN ('idle', 'fetching_symbols', 'ranking', 'finalizing')),
  last_completed_at TIMESTAMP,
  CONSTRAINT market_cap_ranking_status_single_row CHECK (id = 1)
);
ALTER TABLE market_cap_ranking_status ENABLE ROW LEVEL SECURITY;
INSERT INTO market_cap_ranking_status (id, phase) VALUES (1, 'idle');
