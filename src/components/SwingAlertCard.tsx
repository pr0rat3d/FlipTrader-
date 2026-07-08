import React from 'react'
import { SwingAlert } from '../types'

interface SwingAlertCardProps {
  alert: SwingAlert
}

export const SwingAlertCard: React.FC<SwingAlertCardProps> = ({ alert }) => (
  <div className="p-3 bg-gray-800 rounded mb-3" style={{ borderLeft: '4px solid #4ade80' }}>
    <div className="flex justify-between items-center">
      <div>
        <span className="font-bold text-white">{alert.symbol}</span>
        <span className="text-xs text-gray-400 ml-2">{alert.sector}</span>
      </div>
      <span className="text-sm font-bold text-green-400">RSI {alert.rsi_value.toFixed(1)}</span>
    </div>
    <p className="text-xs text-gray-400 mt-2">{new Date(alert.oversold_date).toLocaleString()}</p>
  </div>
)
