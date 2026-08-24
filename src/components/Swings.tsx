import React, { useMemo, useState } from 'react'
import { useSwingAlerts } from '../hooks/useSwingAlerts'
import { SwingAlertCard } from './SwingAlertCard'

type SortMode = 'recent' | 'sector'

export const Swings: React.FC = () => {
  const { alerts: swingAlerts, loading: swingLoading } = useSwingAlerts()
  const [sortMode, setSortMode] = useState<SortMode>('recent')

  // Groups by sector while keeping each group's own most-recent-first order
  // (the hook already sorts/resorts by oversold_date - grouping here is
  // purely a client-side view, doesn't touch the underlying fetch/subscribe
  // logic or resort within a sector).
  const sectorGroups = useMemo(() => {
    if (sortMode !== 'sector') return null
    const groups = new Map<string, typeof swingAlerts>()
    for (const alert of swingAlerts) {
      const list = groups.get(alert.sector) ?? []
      list.push(alert)
      groups.set(alert.sector, list)
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [swingAlerts, sortMode])

  return (
    <div className="p-4">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-3xl font-bold text-white">Swing Alerts</h1>
        <div className="flex gap-1 text-xs">
          <button
            onClick={() => setSortMode('recent')}
            className={`px-2 py-1 rounded ${sortMode === 'recent' ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-400'}`}
          >
            Recent
          </button>
          <button
            onClick={() => setSortMode('sector')}
            className={`px-2 py-1 rounded ${sortMode === 'sector' ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-400'}`}
          >
            Sector
          </button>
        </div>
      </div>

      {swingLoading && <p className="text-gray-400">Loading swing alerts...</p>}

      {swingAlerts.length === 0 && !swingLoading && (
        <p className="text-gray-400">No swing alerts yet. Waiting for oversold/overbought conditions...</p>
      )}

      {sortMode === 'recent' && (
        <div className="space-y-2">
          {swingAlerts.map(alert => (
            <SwingAlertCard key={alert.id} alert={alert} />
          ))}
        </div>
      )}

      {sortMode === 'sector' && sectorGroups && (
        <div className="space-y-4">
          {sectorGroups.map(([sector, alerts]) => (
            <div key={sector}>
              <h2 className="text-sm font-semibold text-gray-400 uppercase mb-2">{sector} ({alerts.length})</h2>
              <div className="space-y-2">
                {alerts.map(alert => (
                  <SwingAlertCard key={alert.id} alert={alert} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
