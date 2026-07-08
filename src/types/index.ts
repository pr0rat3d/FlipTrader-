export interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: number;
}

export interface Alert {
  id: string;
  symbol: string;
  ttf_status: 'TTF' | 'DTF' | 'STF';
  rsi_divergence: 'bullish' | 'bearish';
  macd_curl: 'bullish' | 'bearish';
  indices_triggered: string[];
  entry_price: number;
  entry_time: string;
  target_50ema: number;
  top_bottom_pattern?: string;
  timestamp: string;
  created_at: string;
}

export interface ProfitTarget {
  id: string;
  day_trade_alert_id: string;
  symbol: string;
  entry_price: number;
  entry_time: string;
  target_50ema_price: number;
  target_hit_at?: string;
  created_at: string;
}

export interface SwingAlert {
  id: string;
  symbol: string;
  rsi_value: number;
  sector: string;
  oversold_date: string;
  created_at: string;
}

export interface UserPreferences {
  id: string;
  user_id: string;
  notification_type: 'push' | 'sms' | 'both';
  fcm_token?: string;
  sector_filters: string[];
  created_at: string;
}

export interface TechnicalIndicators {
  rsi: number[];
  macd: { line: number[]; signal: number[]; histogram: number[] };
}

export interface IndicatorSnapshot {
  id: string;
  symbol: string;
  category: 'day_trade' | 'swing';
  close_price: number;
  rsi: number | null;
  macd_line: number | null;
  macd_signal: number | null;
  macd_histogram: number | null;
  ema_50: number | null;
  ema_200: number | null;
  vwap: number | null;
  timestamp: string;
  created_at: string;
}

export interface Watchlist {
  id: string;
  user_id: string;
  symbol: string;
  type: 'day_trade' | 'swing';
  created_at: string;
}

export interface SectorUniverseRow {
  symbol: string;
  sector: string;
}
