import { useEffect, useState } from 'react'
import { subscribeToAlerts, getAlerts } from '../lib/supabase'
import { Alert } from '../types'

export const useAlerts = () => {
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const fetchAlerts = async () => {
      try {
        const data = await getAlerts()
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
