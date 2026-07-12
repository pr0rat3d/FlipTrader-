import React, { useEffect, useMemo, useState } from 'react'
import { getActiveUniverse, getRecentSwingSnapshots, getDailyLevelsForSymbols, getSectorUniverse } from '../lib/supabase'
import { IndicatorSnapshot, DailyLevel, SectorUniverseRow } from '../types'

// Thresholds below which a symbol doesn't clear the bar for showing up in a
// section at all - tune freely, nothing downstream depends on these exact values.
const GAP_THRESHOLD_PCT = 1
const RVOL_THRESHOLD = 1.5
// How many trading days back to compare for relative strength - a swing-
// appropriate window (noisier at 1 day, too slow at 20).
const RELATIVE_STRENGTH_LOOKBACK_DAYS = 5

interface GapRow {
  symbol: string
  gapPct: number
  fillProgressPct: number | null
}

interface MoverRow {
  symbol: string
  rvol: number
}

interface SectorRow {
  symbol: string
  sector: string
  changePct: number
  sectorAvgPct: number
  relStrength: number
}

const useScannerData = () => {
  const [symbols, setSymbols] = useState<string[]>([])
  const [snapshots, setSnapshots] = useState<IndicatorSnapshot[]>([])
  const [levels, setLevels] = useState<DailyLevel[]>([])
  const [sectors, setSectors] = useState<SectorUniverseRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const syms = await getActiveUniverse('swing')
        if (cancelled) return
        setSymbols(syms)

        const [snapData, levelData, sectorData] = await Promise.all([
          getRecentSwingSnapshots(syms),
          getDailyLevelsForSymbols(syms),
          getSectorUniverse()
        ])
        if (cancelled) return
        setSnapshots(snapData || [])
        setLevels(levelData || [])
        setSectors(sectorData || [])
      } catch (error) {
        console.error('Error loading scanner data:', error)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [])

  return { symbols, snapshots, levels, sectors, loading }
}

