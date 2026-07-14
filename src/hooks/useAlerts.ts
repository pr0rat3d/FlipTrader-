import { useEffect, useState } from 'react'
import { subscribeToAlerts, getTodayAlerts } from '../lib/supabase'
import { Alert } from '../types'

// Dashboard-only, deliberately scoped to today (see getTodayAlerts) - the full
// unscoped history is still available on the History page and Performance.
export const useAlerts = () => {
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const fetchAlerts = async () => {
      try {
        const data = await getTodayAlerts()
        setAlerts(data || [])
      } catch (error) {
        console.error('Error fetching alerts:', error)
      } finally {
        setLoading(false)
      }
    }

    fetchAlerts()

    const subscription = subscribeToAlerts((payload: any) => {
      if (payload.eventType === 'INSERT') {
        setAlerts(prev => [payload.new, ...prev])
      }
    })

    return () => {
      subscription.unsubscribe()
    }
  }, [])

  return { alerts, loading }
}
