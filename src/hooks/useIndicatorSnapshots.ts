import { useEffect, useState } from 'react'
import { getIndicatorSnapshots, subscribeToIndicatorSnapshots } from '../lib/supabase'
import { IndicatorSnapshot } from '../types'

export const useIndicatorSnapshots = (symbol: string) => {
  const [snapshots, setSnapshots] = useState<IndicatorSnapshot[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)

    const fetchSnapshots = async () => {
      try {
        const data = await getIndicatorSnapshots(symbol)
        if (!cancelled) setSnapshots(data)
      } catch (error) {
        console.error('Error fetching indicator snapshots:', error)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    fetchSnapshots()

    const subscription = subscribeToIndicatorSnapshots(symbol, (payload: any) => {
      setSnapshots(prev => {
        // Swing snapshots update an existing row in place once per day (see
        // snapshot.ts) rather than always inserting - reflect that as an in-place
        // replace, not an appended duplicate.
        if (payload.eventType === 'UPDATE' && prev.some(s => s.id === payload.new.id)) {
          return prev.map(s => (s.id === payload.new.id ? payload.new : s))
        }
        return [...prev, payload.new].slice(-60)
      })
    })

    return () => {
      cancelled = true
      subscription.unsubscribe()
    }
  }, [symbol])

  return { snapshots, loading }
}
