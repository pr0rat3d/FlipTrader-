import React from 'react'
import { useSwingAlerts } from '../hooks/useSwingAlerts'
import { SwingAlertCard } from './SwingAlertCard'

export const Swings: React.FC = () => {
  const { alerts: swingAlerts, loading: swingLoading } = useSwingAlerts()

  return (
    <div className="p-4">
      <h1 className="text-3xl font-bold text-white mb-6">Swing Alerts</h1>

      {swingLoading && <p className="text-gray-400">Loading swing alerts...</p>}

      {swingAlerts.length === 0 && !swingLoading && (
        <p className="text-gray-400">No swing alerts yet. Waiting for oversold/overbought conditions...</p>
      )}

      <div className="space-y-2">
        {swingAlerts.map(alert => (
          <SwingAlertCard key={alert.id} alert={alert} />
        ))}
      </div>
    </div>
  )
}