const GapScannerSection: React.FC<{ rows: GapRow[] }> = ({ rows }) => (
  <div className="p-3 bg-gray-800 rounded mb-3">
    <h3 className="text-sm font-bold text-white mb-1">Gap Scanner</h3>
    <p className="text-xs text-gray-400 mb-2">Today's open vs. yesterday's close, ≥{GAP_THRESHOLD_PCT}%</p>
    {rows.length === 0 ? (
      <p className="text-xs text-gray-400">No notable gaps right now.</p>
    ) : (
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              {['Symbol', 'Gap', 'Fill Progress'].map(h => (
                <th key={h} className="text-xs text-gray-400" style={{ textAlign: 'left', padding: '4px 8px', borderBottom: '1px solid #374151' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr key={row.symbol}>
                <td className="text-xs text-white font-bold" style={{ padding: '4px 8px' }}>{row.symbol}</td>
                <td className={`text-xs font-bold`} style={{ padding: '4px 8px', color: row.gapPct > 0 ? '#4ade80' : '#f87171' }}>
                  {row.gapPct > 0 ? '+' : ''}{row.gapPct.toFixed(1)}%
                </td>
                <td className="text-xs text-white" style={{ padding: '4px 8px' }}>
                  {row.fillProgressPct !== null ? `${row.fillProgressPct.toFixed(0)}% filled` : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )}
  </div>
)

const MoversSection: React.FC<{ rows: MoverRow[] }> = ({ rows }) => (
  <div className="p-3 bg-gray-800 rounded mb-3">
    <h3 className="text-sm font-bold text-white mb-1">Movers (RVOL)</h3>
    <p className="text-xs text-gray-400 mb-2">Today's volume vs. 20-day average, ≥{RVOL_THRESHOLD}x - "in play" candidates</p>
    {rows.length === 0 ? (
      <p className="text-xs text-gray-400">Nothing trading at unusual volume right now.</p>
    ) : (
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              {['Symbol', 'RVOL'].map(h => (
                <th key={h} className="text-xs text-gray-400" style={{ textAlign: 'left', padding: '4px 8px', borderBottom: '1px solid #374151' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr key={row.symbol}>
                <td className="text-xs text-white font-bold" style={{ padding: '4px 8px' }}>{row.symbol}</td>
                <td className="text-xs font-bold text-white" style={{ padding: '4px 8px' }}>{row.rvol.toFixed(1)}x</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )}
  </div>
)

const SectorLeadersSection: React.FC<{ rows: SectorRow[] }> = ({ rows }) => {
  const leaders = rows.slice(0, 5)
  const laggards = [...rows].reverse().slice(0, 5)

  const renderTable = (title: string, items: SectorRow[]) => (
    <div style={{ overflowX: 'auto' }}>
      <p className="text-xs text-gray-400 mb-1">{title}</p>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {['Symbol', 'Sector', 'Change', 'Sector Avg', 'Rel. Strength'].map(h => (
              <th key={h} className="text-xs text-gray-400" style={{ textAlign: 'left', padding: '4px 8px', borderBottom: '1px solid #374151' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map(row => (
            <tr key={row.symbol}>
              <td className="text-xs text-white font-bold" style={{ padding: '4px 8px' }}>{row.symbol}</td>
              <td className="text-xs text-gray-400" style={{ padding: '4px 8px' }}>{row.sector}</td>
              <td className={`text-xs font-bold`} style={{ padding: '4px 8px', color: row.changePct >= 0 ? '#4ade80' : '#f87171' }}>
                {row.changePct >= 0 ? '+' : ''}{row.changePct.toFixed(1)}%
              </td>
              <td className="text-xs text-gray-400" style={{ padding: '4px 8px' }}>{row.sectorAvgPct.toFixed(1)}%</td>
              <td className={`text-xs font-bold`} style={{ padding: '4px 8px', color: row.relStrength >= 0 ? '#4ade80' : '#f87171' }}>
                {row.relStrength >= 0 ? '+' : ''}{row.relStrength.toFixed(1)}%
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )

  return (
    <div className="p-3 bg-gray-800 rounded mb-3">
      <h3 className="text-sm font-bold text-white mb-1">Sector Leaders</h3>
      <p className="text-xs text-gray-400 mb-2">{RELATIVE_STRENGTH_LOOKBACK_DAYS}-day % change vs. each stock's own sector average</p>
      {rows.length === 0 ? (
        <p className="text-xs text-gray-400">Not enough history yet to compare - fills in as more days of data accumulate.</p>
      ) : (
        <div className="space-y-3">
          {renderTable('Leading their sector', leaders)}
          {renderTable('Lagging their sector', laggards)}
        </div>
      )}
    </div>
  )
}

export const Scanner: React.FC = () => {
  const { symbols, snapshots, levels, sectors, loading } = useScannerData()

  const snapshotsBySymbol = useMemo(() => {
    const map = new Map<string, IndicatorSnapshot[]>()
    for (const s of snapshots) {
      const arr = map.get(s.symbol) || []
      arr.push(s)
      map.set(s.symbol, arr)
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    }
    return map
  }, [snapshots])

  const levelsBySymbol = useMemo(() => {
    const map = new Map<string, DailyLevel>()
    for (const l of levels) map.set(l.symbol, l)
    return map
  }, [levels])

  const sectorBySymbol = useMemo(() => {
    const map = new Map<string, string>()
    for (const s of sectors) map.set(s.symbol, s.sector)
    return map
  }, [sectors])

  const gapRows: GapRow[] = useMemo(() => {
    const rows: GapRow[] = []
    for (const symbol of symbols) {
      const latest = snapshotsBySymbol.get(symbol)?.[0]
      const level = levelsBySymbol.get(symbol)
      if (!latest || !level || latest.open_price === null || level.pdc === 0) continue

      const gapPct = ((latest.open_price - level.pdc) / level.pdc) * 100
      if (Math.abs(gapPct) < GAP_THRESHOLD_PCT) continue

      const totalGap = latest.open_price - level.pdc
      const filledSoFar = latest.open_price - latest.close_price
      const fillProgressPct = totalGap !== 0
        ? Math.max(0, Math.min(100, (filledSoFar / totalGap) * 100))
        : null

      rows.push({ symbol, gapPct, fillProgressPct })
    }
    return rows.sort((a, b) => Math.abs(b.gapPct) - Math.abs(a.gapPct))
  }, [symbols, snapshotsBySymbol, levelsBySymbol])

  const moverRows: MoverRow[] = useMemo(() => {
    const rows: MoverRow[] = []
    for (const symbol of symbols) {
      const latest = snapshotsBySymbol.get(symbol)?.[0]
      const level = levelsBySymbol.get(symbol)
      if (!latest || !level || latest.volume === null || !level.avg_volume_20d) continue

      const rvol = latest.volume / level.avg_volume_20d
      if (rvol < RVOL_THRESHOLD) continue

      rows.push({ symbol, rvol })
    }
    return rows.sort((a, b) => b.rvol - a.rvol)
  }, [symbols, snapshotsBySymbol, levelsBySymbol])

  const sectorRows: SectorRow[] = useMemo(() => {
    const changes = new Map<string, number>()
    for (const symbol of symbols) {
      const history = snapshotsBySymbol.get(symbol)
      if (!history || history.length < 2) continue

      const latest = history[0]
      const pastIndex = Math.min(RELATIVE_STRENGTH_LOOKBACK_DAYS, history.length - 1)
      const past = history[pastIndex]
      if (past.close_price === 0) continue

      changes.set(symbol, ((latest.close_price - past.close_price) / past.close_price) * 100)
    }

    const bySector = new Map<string, number[]>()
    for (const [symbol, change] of changes) {
      const sector = sectorBySymbol.get(symbol)
      if (!sector) continue
      const arr = bySector.get(sector) || []
      arr.push(change)
      bySector.set(sector, arr)
    }

    const sectorAvg = new Map<string, number>()
    for (const [sector, arr] of bySector) {
      sectorAvg.set(sector, arr.reduce((a, b) => a + b, 0) / arr.length)
    }

    const rows: SectorRow[] = []
    for (const [symbol, change] of changes) {
      const sector = sectorBySymbol.get(symbol)
      if (!sector) continue
      const avg = sectorAvg.get(sector)!
      rows.push({ symbol, sector, changePct: change, sectorAvgPct: avg, relStrength: change - avg })
    }
    return rows.sort((a, b) => b.relStrength - a.relStrength)
  }, [symbols, snapshotsBySymbol, sectorBySymbol])

  return (
    <div className="p-4">
      <h2 className="text-2xl font-bold text-white mb-2">Scanner</h2>
      <p className="text-xs text-gray-400 mb-4">
        Discovery tools across the swing universe - gaps waiting to fill, stocks
        trading at unusual volume, and stocks leading or lagging their own sector.
        {' '}Real bid/ask spread isn't available on the free data tier this app uses,
        so RVOL (relative volume) stands in as the practical "is this worth trading"
        signal instead.
      </p>

      {loading && <p className="text-gray-400">Loading scanner data...</p>}

      {!loading && (
        <>
          <GapScannerSection rows={gapRows} />
          <MoversSection rows={moverRows} />
          <SectorLeadersSection rows={sectorRows} />
        </>
      )}
    </div>
  )
}
