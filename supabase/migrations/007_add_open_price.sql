-- Needed to render real candlesticks/Heikin-Ashi (a candle body needs open, not just
-- close) - the day-trade cron already fetches this in-memory every run, just discarded.
ALTER TABLE indicator_snapshots ADD COLUMN open_price DECIMAL(12, 4);
