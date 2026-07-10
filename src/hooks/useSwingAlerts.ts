import { useEffect, useState } from 'react'
import { subscribeToSwingAlerts, getSwingAlerts } from '../lib/supabase'
import { SwingAlert } from '../types'

export const useSwingAlerts = () => {
  const [alerts, setAlerts] = useState<SwingAlert[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const fetchAlerts = async () => {
      try {
        const data = await getSwingAlerts()
        setAlerts(data || [])
      } catch (error) {
        console.error('Error fetching swing alerts:', error)
      } finally {
        setLoading(false)
      }
    }

    fetchAlerts()

    const subscription = subscribeToSwingAlerts((payload: any) => {
      if (payload.eventType === 'INSERT') {
        setAlerts(prev => [payload.new, ...prev])
      } else if (payload.eventType === 'UPDATE') {
        // A symbol re-firing while already oversold updates its existing row in
        // place (see scan-swings.ts) - reflect that as an in-place update and
        // resort, rather than waiting for a manual refresh to see the new time.
        setAlerts(prev => {
          const next = prev.some(a => a.id === payload.new.id)
            ? prev.map(a => (a.id === payload.new.id ? payload.new : a))
            : [payload.new, ...prev]
          return [...next].sort((a, b) => new Date(b.oversold_date).getTime() - new Date(a.oversold_date).getTime())
        })
      } else if (payload.eventType === 'DELETE') {
        // Symbol is no longer oversold (see scan-swings.ts) - fall off the list
        // immediately rather than waiting for a manual refresh.
        setAlerts(prev => prev.filter(a => a.id !== payload.old.id))
      }
    })

    return () => {
      subscription.unsubscribe()
    }
  }, [])

  return { alerts, loading }
}
