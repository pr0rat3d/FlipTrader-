import React, { useMemo, useState } from 'react'
import { useAlerts } from '../hooks/useAlerts'
import { useSwingAlerts } from '../hooks/useSwingAlerts'
import { useLivePrices } from '../hooks/useLivePrices'
import { AlertCard } from './AlertCard'
import { SwingAlertCard } from './SwingAlertCard'
import { Alert } from '../types'

const DAY_TRADE_INDICES = ['SPY', 'QQQ', 'IWM']

interface AlertGroup {
  key: string
  representative: Alert
  count: number
  firstSeenAt: string
}

// A "slot" is type+symbols only (no direction) - the dashboard real estate
// for e.g. "IV Momentum Entry: SPY/QQQ" should show ONE current read, not a
// bullish card and a bearish card sitting side by side when the underlying
// condition has flipped direction mid-session.
const slotKey = (alert: Alert): string => {
  const indices = [...alert.indices_triggered].sort().join(',')
  return `${alert.ttf_status}:${indices}`
}

const alertDirection = (alert: Alert): string => alert.macd_curl ?? alert.rsi_divergence ?? 'unknown'

// Repeated alerts for the same setup collapse into one card instead of
// stacking a new one every scan cycle - ORB/IV can keep re-firing every 1-3
// min for as long as the underlying condition holds (same idea as the
// candlestick-pattern-run consolidation on the Indicators page).
//
// Two passes: first, find each slot's CURRENT direction (whichever direction
// its most recent alert fired in). Second, fold in only alerts matching that
// current direction - a stale opposite-direction alert (superseded by a
// fresher flip, e.g. bearish IV SPY/QQQ earlier, bullish IV SPY/QQQ now) is
// dropped entirely rather than shown as a second, contradictory card for the
// same slot.
//
// Within the surviving direction, the card shown is whichever occurrence has
// the HIGHEST confidence seen so far in that streak, not just the most
// recent - a fresh higher-confidence re-fire is real new evidence (entry/stop
// have likely moved too), so it should visibly replace a weaker prior read
// rather than get silently outranked by a more recent but weaker occurrence.
const groupAlerts = (alerts: Alert[]): AlertGroup[] => {
  const currentDirection = new Map<string, string>()
  for (const alert of alerts) {
    const key = slotKey(alert)
    if (!currentDirection.has(key)) currentDirection.set(key, alertDirection(alert))
  }

  const groups = new Map<string, AlertGroup>()
  const order: string[] = []

  for (const alert of alerts) {
    const key = slotKey(alert)
    if (alertDirection(alert) !== currentDirection.get(key)) continue

    const existing = groups.get(key)
    if (!existing) {
      groups.set(key, { key, representative: alert, count: 1, firstSeenAt: alert.timestamp })
      order.push(key)
      continue
    }
    existing.count += 1
    // `alerts` is newest-first, so the last one processed per key is the earliest.
    existing.firstSeenAt = alert.timestamp
    if ((alert.confidence ?? -1) > (existing.representative.confidence ?? -1)) {
      existing.representative = alert
    }
  }

  return order.map(k => groups.get(k)!)
}

export const Dashboard: React.FC = () => {
  const { alerts, loading } = useAlerts()
  const { alerts: swingAlerts, loading: swingLoading } = useSwingAlerts()
  const [sortBy, setSortBy] = useState<'recent' | 'confidence'>('recent')
  const livePrices = useLivePrices(DAY_TRADE_INDICES)

  // Groups are already in newest-occurrence-first order for 'recent' (the
  // `order` array records first-seen-during-iteration, which walks the
  // already-newest-first `alerts` list).
  const groupedAlerts = useMemo(() => groupAlerts(alerts), [alerts])

  const sortedGroups = useMemo(() => {
    if (sortBy === 'recent') return groupedAlerts
    // Groups without a confidence score (shouldn't happen going forward, but
    // guards older rows) sort to the back rather than being treated as 0.
    return [...groupedAlerts].sort((a, b) => (b.representative.confidence ?? -1) - (a.representative.confidence ?? -1))
  }, [groupedAlerts, sortBy])

  return (
    <div className="p-4">
      <div className="flex justify-between items-center mb-6" style={{ flexWrap: 'wrap', gap: 8 }}>
        <h1 className="text-3xl font-bold text-white">FlipTrader Alerts</h1>
        {groupedAlerts.length > 1 && (
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

      {groupedAlerts.length === 0 && !loading && (
        <p className="text-gray-400">No day trade alerts yet today. Waiting for signals...</p>
      )}

      <div className="space-y-2 mb-6">
        {sortedGroups.map(group => (
          <AlertCard
            key={group.key}
            alert={group.representative}
            livePrices={livePrices}
            occurrenceCount={group.count}
            firstSeenAt={group.firstSeenAt}
          />
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
