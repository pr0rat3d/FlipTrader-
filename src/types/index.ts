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
  // 'IV' is the earlier momentum-only signal (MACD curl + support/resistance
  // confluence, no RSI divergence) - fires before TTF/DTF/STF's full confirmation.
  ttf_status: 'TTF' | 'DTF' | 'STF' | 'IV';
  rsi_divergence: 'bullish' | 'bearish' | null; // null for IV alerts
  macd_curl: 'bullish' | 'bearish';
  indices_triggered: string[];
  entry_price: number;
  entry_time: string;
  target_50ema: number;
  // IV-specific fields
  confluence_type?: 'pdh_rejection' | 'pdl_bounce' | 'or_rejection' | 'gap_fill_target' | null;
  confluence_level?: number | null;
  confidence?: number | null;
  // Support/resistance levels - populated whenever available, not IV-exclusive
  pdh?: number | null;
  pdl?: number | null;
  pdc?: number | null;
  orh?: number | null;
  orl?: number | null;
  gap_up?: boolean | null;
  gap_down?: boolean | null;
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
  milestone_10_price: number | null;
  milestone_10_hit_at: string | null;
  milestone_20_price: number | null;
  milestone_20_hit_at: string | null;
  milestone_30_price: number | null;
  milestone_30_hit_at: string | null;
  max_favorable_price: number | null;
  max_favorable_pct: number | null;
  max_favorable_at: string | null;
  status: 'open' | 'target_hit' | 'expired';
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
  open_price: number | null;
  high_price: number | null;
  low_price: number | null;
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
