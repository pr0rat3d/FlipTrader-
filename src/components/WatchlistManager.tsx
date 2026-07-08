import React, { useEffect, useRef, useState } from 'react'
import { useAuth } from '../hooks/useAuth'
import { getWatchlist, addWatchlistSymbol, removeWatchlistSymbol } from '../lib/supabase'
import { Watchlist } from '../types'
import { Auth } from './Auth'

const MAX_WATCHLIST_SIZE = 20

interface SymbolMatch {
  symbol: string
  description: string
}

export const WatchlistManager: React.FC = () => {
  const { user, loading: authLoading } = useAuth()
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<SymbolMatch | null>(null)
  const [results, setResults] = useState<SymbolMatch[]>([])
  const [showDropdown, setShowDropdown] = useState(false)
  const [searching, setSearching] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

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

  const handleQueryChange = (value: string) => {
    setQuery(value)
    setSelected(null)
    setError(null)

    if (debounceRef.current) clearTimeout(debounceRef.current)

    const trimmed = value.trim()
    if (trimmed.length < 1) {
      setResults([])
      setShowDropdown(false)
      return
    }

    debounceRef.current = setTimeout(async () => {
      setSearching(true)
      try {
        const response = await fetch(`/api/symbol-search?q=${encodeURIComponent(trimmed)}`)
        const data = await response.json()
        setResults(data.results || [])
        setShowDropdown(true)
      } catch (err) {
        console.error('Error searching symbols:', err)
      } finally {
        setSearching(false)
      }
    }, 300)
  }

  const pickResult = (match: SymbolMatch) => {
    setSelected(match)
    setQuery(`${match.symbol} - ${match.description}`)
    setShowDropdown(false)
  }

  const addSymbol = async () => {
    if (!user || !selected) return
    setError(null)

    if (watchlist.some(w => w.symbol === selected.symbol && w.type === type)) {
      setError(`${selected.symbol} is already on your ${type.replace('_', ' ')} watchlist`)
      return
    }
    if (watchlist.length >= MAX_WATCHLIST_SIZE) {
      setError(`Watchlist is capped at ${MAX_WATCHLIST_SIZE} symbols`)
      return
    }

    try {
      await addWatchlistSymbol(user.id, selected.symbol, type)
      setQuery('')
      setSelected(null)
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
        <div style={{ position: 'relative', flex: 1 }}>
          <input
            type="text"
            value={query}
            onChange={(e) => handleQueryChange(e.target.value)}
            onFocus={() => { if (results.length > 0) setShowDropdown(true) }}
            onBlur={() => setTimeout(() => setShowDropdown(false), 150)}
            placeholder="Search company or ticker (e.g., Apple or AAPL)"
            className="w-full px-3 py-2 bg-gray-700 text-white rounded border border-gray-600"
          />
          {showDropdown && (results.length > 0 || searching) && (
            <div
              style={{
                position: 'absolute',
                top: '100%',
                left: 0,
                right: 0,
                zIndex: 10,
                background: '#1f2937',
                border: '1px solid #4b5563',
                borderRadius: 6,
                marginTop: 2,
                maxHeight: 240,
                overflowY: 'auto'
              }}
            >
              {searching && <div className="text-xs text-gray-400" style={{ padding: '8px 12px' }}>Searching...</div>}
              {!searching && results.map(match => (
                <div
                  key={match.symbol}
                  onMouseDown={() => pickResult(match)}
                  className="cursor-pointer"
                  style={{ padding: '8px 12px', borderBottom: '1px solid #374151' }}
                >
                  <span className="text-white font-bold">{match.symbol}</span>
                  <span className="text-xs text-gray-400 ml-2">{match.description}</span>
                </div>
              ))}
            </div>
          )}
        </div>
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
          disabled={!selected}
          className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700"
          style={{ opacity: selected ? 1 : 0.5 }}
        >
          Add
        </button>
      </div>

      <p className="text-xs text-gray-400 mb-2">Pick a match from the dropdown to add it - prevents typos from following the wrong ticker.</p>

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
