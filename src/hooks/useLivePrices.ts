import { useEffect, useState } from 'react'
import { getLatestPrice, subscribeToIndicatorSnapshots } from '../lib/supabase'

// One realtime subscription per symbol, shared across however many alert cards/
// legs reference it - day-trade alert legs are always drawn from the fixed
// confluence indices (SPY/QQQ/IWM), so this never needs to scale with alert
// count the way a per-card subscription would (up to 50 recent alerts x 3 legs
// each, all pointing at the same handful of symbols).
export const useLivePrices = (symbols: string[]) => {
  const [prices, setPrices] = useState<Record<string, number | null>>({})

  useEffect(() => {
    let cancelled = false

    const subscriptions = symbols.map(symbol => {
      getLatestPrice(symbol, 'day_trade')
        .then(price => { if (!cancelled) setPrices(prev => ({ ...prev, [symbol]: price })) })
        .catch(console.error)

      return subscribeToIndicatorSnapshots(symbol, (payload: any) => {
        if (payload.new.category !== 'day_trade') return
        setPrices(prev => ({ ...prev, [symbol]: payload.new.close_price }))
      })
    })

    return () => {
      cancelled = true
      subscriptions.forEach(s => s.unsubscribe())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbols.join(',')])

  return prices
}
