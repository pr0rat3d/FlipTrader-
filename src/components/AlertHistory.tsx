import React, { useEffect, useState } from 'react'
import { getAlerts } from '../lib/supabase'
import { Alert } from '../types'

export const AlertHistory: React.FC = () => {
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const loadAlerts = async () => {
      try {
        const data = await getAlerts()
        setAlerts(data || [])
      } catch (error) {
        console.error('Error loading alerts:', error)
      } finally {
        setLoading(false)
      }
    }

    loadAlerts()
  }, [])

  return (
    <div className="p-4">
      <h2 className="text-2xl font-bold text-white mb-4">Alert History</h2>

      {loading && <p className="text-gray-400">Loading...</p>}

      <div className="space-y-2">
        {alerts.map(alert => (
          <div key={alert.id} className="p-3 bg-gray-800 rounded">
            <div className="flex justify-between items-center">
              <span className="font-bold text-white">{alert.symbol}</span>
              <span className={`text-sm ${alert.rsi_divergence === 'bullish' ? 'text-green-400' : 'text-red-400'}`}>
                {alert.rsi_divergence === 'bullish' ? '↑' : '↓'} {alert.ttf_status}
              </span>
            </div>
            <p className="text-xs text-gray-400">{new Date(alert.timestamp).toLocaleString()}</p>
          </div>
        ))}
      </div>
    </div>
  )
}
