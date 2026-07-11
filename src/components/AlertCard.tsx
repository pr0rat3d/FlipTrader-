import React, { useEffect, useState } from 'react'
import { Alert, ProfitTarget } from '../types'
import { getTierColor, getTierLabel } from '../lib/alerts'
import { getProfitTargetsForAlert } from '../lib/supabase'

interface AlertCardProps {
  alert: Alert
}

export const AlertCard: React.FC<AlertCardProps> = ({ alert }) => {
  const tierColor = getTierColor(alert.ttf_status)
  const tierLabel = getTierLabel(alert.ttf_status)
  // macd_curl is always populated (both signal types require it), unlike
  // rsi_divergence which is null for IV alerts - use it as the direction source.
  const isBullish = alert.macd_curl === 'bullish'
  const isIV = alert.ttf_status === 'IV'

  // day_trade_alerts.entry_price/target_50ema are a single blended number even for a
  // DTF/TTF alert (2-3 symbols) - blending an ~$600 SPY price with an ~$220 IWM price
  // was never meaningful. profit_targets now has one row per triggered symbol with
  // its own real entry/target, so fetch those for an accurate per-symbol breakdown.
  const [legs, setLegs] = useState<ProfitTarget[]>([])

  useEffect(() => {
    let cancelled = false
    getProfitTargetsForAlert(alert.id)
      .then(data => { if (!cancelled) setLegs(data || []) })
      .catch(err => console.error('Error loading profit targets for alert:', err))
    return () => { cancelled = true }
  }, [alert.id])

  return (
    <div className="p-4 bg-gray-800 border-l-4 rounded mb-3" style={{ borderColor: tierColor }}>
      <div className="flex justify-between items-start mb-2">
        <div>
          <h3 className="text-lg font-bold text-white">{alert.symbol}</h3>
          <p className="text-sm text-gray-400">{new Date(alert.timestamp).toLocaleTimeString()}</p>
        </div>
        <span className="px-3 py-1 rounded-full text-white text-sm font-bold" style={{ backgroundColor: tierColor }}>
          {alert.ttf_status} - {tierLabel}
        </span>
      </div>

      <div className="mb-2">
        <p className="text-gray-400 text-sm">Signal</p>
        <p className={`font-bold ${isBullish ? 'text-green-400' : 'text-red-400'}`}>
          {isBullish ? '↑ BULLISH' : '↓ BEARISH'}
        </p>
      </div>

      {alert.confidence != null && (
        <div className="flex items-center mb-2" style={{ gap: 8 }}>
          <span className="text-xs text-gray-400" style={{ width: 66, flexShrink: 0 }}>Confidence</span>
          <div style={{ flex: 1, background: '#374151', borderRadius: 3, height: 8, overflow: 'hidden' }}>
            <div style={{ width: `${Math.round(alert.confidence * 100)}%`, background: tierColor, height: '100%' }} />
          </div>
          <span className="text-xs text-white font-bold" style={{ width: 36, textAlign: 'right', flexShrink: 0 }}>
            {Math.round(alert.confidence * 100)}%
          </span>
        </div>
      )}

      <div className="bg-gray-700 p-2 rounded mb-2 text-xs">
        <p className="text-gray-300 mb-1">
          {isIV ? (
            <>
              <strong>Early Momentum:</strong> {alert.confluence_type}
              {alert.confluence_level != null && ` at $${alert.confluence_level.toFixed(2)}`}
            </>
          ) : (
            <>
              <strong>Full Confluence:</strong> RSI {alert.rsi_divergence} + MACD {alert.macd_curl}
            </>
          )}
        </p>
        {alert.pdh != null && <p className="text-gray-400">PDH: ${alert.pdh.toFixed(2)}</p>}
        {alert.pdl != null && <p className="text-gray-400">PDL: ${alert.pdl.toFixed(2)}</p>}
        {alert.pdc != null && <p className="text-gray-400">PDC: ${alert.pdc.toFixed(2)}</p>}
        {(alert.gap_up || alert.gap_down) && (
          <p className={`font-bold ${alert.gap_up ? 'text-green-400' : 'text-red-400'}`}>
            Gap {alert.gap_up ? 'UP' : 'DOWN'}
          </p>
        )}
      </div>

      {legs.length > 0 ? (
        <div className="space-y-2">
          {legs.map(leg => {
            const priceChange = ((leg.target_50ema_price - leg.entry_price) / leg.entry_price * 100).toFixed(2)
            return (
              <div key={leg.id} className="p-2 bg-gray-700 rounded">
                <div className="flex justify-between items-center">
                  <span className="font-bold text-white">{leg.symbol}</span>
                  <span className={`text-sm font-bold ${parseFloat(priceChange) > 0 ? 'text-green-400' : 'text-red-400'}`}>
                    {priceChange}% to target
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs mt-1">
                  <span className="text-gray-400">Entry <span className="text-white font-bold">${leg.entry_price.toFixed(2)}</span></span>
                  <span className="text-gray-400">Target <span className="text-white font-bold">${leg.target_50ema_price.toFixed(2)}</span></span>
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        <p className="text-xs text-gray-400">Indices: {alert.indices_triggered.join('/')}</p>
      )}
    </div>
  )
}
