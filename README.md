# FlipTrader

Real-time day trading and swing trading alert app with TTTF/DTTF/STTF signal tiering.

## Features

- **Day Trading Alerts**: SPY/QQQ/IWM reversal detection via RSI divergence + MACD curl
- **Tiered Alerts**: TTTF (all 3 indices), DTTF (2 indices), STTF (1 index)
- **Profit Targets**: Automatic 50 EMA tracking and notification when target hit
- **Swing Trading**: Daily RSI < 30 oversold detection with sector filtering
- **Real-time Updates**: Supabase subscriptions for instant alert delivery
- **Push Notifications**: Firebase Cloud Messaging

## Setup

1. Clone the repo
2. Copy `.env.local.example` to `.env.local` and fill in your API keys
3. Run `npm install`
4. Run `npm run dev` to start the Vite dev server
5. Frontend runs on `http://localhost:5173`

## Environment Variables

- `VITE_SUPABASE_URL`: Your Supabase project URL
- `VITE_SUPABASE_ANON_KEY`: Your Supabase anonymous key
- `VITE_FIREBASE_API_KEY`: Your Firebase Web API key
- `FINNHUB_API_KEY`: Your Finnhub API key

## Deployment

Deploy to Vercel with cron functions for automated scanning.

## Tech Stack

- React + Vite
- Supabase (database + real-time)
- Firebase (push notifications)
- Finnhub (market data)
- TypeScript
