-- Repoint FKs from the vestigial public.users table to Supabase's real auth.users,
-- then drop public.users (nothing has ever populated it - no signup trigger exists).
ALTER TABLE day_trade_alert_history DROP CONSTRAINT day_trade_alert_history_user_id_fkey;
ALTER TABLE day_trade_alert_history
  ADD CONSTRAINT day_trade_alert_history_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE user_preferences DROP CONSTRAINT user_preferences_user_id_fkey;
ALTER TABLE user_preferences
  ADD CONSTRAINT user_preferences_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE watchlists DROP CONSTRAINT watchlists_user_id_fkey;
ALTER TABLE watchlists
  ADD CONSTRAINT watchlists_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

DROP TABLE public.users;

-- Missing RLS policies: user_preferences only had SELECT, so saving would fail
CREATE POLICY "Users can insert own preferences" ON user_preferences
  FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY "Users can update own preferences" ON user_preferences
  FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- watchlists had RLS enabled with zero policies - fully inaccessible until now
CREATE POLICY "Users can read own watchlist" ON watchlists
  FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "Users can insert own watchlist rows" ON watchlists
  FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY "Users can delete own watchlist rows" ON watchlists
  FOR DELETE USING (user_id = auth.uid());

ALTER TABLE watchlists ADD CONSTRAINT watchlists_type_check CHECK (type IN ('day_trade', 'swing'));

-- swing_trade_alerts had RLS enabled with zero policies - never readable by the frontend
CREATE POLICY "Anyone can read swing alerts" ON swing_trade_alerts FOR SELECT USING (true);

-- Sector universe: public reference data driving the expanded swing scan
CREATE TABLE sector_universe (
  symbol TEXT PRIMARY KEY,
  sector TEXT NOT NULL
);
ALTER TABLE sector_universe ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read sector universe" ON sector_universe FOR SELECT USING (true);

INSERT INTO sector_universe (symbol, sector) VALUES
  ('AAPL', 'tech'), ('MSFT', 'tech'), ('GOOGL', 'tech'), ('NVDA', 'tech'), ('ORCL', 'tech'),
  ('JNJ', 'healthcare'), ('UNH', 'healthcare'), ('PFE', 'healthcare'), ('ABBV', 'healthcare'), ('MRK', 'healthcare'),
  ('XOM', 'energy'), ('CVX', 'energy'), ('COP', 'energy'), ('SLB', 'energy'), ('EOG', 'energy'),
  ('JPM', 'financials'), ('BAC', 'financials'), ('WFC', 'financials'), ('GS', 'financials'), ('MS', 'financials'),
  ('AMZN', 'consumer'), ('TSLA', 'consumer'), ('HD', 'consumer'), ('NKE', 'consumer'), ('MCD', 'consumer'),
  ('BA', 'industrials'), ('CAT', 'industrials'), ('HON', 'industrials'), ('GE', 'industrials'), ('UPS', 'industrials'),
  ('LIN', 'materials'), ('SHW', 'materials'), ('APD', 'materials'), ('ECL', 'materials'), ('NEM', 'materials'),
  ('NEE', 'utilities'), ('DUK', 'utilities'), ('SO', 'utilities'), ('D', 'utilities'), ('AEP', 'utilities'),
  ('PLD', 'real_estate'), ('AMT', 'real_estate'), ('EQIX', 'real_estate'), ('SPG', 'real_estate'), ('O', 'real_estate'),
  ('META', 'communications'), ('NFLX', 'communications'), ('DIS', 'communications'), ('VZ', 'communications'), ('T', 'communications');

-- VWAP: nullable, only populated for day-trade (intraday) symbols
ALTER TABLE indicator_snapshots ADD COLUMN vwap DECIMAL(12, 4);
