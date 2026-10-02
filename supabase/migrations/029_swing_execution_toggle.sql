-- Kill switch for swing execution (2026-10-02). Until now execute-swings.ts
-- had no on/off control at all - the day-trade bot's is_enabled never
-- applied to it - so the only way to stop it was the whole database going
-- away. The 10-02 review found the live swing strategy losing ~80% of its
-- account, mostly to spread-triggered stops on wide single-stock option
-- markets the backtest never modeled, so this ships OFF and stays off until
-- a spread-aware backtest says otherwise. Gates NEW entries only - exit/stop
-- management for already-open positions keeps running, same contract as
-- is_enabled on the day-trade side.
ALTER TABLE execution_settings ADD COLUMN swing_enabled BOOLEAN NOT NULL DEFAULT false;
