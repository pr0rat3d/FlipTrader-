import { useEffect, useState } from 'react'
import { getIndicatorSnapshots, getTodayIndicatorSnapshots, subscribeToIndicatorSnapshots } from '../lib/supabase'
import { IndicatorSnapshot } from '../types'

export const useIndicatorSnapshots = (symbol: string, category: 'day_trade' | 'swing') => {
  const [snapshots, setSnapshots] = useState<IndicatorSnapshot[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)

    const fetchSnapshots = async () => {
      try {
        // Day-trade is scoped to today (a symbol scanned every ~1 min needs
        // the whole session, not a fixed row count) - swing keeps its
        // existing last-60-rows behavior (one row/day, months of history).
        const data = category === 'day_trade'
          ? await getTodayIndicatorSnapshots(symbol, category)
          : await getIndicatorSnapshots(symbol)
        if (!cancelled) setSnapshots(data)
      } catch (error) {
        console.error('Error fetching indicator snapshots:', error)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    fetchSnapshots()

    const subscription = subscribeToIndicatorSnapshots(symbol, (payload: any) => {
      // The subscription itself only filters by symbol, not category - a
      // symbol that's ever tracked in both categories would otherwise leak a
      // row from the other category into this one.
      if (payload.new.category !== category) return

      setSnapshots(prev => {
        // Swing snapshots update an existing row in place once per day (see
        // snapshot.ts) rather than always inserting - reflect that as an in-place
        // replace, not an appended duplicate.
        if (payload.eventType === 'UPDATE' && prev.some(s => s.id === payload.new.id)) {
          return prev.map(s => (s.id === payload.new.id ? payload.new : s))
        }
        // Day-trade is already scoped to today by the initial fetch - no
        // need to (and shouldn't) truncate it the way swing's fixed cap does.
        return category === 'day_trade' ? [...prev, payload.new] : [...prev, payload.new].slice(-60)
      })
    })

    return () => {
      cancelled = true
      subscription.unsubscribe()
    }
  }, [symbol, category])

  return { snapshots, loading }
}
