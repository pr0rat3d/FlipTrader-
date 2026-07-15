import React, { useEffect, useMemo, useState } from 'react'
import { getAlerts, getProfitTargets, subscribeToAlerts, subscribeToProfitTargets } from '../lib/supabase'
import { getTierColor, getTierLabel } from '../lib/alerts'
import { Alert, ProfitTarget } from '../types'
import { fmt, timeLabel } from './charts/ChartPrimitives'

const TIERS: Array<'TTTF' | 'DTTF' | 'STTF' | 'IV' | 'ORB'> = ['TTTF', 'DTTF', 'STTF', 'IV', 'ORB']

interface TierStats {
  tier: 'TTTF' | 'DTTF' | 'STTF' | 'IV' | 'ORB'
  totalLegs: number
  resolvedLegs: number
  targetHit: number
  expired: number
  open: number
  milestone10Pct: number
  milestone20Pct: number
  milestone30Pct: number
  targetHitPct: number
  avgMaxFavorablePct: number | null
}

const computeTierStats = (tier: 'TTTF' | 'DTTF' | 'STTF' | 'IV' | 'ORB', legs: ProfitTarget[]): TierStats => {
  const totalLegs = legs.length
  const targetHit = legs.filter(l => l.status === 'target_hit').length
  const expired = legs.filter(l => l.status === 'expired').length
  const open = legs.filter(l => l.status === 'open').length
  const resolvedLegs = targetHit + expired

  const pct = (count: number) => (totalLegs > 0 ? (count / totalLegs) * 100 : 0)

  const favorableValues = legs.map(l => l.max_favorable_pct).filter((v): v is number => v !== null)
  const avgMaxFavorablePct = favorableValues.length > 0
    ? favorableValues.reduce((a, b) => a + b, 0) / favorableValues.length
    : null

  return {
    tier,
    totalLegs,
    resolvedLegs,
    targetHit,
    expired,
    open,
    milestone10Pct: pct(legs.filter(l => l.milestone_10_hit_at !== null).length),
    milestone20Pct: pct(legs.filter(l => l.milestone_20_hit_at !== null).length),
    milestone30Pct: pct(legs.filter(l => l.milestone_30_hit_at !== null).length),
    targetHitPct: resolvedLegs > 0 ? (targetHit / resolvedLegs) * 100 : 0,
    avgMaxFavorablePct
  }
}

const COLOR_MILESTONE = '#3987e5'

const MilestoneBar: React.FC<{ label: string; pct: number; color: string }> = ({ label, pct, color }) => (
  <div className="flex items-center mb-1" style={{ gap: 8 }}>
    <span className="text-xs text-gray-400" style={{ width: 90, flexShrink: 0 }}>{label}</span>
    <div style={{ flex: 1, background: '#374151', borderRadius: 3, height: 10, overflow: 'hidden' }}>
      <div style={{ width: `${Math.min(100, Math.max(0, pct))}%`, background: color, height: '100%' }} />
    </div>
    <span className="text-xs text-white font-bold" style={{ width: 40, textAlign: 'right', flexShrink: 0 }}>{pct.toFixed(0)}%</span>
  </div>
)

const TierCard: React.FC<{ stats: TierStats }> = ({ stats }) => {
  const color = getTierColor(stats.tier)
  const label = getTierLabel(stats.tier)

  return (
    <div className="p-3 bg-gray-800 rounded mb-3" style={{ borderLeft: `4px solid ${color}` }}>
      <div className="flex justify-between items-center mb-2">
        <h3 className="text-sm font-bold text-white">{stats.tier} <span className="text-xs text-gray-400">{label}</span></h3>
        <span className="text-xs text-gray-400">{stats.totalLegs} signal{stats.totalLegs !== 1 ? 's' : ''}</span>
      </div>

      {stats.totalLegs === 0 ? (
        <p className="text-xs text-gray-400">No signals recorded yet for this tier.</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 mb-2">
            <div>
              <p className="text-xs text-gray-400">Target-hit rate (resolved only)</p>
              <p className="text-sm font-bold text-white">
                {stats.resolvedLegs > 0 ? `${stats.targetHitPct.toFixed(0)}%` : '—'}
                <span className="text-xs text-gray-400"> ({stats.targetHit}/{stats.resolvedLegs})</span>
              </p>
            </div>
            <div>
              <p className="text-xs text-gray-400">Avg max favorable move</p>
              <p className="text-sm font-bold text-white">
                {stats.avgMaxFavorablePct !== null ? `${stats.avgMaxFavorablePct.toFixed(1)}%` : '—'}
              </p>
            </div>
          </div>

          <MilestoneBar label="Milestone 10%" pct={stats.milestone10Pct} color={COLOR_MILESTONE} />
          <MilestoneBar label="Milestone 20%" pct={stats.milestone20Pct} color={COLOR_MILESTONE} />
          <MilestoneBar label="Milestone 30%" pct={stats.milestone30Pct} color={COLOR_MILESTONE} />
          <MilestoneBar label="Full target" pct={stats.totalLegs > 0 ? (stats.targetHit / stats.totalLegs) * 100 : 0} color={color} />

          {stats.open > 0 && (
            <p className="text-xs text-gray-400 mt-2">{stats.open} still open (pending)</p>
          )}
        </>
      )}
    </div>
  )
}

