import React from 'react'
import { useAlerts } from '../hooks/useAlerts'
import { AlertCard } from './AlertCard'

export const Dashboard: React.FC = () => {
  const { alerts, loading } = useAlerts()

  return (
    <div className="p-4">
      <h1 className="text-3xl font-bold text-white mb-6">FlipTrader Alerts</h1>

      {loading && <p className="text-gray-400">Loading alerts...</p>}

      {alerts.length === 0 && !loading && (
        <p className="text-gray-400">No alerts yet. Waiting for signals...</p>
      )}

      <div className="space-y-2">
        {alerts.map(alert => (
          <AlertCard key={alert.id} alert={alert} />
        ))}
      </div>
    </div>
  )
}
