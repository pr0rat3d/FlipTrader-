-- Live-adjustable, same pattern as min_confidence/max_qty/risk_pct - a hard
-- cap on total option positions opened per NY trading day, independent of
-- contract count per entry (e.g. 2 contracts on an IV attempt + 4 on one ORB
-- breakout + 2 on another ORB breakout = 3 entries, done for the day).
ALTER TABLE execution_settings ADD COLUMN max_daily_entries INT NOT NULL DEFAULT 3;
