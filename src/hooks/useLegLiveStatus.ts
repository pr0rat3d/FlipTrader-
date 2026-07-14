import { useCallback, useEffect, useMemo, useState } from 'react'
import { getTodayLegStatuses, subscribeToProfitTargets } from '../lib/supabase'

interface LegStatus {
  alertId: string
  status: string
}

// Tracks whether each day_trade_alert's legs are still live (at least one
// 'open') or fully resolved (stopped_out/expired/target_hit) - used to
// exclude a fully-resolved occurrence from an alert-consolidation
// "continuation" streak on the Dashboard, so a trade that already stopped
// out doesn't keep looking like it's still an active setup.
export const useLegLiveStatus = () => {
  const [legs, setLegs] = useState<Map<string, LegStatus>>(new Map())

  useEffect(() => {
    let cancelled = false

    getTodayLegStatuses()
      .then(rows => {
        if (cancelled) return
        setLegs(new Map(rows.map(r => [r.id, { alertId: r.day_trade_alert_id, status: r.status }])))
      })
      .catch(console.error)

    const subscription = subscribeToProfitTargets((payload: any) => {
      if (payload.eventType === 'DELETE') return
      setLegs(prev => {
        const next = new Map(prev)
        next.set(payload.new.id, { alertId: payload.new.day_trade_alert_id, status: payload.new.status })
        return next
      })
    })

    return () => {
      cancelled = true
      subscription.unsubscribe()
    }
  }, [])

  const liveAlertIds = useMemo(() => {
    const statusesByAlert = new Map<string, string[]>()
    for (const leg of legs.values()) {
      const list = statusesByAlert.get(leg.alertId) ?? []
      list.push(leg.status)
      statusesByAlert.set(leg.alertId, list)
    }
    const live = new Set<string>()
    for (const [alertId, statuses] of statusesByAlert) {
      if (statuses.some(s => s === 'open')) live.add(alertId)
    }
    return live
  }, [legs])

  const knownAlertIds = useMemo(() => new Set(Array.from(legs.values()).map(l => l.alertId)), [legs])

  // An alert with no leg data loaded yet (e.g. legs haven't been fetched/
  // inserted yet) is treated as live rather than prematurely excluded.
  // Stable reference (via useCallback) so it doesn't force a recompute of
  // whatever memoized grouping consumes it on every render.
  const isLive = useCallback(
    (alertId: string): boolean => !knownAlertIds.has(alertId) || liveAlertIds.has(alertId),
    [knownAlertIds, liveAlertIds]
  )

  return { isLive }
}
