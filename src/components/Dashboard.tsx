import React, { useMemo, useState } from 'react'
import { useAlerts } from '../hooks/useAlerts'
import { useSwingAlerts } from '../hooks/useSwingAlerts'
import { useLivePrices } from '../hooks/useLivePrices'
import { AlertCard } from './AlertCard'
import { SwingAlertCard } from './SwingAlertCard'

const DAY_TRADE_INDICES = ['SPY', 'QQQ', 'IWM']

export const Dashboard: React.FC = () => {
  const { alerts, loading } = useAlerts()
  const { alerts: swingAlerts, loading: swingLoading } = useSwingAlerts()
  const [sortBy, setSortBy] = useState<'recent' | 'confidence'>('recent')
  const livePrices = useLivePrices(DAY_TRADE_INDICES)

  const sortedAlerts = useMemo(() => {
    if (sortBy === 'recent') return alerts
    // Alerts without a confidence score (shouldn't happen going forward, but
    // guards older rows) sort to the back rather than being treated as 0.
    return [...alerts].sort((a, b) => (b.confidence ?? -1) - (a.confidence ?? -1))
  }, [alerts, sortBy])

  return (
    <div className="p-4">
      <div className="flex justify-between items-center mb-6" style={{ flexWrap: 'wrap', gap: 8 }}>
        <h1 className="text-3xl font-bold text-white">FlipTrader Alerts</h1>
        {alerts.length > 1 && (
          <div className="flex gap-2">
            <button
              onClick={() => setSortBy('recent')}
              className={`px-3 py-1 rounded text-sm font-bold ${sortBy === 'recent' ? 'bg-green-600 text-white' : 'bg-gray-700 text-gray-400'}`}
            >
              Recent
            </button>
            <button
              onClick={() => setSortBy('confidence')}
              className={`px-3 py-1 rounded text-sm font-bold ${sortBy === 'confidence' ? 'bg-green-600 text-white' : 'bg-gray-700 text-gray-400'}`}
            >
              Confidence
            </button>
          </div>
        )}
      </div>

      {loading && <p className="text-gray-400">Loading alerts...</p>}

      {alerts.length === 0 && !loading && (
        <p className="text-gray-400">No day trade alerts yet. Waiting for signals...</p>
      )}

      <div className="space-y-2 mb-6">
        {sortedAlerts.map(alert => (
          <AlertCard key={alert.id} alert={alert} livePrices={livePrices} />
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
