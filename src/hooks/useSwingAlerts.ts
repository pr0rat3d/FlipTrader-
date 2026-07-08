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
      }
    })

    return () => {
      subscription.unsubscribe()
    }
  }, [])

  return { alerts, loading }
}
