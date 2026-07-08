import React from 'react'
import { useAlerts } from '../hooks/useAlerts'
import { useSwingAlerts } from '../hooks/useSwingAlerts'
import { AlertCard } from './AlertCard'
import { SwingAlertCard } from './SwingAlertCard'

export const Dashboard: React.FC = () => {
  const { alerts, loading } = useAlerts()
  const { alerts: swingAlerts, loading: swingLoading } = useSwingAlerts()

  return (
    <div className="p-4">
      <h1 className="text-3xl font-bold text-white mb-6">FlipTrader Alerts</h1>

      {loading && <p className="text-gray-400">Loading alerts...</p>}

      {alerts.length === 0 && !loading && (
        <p className="text-gray-400">No day trade alerts yet. Waiting for signals...</p>
      )}

      <div className="space-y-2 mb-6">
        {alerts.map(alert => (
          <AlertCard key={alert.id} alert={alert} />
        ))}
      </div>

      <h2 className="text-2xl font-bold text-white mb-4">Swing Alerts</h2>

      {swingLoading && <p className="text-gray-400">Loading swing alerts...</p>}

      {swingAlerts.length === 0 && !swingLoading && (
        <p className="text-gray-400">No swing alerts yet. Waiting for oversold conditions...</p>
      )}

      <div className="space-y-2">
        {swingAlerts.map(alert => (
          <SwingAlertCard key={alert.id} alert={alert} />
        ))}
      </div>
    </div>
  )
}