type ConfidenceBucket = 'high' | 'medium' | 'low'
const CONFIDENCE_BUCKETS: ConfidenceBucket[] = ['high', 'medium', 'low']

const bucketLabel = (bucket: ConfidenceBucket): string => {
  if (bucket === 'high') return 'High (≥80%)'
  if (bucket === 'medium') return 'Medium (60-80%)'
  return 'Low (<60%)'
}

const bucketFor = (confidence: number): ConfidenceBucket => {
  if (confidence >= 0.8) return 'high'
  if (confidence >= 0.6) return 'medium'
  return 'low'
}

interface ConfidenceBucketStats {
  bucket: ConfidenceBucket
  totalLegs: number
  resolvedLegs: number
  targetHit: number
  targetHitPct: number
  avgMaxFavorablePct: number | null
}

const computeConfidenceBucketStats = (bucket: ConfidenceBucket, legs: ProfitTarget[]): ConfidenceBucketStats => {
  const totalLegs = legs.length
  const targetHit = legs.filter(l => l.status === 'target_hit').length
  const expired = legs.filter(l => l.status === 'expired').length
  const resolvedLegs = targetHit + expired

  const favorableValues = legs.map(l => l.max_favorable_pct).filter((v): v is number => v !== null)
  const avgMaxFavorablePct = favorableValues.length > 0
    ? favorableValues.reduce((a, b) => a + b, 0) / favorableValues.length
    : null

  return {
    bucket,
    totalLegs,
    resolvedLegs,
    targetHit,
    targetHitPct: resolvedLegs > 0 ? (targetHit / resolvedLegs) * 100 : 0,
    avgMaxFavorablePct
  }
}

const ConfidenceBucketCard: React.FC<{ stats: ConfidenceBucketStats }> = ({ stats }) => (
  <div className="p-3 bg-gray-800 rounded mb-2">
    <div className="flex justify-between items-center mb-1">
      <h4 className="text-sm font-bold text-white">{bucketLabel(stats.bucket)}</h4>
      <span className="text-xs text-gray-400">{stats.totalLegs} signal{stats.totalLegs !== 1 ? 's' : ''}</span>
    </div>
    {stats.totalLegs === 0 ? (
      <p className="text-xs text-gray-400">No signals recorded yet in this range.</p>
    ) : (
      <div className="grid grid-cols-2 gap-2">
        <div>
          <p className="text-xs text-gray-400">Target-hit rate</p>
          <p className="text-sm font-bold text-white">
            {stats.resolvedLegs > 0 ? `${stats.targetHitPct.toFixed(0)}%` : '—'}
            <span className="text-xs text-gray-400"> ({stats.targetHit}/{stats.resolvedLegs})</span>
          </p>
        </div>
        <div>
          <p className="text-xs text-gray-400">Avg max favorable move</p>
          <p className="text-sm font-bold text-white">
            {stats.avgMaxFavorablePct !== null ? `${stats.avgMaxFavorablePct.toFixed(1)}%` : '—'}
          </p>
        </div>
      </div>
    )}
  </div>
)

const statusLabel = (status: ProfitTarget['status']) => {
  if (status === 'target_hit') return { text: 'Target hit', color: '#4ade80' }
  if (status === 'expired') return { text: 'Expired', color: '#f87171' }
  return { text: 'Open', color: '#898781' }
}

