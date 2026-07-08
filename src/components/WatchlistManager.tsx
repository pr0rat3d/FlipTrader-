import React, { useEffect, useState } from 'react'
import { useAuth } from '../hooks/useAuth'
import { getWatchlist, addWatchlistSymbol, removeWatchlistSymbol } from '../lib/supabase'
import { Watchlist } from '../types'
import { Auth } from './Auth'

const MAX_WATCHLIST_SIZE = 20

export const WatchlistManager: React.FC = () => {
  const { user, loading: authLoading } = useAuth()
  const [symbol, setSymbol] = useState('')
  const [type, setType] = useState<'day_trade' | 'swing'>('swing')
  const [watchlist, setWatchlist] = useState<Watchlist[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadWatchlist = async () => {
    if (!user) return
    try {
      const data = await getWatchlist(user.id)
      setWatchlist(data || [])
    } catch (err) {
      console.error('Error loading watchlist:', err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!user) {
      setLoading(false)
      return
    }
    loadWatchlist()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user])

  const addSymbol = async () => {
    if (!user || !symbol) return
    setError(null)

    const upper = symbol.toUpperCase()
    if (watchlist.some(w => w.symbol === upper && w.type === type)) {
      setError(`${upper} is already on your ${type.replace('_', ' ')} watchlist`)
      return
    }
    if (watchlist.length >= MAX_WATCHLIST_SIZE) {
      setError(`Watchlist is capped at ${MAX_WATCHLIST_SIZE} symbols`)
      return
    }

    try {
      await addWatchlistSymbol(user.id, upper, type)
      setSymbol('')
      await loadWatchlist()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const removeSymbol = async (id: string) => {
    try {
      await removeWatchlistSymbol(id)
      setWatchlist(prev => prev.filter(w => w.id !== id))
    } catch (err) {
      console.error('Error removing symbol:', err)
    }
  }

  if (authLoading) {
    return <div className="p-4"><p className="text-gray-400">Loading...</p></div>
  }

  if (!user) {
    return (
      <div className="p-4">
        <h2 className="text-2xl font-bold text-white mb-4">Watchlist</h2>
        <p className="text-gray-400 mb-4">Log in to follow individual tickers and get their RSI/MACD/EMA metrics tracked.</p>
        <Auth />
      </div>
    )
  }

  return (
    <div className="p-4">
      <h2 className="text-2xl font-bold text-white mb-4">Watchlist</h2>

      <div className="flex gap-2 mb-2">
        <input
          type="text"
          value={symbol}
          onChange={(e) => setSymbol(e.target.value.toUpperCase())}
          placeholder="Enter symbol (e.g., AAPL)"
          className="flex-1 px-3 py-2 bg-gray-700 text-white rounded border border-gray-600"
        />
        <select
          value={type}
          onChange={(e) => setType(e.target.value as 'day_trade' | 'swing')}
          className="px-3 py-2 bg-gray-700 text-white rounded border border-gray-600"
        >
          <option value="swing">Swing</option>
          <option value="day_trade">Day Trade</option>
        </select>
        <button
          onClick={addSymbol}
          className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700"
        >
          Add
        </button>
      </div>

      {error && <p className="text-sm text-red-400 mb-3">{error}</p>}

      {loading && <p className="text-gray-400">Loading watchlist...</p>}

      {!loading && watchlist.length === 0 && (
        <p className="text-gray-400">No tickers followed yet. Add a stock or ETF above to start tracking its RSI/MACD/EMA metrics.</p>
      )}

      <div className="space-y-2">
        {watchlist.map(w => (
          <div key={w.id} className="flex justify-between items-center p-3 bg-gray-800 rounded">
            <div>
              <span className="text-white font-bold">{w.symbol}</span>
              <span className="text-xs text-gray-400 ml-2">{w.type === 'day_trade' ? 'Day Trade' : 'Swing'}</span>
            </div>
            <button
              onClick={() => removeSymbol(w.id)}
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
