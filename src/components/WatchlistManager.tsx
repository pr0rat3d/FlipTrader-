import React, { useState } from 'react'

export const WatchlistManager: React.FC = () => {
  const [symbol, setSymbol] = useState('')
  const [watchlist, setWatchlist] = useState(['SPY', 'QQQ', 'IWM'])

  const addSymbol = () => {
    if (symbol && !watchlist.includes(symbol.toUpperCase())) {
      setWatchlist([...watchlist, symbol.toUpperCase()])
      setSymbol('')
    }
  }

  const removeSymbol = (sym: string) => {
    setWatchlist(watchlist.filter(s => s !== sym))
  }

  return (
    <div className="p-4">
      <h2 className="text-2xl font-bold text-white mb-4">Watchlist</h2>

      <div className="flex gap-2 mb-4">
        <input
          type="text"
          value={symbol}
          onChange={(e) => setSymbol(e.target.value.toUpperCase())}
          placeholder="Enter symbol (e.g., AAPL)"
          className="flex-1 px-3 py-2 bg-gray-700 text-white rounded border border-gray-600"
        />
        <button
          onClick={addSymbol}
          className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700"
        >
          Add
        </button>
      </div>

      <div className="space-y-2">
        {watchlist.map(sym => (
          <div key={sym} className="flex justify-between items-center p-3 bg-gray-800 rounded">
            <span className="text-white font-bold">{sym}</span>
            <button
              onClick={() => removeSymbol(sym)}
              className="px-3 py-1 bg-red-600 text-white rounded hover:bg-red-700 text-sm"
            >
              Remove
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