export const Performance: React.FC = () => {
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [profitTargets, setProfitTargets] = useState<ProfitTarget[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const load = async () => {
      try {
        const [alertData, targetData] = await Promise.all([getAlerts(), getProfitTargets()])
        setAlerts(alertData || [])
        setProfitTargets(targetData || [])
      } catch (error) {
        console.error('Error loading performance data:', error)
      } finally {
        setLoading(false)
      }
    }
    load()

    // Live updates - a milestone/target hit while this page is open (track-profit-
    // targets.ts runs every minute) should reflect immediately, not require a reload.
    const alertSub = subscribeToAlerts((payload: any) => {
      if (payload.eventType === 'INSERT') {
        setAlerts(prev => [payload.new, ...prev])
      }
    })

    const targetSub = subscribeToProfitTargets((payload: any) => {
      if (payload.eventType === 'INSERT') {
        setProfitTargets(prev => [payload.new, ...prev])
      } else if (payload.eventType === 'UPDATE') {
        setProfitTargets(prev =>
          prev.some(pt => pt.id === payload.new.id)
            ? prev.map(pt => (pt.id === payload.new.id ? payload.new : pt))
            : [payload.new, ...prev]
        )
      }
    })

    return () => {
      alertSub.unsubscribe()
      targetSub.unsubscribe()
    }
  }, [])

  const alertTierById = useMemo(() => {
    const map = new Map<string, 'TTTF' | 'DTTF' | 'STTF' | 'IV' | 'ORB'>()
    for (const alert of alerts) map.set(alert.id, alert.ttf_status)
    return map
  }, [alerts])

  const alertConfidenceById = useMemo(() => {
    const map = new Map<string, number>()
    for (const alert of alerts) {
      if (alert.confidence != null) map.set(alert.id, alert.confidence)
    }
    return map
  }, [alerts])

  const tierStats = useMemo(() => {
    return TIERS.map(tier => {
      const legs = profitTargets.filter(pt => alertTierById.get(pt.day_trade_alert_id) === tier)
      return computeTierStats(tier, legs)
    })
  }, [profitTargets, alertTierById])

  // Does the a-priori confidence score (computed at signal time) actually predict
  // real outcomes? Buckets every resolved/open leg by its alert's confidence,
  // independent of tier - a high-confidence STTF and a high-confidence TTTF land in
  // the same bucket here.
  const confidenceBucketStats = useMemo(() => {
    const legsWithConfidence = profitTargets.filter(pt => alertConfidenceById.has(pt.day_trade_alert_id))
    return CONFIDENCE_BUCKETS.map(bucket => {
      const legs = legsWithConfidence.filter(pt => bucketFor(alertConfidenceById.get(pt.day_trade_alert_id)!) === bucket)
      return computeConfidenceBucketStats(bucket, legs)
    })
  }, [profitTargets, alertConfidenceById])

  const recentLegs = useMemo(
    () => [...profitTargets].sort((a, b) => new Date(b.entry_time).getTime() - new Date(a.entry_time).getTime()).slice(0, 30),
    [profitTargets]
  )

  return (
    <div className="p-4">
      <h2 className="text-2xl font-bold text-white mb-2">Performance</h2>
      <p className="text-xs text-gray-400 mb-4">
        Did the TTTF/DTTF/STTF reversal signals actually pay off? Milestones are % of the
        price distance from entry to the 50 EMA target (10/20/30%), with the full target
        as the "50 tap." Live tracking uses real-time quotes; historical replay uses
        5-minute close-only snapshots, so it may understate the true peak favorable move.
      </p>

      {loading && <p className="text-gray-400">Loading performance data...</p>}

      {!loading && profitTargets.length === 0 && (
        <p className="text-gray-400">
          No signals have fired yet, so there's nothing to analyze. This fills in
          automatically as real TTTF/DTTF/STTF alerts occur.
        </p>
      )}

      {!loading && profitTargets.length > 0 && (
        <>
          {tierStats.map(stats => <TierCard key={stats.tier} stats={stats} />)}

          <h3 className="text-lg font-bold text-white mb-2 mt-4">Confidence Calibration</h3>
          <p className="text-xs text-gray-400 mb-2">
            Does the confidence score computed at signal time actually predict outcomes?
            Grouped by confidence range regardless of tier.
          </p>
          {confidenceBucketStats.map(stats => <ConfidenceBucketCard key={stats.bucket} stats={stats} />)}

          <h3 className="text-lg font-bold text-white mb-2 mt-4">Recent Signals</h3>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {['Time', 'Symbol', 'Entry', 'Target', 'Confidence', 'Max Favorable', 'Status'].map(h => (
                    <th key={h} className="text-xs text-gray-400" style={{ textAlign: 'left', padding: '4px 8px', borderBottom: '1px solid #374151' }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {recentLegs.map(leg => {
                  const status = statusLabel(leg.status)
                  const confidence = alertConfidenceById.get(leg.day_trade_alert_id)
                  return (
                    <tr key={leg.id}>
                      <td className="text-xs text-white" style={{ padding: '4px 8px' }}>{timeLabel(leg.entry_time)}</td>
                      <td className="text-xs text-white font-bold" style={{ padding: '4px 8px' }}>{leg.symbol}</td>
                      <td className="text-xs text-white" style={{ padding: '4px 8px' }}>${fmt(leg.entry_price)}</td>
                      <td className="text-xs text-white" style={{ padding: '4px 8px' }}>${fmt(leg.target_50ema_price)}</td>
                      <td className="text-xs text-white" style={{ padding: '4px 8px' }}>
                        {confidence != null ? `${Math.round(confidence * 100)}%` : '—'}
                      </td>
                      <td className="text-xs text-white" style={{ padding: '4px 8px' }}>
                        {leg.max_favorable_pct !== null ? `${leg.max_favorable_pct.toFixed(1)}%` : '—'}
                      </td>
                      <td className="text-xs font-bold" style={{ padding: '4px 8px', color: status.color }}>{status.text}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
