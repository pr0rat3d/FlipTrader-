-- Users table
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can read own data" ON users FOR SELECT USING (auth.uid() = id);

-- User preferences
CREATE TABLE user_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  notification_type TEXT DEFAULT 'push',
  fcm_token TEXT,
  sector_filters JSONB DEFAULT '["tech", "healthcare", "energy"]'::jsonb,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id)
);
ALTER TABLE user_preferences ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can read own preferences" ON user_preferences FOR SELECT USING (user_id = auth.uid());

-- Watchlists
CREATE TABLE watchlists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  type TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, symbol, type)
);
ALTER TABLE watchlists ENABLE ROW LEVEL SECURITY;

-- Day trade alerts
CREATE TABLE day_trade_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol TEXT NOT NULL,
  ttf_status TEXT NOT NULL,
  rsi_divergence TEXT NOT NULL,
  macd_curl TEXT NOT NULL,
  indices_triggered TEXT[] NOT NULL,
  entry_price DECIMAL(10, 2),
  entry_time TIMESTAMP,
  target_50ema DECIMAL(10, 2),
  top_bottom_pattern TEXT,
  timestamp TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW()
);
ALTER TABLE day_trade_alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read alerts" ON day_trade_alerts FOR SELECT USING (true);

-- Day trade alert history
CREATE TABLE day_trade_alert_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  alert_id UUID REFERENCES day_trade_alerts(id) ON DELETE CASCADE,
  notified_at TIMESTAMP DEFAULT NOW(),
  dismissed_at TIMESTAMP
);
ALTER TABLE day_trade_alert_history ENABLE ROW LEVEL SECURITY;

-- Profit targets
CREATE TABLE profit_targets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  day_trade_alert_id UUID REFERENCES day_trade_alerts(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  entry_price DECIMAL(10, 2),
  entry_time TIMESTAMP,
  target_50ema_price DECIMAL(10, 2),
  target_hit_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);
ALTER TABLE profit_targets ENABLE ROW LEVEL SECURITY;

-- Swing trade alerts
CREATE TABLE swing_trade_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol TEXT NOT NULL,
  rsi_value DECIMAL(5, 2),
  sector TEXT,
  oversold_date TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);
ALTER TABLE swing_trade_alerts ENABLE ROW LEVEL SECURITY;

-- Price candles
CREATE TABLE price_candles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  open DECIMAL(10, 2),
  high DECIMAL(10, 2),
  low DECIMAL(10, 2),
  close DECIMAL(10, 2),
  volume BIGINT,
  timestamp TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(symbol, timeframe, timestamp)
);
ALTER TABLE price_candles ENABLE ROW LEVEL SECURITY;

-- Enable realtime
ALTER PUBLICATION supabase_realtime ADD TABLE day_trade_alerts;
ALTER PUBLICATION supabase_realtime ADD TABLE swing_trade_alerts;
ALTER PUBLICATION supabase_realtime ADD TABLE profit_targets;
