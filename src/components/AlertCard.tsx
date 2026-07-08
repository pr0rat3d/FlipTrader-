import React from 'react'
import { Alert } from '../types'
import { getTierColor, getTierLabel } from '../lib/alerts'

interface AlertCardProps {
  alert: Alert
}

export const AlertCard: React.FC<AlertCardProps> = ({ alert }) => {
  const tierColor = getTierColor(alert.ttf_status)
  const tierLabel = getTierLabel(alert.ttf_status)

  const isBullish = alert.rsi_divergence === 'bullish'
  const priceChange = ((alert.target_50ema - alert.entry_price) / alert.entry_price * 100).toFixed(2)

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

      <div className="grid grid-cols-2 gap-2 text-sm mb-2">
        <div>
          <p className="text-gray-400">Signal</p>
          <p className={`font-bold ${isBullish ? 'text-green-400' : 'text-red-400'}`}>
            {isBullish ? '↑ BULLISH' : '↓ BEARISH'}
          </p>
        </div>
        <div>
          <p className="text-gray-400">Indices</p>
          <p className="font-bold text-white">{alert.indices_triggered.join('/')}</p>
        </div>
        <div>
          <p className="text-gray-400">Entry</p>
          <p className="font-bold text-white">${alert.entry_price.toFixed(2)}</p>
        </div>
        <div>
          <p className="text-gray-400">Target (50 EMA)</p>
          <p className="font-bold text-white">${alert.target_50ema.toFixed(2)}</p>
        </div>
      </div>

      <div className="text-sm">
        <p className={`font-bold ${parseFloat(priceChange) > 0 ? 'text-green-400' : 'text-red-400'}`}>
          Target: {priceChange}% from entry
        </p>
      </div>
    </div>
  )
}
