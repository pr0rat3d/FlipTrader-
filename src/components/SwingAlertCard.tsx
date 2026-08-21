import React from 'react'
import { SwingAlert } from '../types'

interface SwingAlertCardProps {
  alert: SwingAlert
}

// Options/Greeks fields are only populated once a real Alpaca contract was
// found for this symbol (server/swingOptionSelection.ts) - a symbol can be a
// valid RSI alert with these still null (a fresh IV-rank cold start, or the
// options lookup came up empty for an illiquid name), so the card degrades
// gracefully to the original RSI-only display rather than showing blanks.
export const SwingAlertCard: React.FC<SwingAlertCardProps> = ({ alert }) => {
  const isPut = alert.signal_type === 'PUT'
  const hasOptionsData = alert.recommended_strike != null && alert.delta != null

  return (
    <div className="p-3 bg-gray-800 rounded mb-3" style={{ borderLeft: `4px solid ${isPut ? '#f87171' : '#4ade80'}` }}>
      <div className="flex justify-between items-center">
        <div>
          <span className="font-bold text-white">{alert.symbol}</span>
          {alert.signal_type && (
            <span className={`text-xs font-bold ml-2 px-1.5 py-0.5 rounded ${isPut ? 'bg-red-900 text-red-300' : 'bg-green-900 text-green-300'}`}>
              {alert.signal_type}
            </span>
          )}
          <span className="text-xs text-gray-400 ml-2">{alert.sector}</span>
        </div>
        <span className={`text-sm font-bold ${isPut ? 'text-red-400' : 'text-green-400'}`}>RSI {alert.rsi_value.toFixed(1)}</span>
      </div>

      {hasOptionsData && (
        <div className="text-xs text-gray-300 mt-2">
          <span>${alert.recommended_strike}{isPut ? 'P' : 'C'} exp {alert.expiration_date}</span>
          <span className="ml-2">Δ {alert.delta!.toFixed(2)}</span>
          {alert.gamma != null && <span className="ml-2">Γ {alert.gamma.toFixed(4)}</span>}
          {alert.theta != null && <span className="ml-2">Θ {alert.theta.toFixed(2)}</span>}
          {alert.vega != null && <span className="ml-2">V {alert.vega.toFixed(2)}</span>}
        </div>
      )}
      {alert.iv_current != null && (
        <div className="text-xs text-gray-400 mt-1">
          IV {(alert.iv_current * 100).toFixed(0)}%
          {alert.iv_rank != null ? ` · rank ${alert.iv_rank.toFixed(0)}%` : ' · rank building history'}
        </div>
      )}
      {alert.entry_rationale && (
        <p className="text-xs text-gray-400 mt-1 italic">{alert.entry_rationale}</p>
      )}

      <p className="text-xs text-gray-400 mt-2">{new Date(alert.oversold_date).toLocaleString()}</p>
    </div>
  )
}
