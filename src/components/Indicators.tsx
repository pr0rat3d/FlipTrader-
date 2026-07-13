import React, { useEffect, useMemo, useState } from 'react'
import { useIndicatorSnapshots } from '../hooks/useIndicatorSnapshots'
import { useAuth } from '../hooks/useAuth'
import { getActiveUniverse, getWatchlist } from '../lib/supabase'
import { IndicatorSnapshot } from '../types'
import {
  CHART_WIDTH, CHART_HEIGHT, PAD, COLOR_BULLISH, COLOR_BEARISH, COLOR_MUTED, COLOR_GRID,
  xScale, buildYScale, buildXLabels, timeLabel, fmt, linePath, toHeikinAshi,
  TooltipRow, ChartFrame, LegendItem, CandlestickSeries, OHLCBar
} from './charts/ChartPrimitives'

// Still used for the RSI line and the current-price badge, both independent of the
// candlestick colors above.
const COLOR_CLOSE = '#4ade80'
const COLOR_EMA50 = '#3987e5'
const COLOR_EMA200 = '#c98500'
const COLOR_VWAP = '#9085e9'

interface ChartsProps {
  snapshots: IndicatorSnapshot[]
  xLabels: string[]
}

// Day-trade has many intraday bars per day, where Heikin-Ashi's smoothing is
// meaningful. Swing is deduped to one bar per trading day (see snapshot.ts) - a
// single daily candle per day doesn't benefit from HA smoothing the way a run of
// 5-min bars does, so swing reverts to a plain close-price trend line instead.
const PriceChart: React.FC<ChartsProps & { category: 'day_trade' | 'swing'; hoveredIndex: number | null; onHover: (i: number | null) => void }> = ({ snapshots, xLabels, category, hoveredIndex, onHover }) => {
  const n = snapshots.length
  const closes = snapshots.map(s => s.close_price)
  const ema50s = snapshots.map(s => s.ema_50 ?? NaN)
  const ema200s = snapshots.map(s => s.ema_200 ?? NaN)
  const vwaps = snapshots.map(s => s.vwap ?? NaN)
  const hasVwap = vwaps.some(Number.isFinite)
  const isDayTrade = category === 'day_trade'

  // A snapshot recorded before OHLC capture existed (open_price/high_price/low_price
  // were added later) has no candle - null keeps it index-aligned with everything
  // else rather than shifting later bars out of place.
  const rawBars: Array<OHLCBar | null> = snapshots.map(s =>
    s.open_price !== null && s.high_price !== null && s.low_price !== null
      ? { open: s.open_price, high: s.high_price, low: s.low_price, close: s.close_price }
      : null
  )
  const haBars = useMemo(() => (isDayTrade ? toHeikinAshi(rawBars) : []), [snapshots, isDayTrade])
  const haHighLows = haBars.flatMap(b => (b ? [b.high, b.low] : []))

  const y = buildYScale([...(isDayTrade ? haHighLows : closes), ...ema50s, ...ema200s, ...(hasVwap ? vwaps : [])].filter(Number.isFinite))

  const toPoints = (vals: number[]) => vals.map((v, i) => (Number.isFinite(v) ? { x: xScale(i, n), y: y(v) } : null))

  const last = snapshots[n - 1]
  const hovered = hoveredIndex !== null ? snapshots[hoveredIndex] : last
  const hoveredHA = hoveredIndex !== null ? haBars[hoveredIndex] : haBars[n - 1]
  const haColor = hoveredHA && hoveredHA.close >= hoveredHA.open ? COLOR_BULLISH : COLOR_BEARISH

  const tooltipRows: TooltipRow[] = hoveredIndex !== null && hovered
    ? [
        ...(isDayTrade && hoveredHA
          ? [
              { label: 'O', value: `$${fmt(hoveredHA.open)}`, color: haColor },
              { label: 'H', value: `$${fmt(hoveredHA.high)}`, color: haColor },
              { label: 'L', value: `$${fmt(hoveredHA.low)}`, color: haColor },
              { label: 'C', value: `$${fmt(hoveredHA.close)}`, color: haColor }
            ]
          : [{ label: 'Close', value: `$${fmt(hovered.close_price)}`, color: COLOR_CLOSE }]),
        { label: 'EMA50', value: `$${fmt(hovered.ema_50)}`, color: COLOR_EMA50 },
        { label: 'EMA200', value: `$${fmt(hovered.ema_200)}`, color: COLOR_EMA200 },
        ...(hasVwap ? [{ label: 'VWAP', value: `$${fmt(hovered.vwap)}`, color: COLOR_VWAP }] : [])
      ]
    : []

  const title = isDayTrade
    ? (hasVwap ? 'Heikin-Ashi vs EMA50 / EMA200 / VWAP' : 'Heikin-Ashi vs EMA50 / EMA200')
    : 'Price vs EMA50 / EMA200'

  return (
    <ChartFrame
      title={title}
      hoveredIndex={hoveredIndex}
      onHover={onHover}
      n={n}
      xLabels={xLabels}
      tooltipRows={tooltipRows}
      legend={
        <div className="flex items-center" style={{ flexWrap: 'wrap' }}>
          {isDayTrade
            ? <LegendItem color={haColor} label="HA Close" value={`$${fmt(hoveredHA?.close)}`} />
            : <LegendItem color={COLOR_CLOSE} label="Close" value={`$${fmt(hovered?.close_price)}`} />}
          <LegendItem color={COLOR_EMA50} label="EMA50" value={`$${fmt(hovered?.ema_50)}`} />
          <LegendItem color={COLOR_EMA200} label="EMA200" value={`$${fmt(hovered?.ema_200)}`} />
          {hasVwap && <LegendItem color={COLOR_VWAP} label="VWAP" value={`$${fmt(hovered?.vwap)}`} />}
        </div>
      }
    >
      <text x={PAD} y={PAD + 8} textAnchor="start" fontSize={9} fill={COLOR_MUTED}>${fmt(y.max)}</text>
      <text x={PAD} y={CHART_HEIGHT - PAD - 2} textAnchor="start" fontSize={9} fill={COLOR_MUTED}>${fmt(y.min)}</text>
      {/* Slightly thinner and softened vs. the candles/price line below - EMAs/VWAP
          are supporting context, not the primary visual focus of the chart. */}
      <path d={linePath(toPoints(ema200s))} fill="none" stroke={COLOR_EMA200} strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" opacity={0.85} />
      <path d={linePath(toPoints(ema50s))} fill="none" stroke={COLOR_EMA50} strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" opacity={0.85} />
      {hasVwap && (
        <path d={linePath(toPoints(vwaps))} fill="none" stroke={COLOR_VWAP} strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" opacity={0.85} />
      )}
      {isDayTrade ? (
        <CandlestickSeries bars={haBars} y={y} />
      ) : (
        <>
          <path d={linePath(toPoints(closes))} fill="none" stroke={COLOR_CLOSE} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {n > 0 && Number.isFinite(closes[n - 1]) && (
            <circle cx={xScale(n - 1, n)} cy={y(closes[n - 1])} r={4} fill={COLOR_CLOSE} stroke="#1f2937" strokeWidth={2} />
          )}
        </>
      )}
    </ChartFrame>
  )
}

const RSIChart: React.FC<ChartsProps & { hoveredIndex: number | null; onHover: (i: number | null) => void }> = ({ snapshots, xLabels, hoveredIndex, onHover }) => {
  const n = snapshots.length
  const rsis = snapshots.map(s => s.rsi ?? NaN)
  const y = (v: number) => CHART_HEIGHT - PAD - (v / 100) * (CHART_HEIGHT - PAD * 2)
  const points = rsis.map((v, i) => (Number.isFinite(v) ? { x: xScale(i, n), y: y(v) } : null))

  const last = snapshots[n - 1]
  const hovered = hoveredIndex !== null ? snapshots[hoveredIndex] : last

  const tooltipRows: TooltipRow[] = hoveredIndex !== null && hovered
    ? [{ label: 'RSI', value: fmt(hovered.rsi, 1), color: COLOR_CLOSE }]
    : []

  return (
    <ChartFrame
      title="RSI (14)"
      subtitle="Oversold below 30, overbought above 70"
      hoveredIndex={hoveredIndex}
      onHover={onHover}
      n={n}
      xLabels={xLabels}
      tooltipRows={tooltipRows}
      legend={<span className="text-lg font-bold text-white">{fmt(hovered?.rsi, 1)}</span>}
    >
      <line x1={PAD} x2={CHART_WIDTH - PAD} y1={y(70)} y2={y(70)} stroke={COLOR_GRID} strokeWidth={1} />
      <line x1={PAD} x2={CHART_WIDTH - PAD} y1={y(30)} y2={y(30)} stroke={COLOR_GRID} strokeWidth={1} />
      <text x={PAD} y={y(70) - 3} textAnchor="start" fontSize={9} fill={COLOR_MUTED}>70</text>
      <text x={PAD} y={y(30) - 3} textAnchor="start" fontSize={9} fill={COLOR_MUTED}>30</text>
      <path d={linePath(points)} fill="none" stroke={COLOR_CLOSE} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      {n > 0 && Number.isFinite(rsis[n - 1]) && (
        <circle cx={xScale(n - 1, n)} cy={y(rsis[n - 1])} r={4} fill={COLOR_CLOSE} stroke="#1f2937" strokeWidth={2} />
      )}
    </ChartFrame>
  )
}

const MACDChart: React.FC<ChartsProps & { hoveredIndex: number | null; onHover: (i: number | null) => void }> = ({ snapshots, xLabels, hoveredIndex, onHover }) => {
  const n = snapshots.length
  const hist = snapshots.map(s => s.macd_histogram ?? NaN)
  const finite = hist.filter(Number.isFinite)
  const maxAbs = finite.length ? Math.max(...finite.map(Math.abs)) : 1
  const span = maxAbs || 1
  const zeroY = CHART_HEIGHT / 2
  const y = (v: number) => zeroY - (v / span) * (CHART_HEIGHT / 2 - PAD)

  const barWidth = n > 1 ? Math.min(18, ((CHART_WIDTH - PAD * 2) / n) * 0.6) : 12

  const last = snapshots[n - 1]
  const hovered = hoveredIndex !== null ? snapshots[hoveredIndex] : last
  const hoveredVal = hovered?.macd_histogram ?? null

  const tooltipRows: TooltipRow[] = hoveredIndex !== null && hovered
    ? [{ label: 'Histogram', value: fmt(hovered.macd_histogram, 3), color: (hovered.macd_histogram ?? 0) >= 0 ? COLOR_BULLISH : COLOR_BEARISH }]
    : []

  return (
    <ChartFrame
      title="MACD Histogram"
      subtitle="Crosses zero = bullish/bearish curl"
      hoveredIndex={hoveredIndex}
      onHover={onHover}
      n={n}
      xLabels={xLabels}
      tooltipRows={tooltipRows}
      legend={
        <div className="flex items-center" style={{ gap: 8 }}>
          <div className="flex items-center" style={{ gap: 4 }}>
            <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: COLOR_BULLISH }} />
            <span className="text-xs text-gray-400">Bullish</span>
          </div>
          <div className="flex items-center" style={{ gap: 4 }}>
            <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: COLOR_BEARISH }} />
            <span className="text-xs text-gray-400">Bearish</span>
          </div>
          <span className="text-sm font-bold text-white">{fmt(hoveredVal, 3)}</span>
        </div>
      }
    >
      <line x1={PAD} x2={CHART_WIDTH - PAD} y1={zeroY} y2={zeroY} stroke={COLOR_GRID} strokeWidth={1} />
      <text x={PAD + barWidth + 4} y={PAD + 8} textAnchor="start" fontSize={9} fill={COLOR_MUTED}>{fmt(maxAbs, 3)}</text>
      <text x={PAD + barWidth + 4} y={zeroY - 3} textAnchor="start" fontSize={9} fill={COLOR_MUTED}>0</text>
      <text x={PAD + barWidth + 4} y={CHART_HEIGHT - PAD - 2} textAnchor="start" fontSize={9} fill={COLOR_MUTED}>-{fmt(maxAbs, 3)}</text>
      {hist.map((v, i) => {
        if (!Number.isFinite(v)) return null
        const x = xScale(i, n) - barWidth / 2
        const barY = v >= 0 ? y(v) : zeroY
        const barH = Math.abs(y(v) - zeroY)
        return (
          <rect
            key={i}
            x={x}
            y={barY}
            width={barWidth}
            height={Math.max(barH, 1)}
            rx={2}
            fill={v >= 0 ? COLOR_BULLISH : COLOR_BEARISH}
          />
        )
      })}
    </ChartFrame>
  )
}

export const Indicators: React.FC = () => {
  const { user } = useAuth()
  const [category, setCategory] = useState<'day_trade' | 'swing'>('day_trade')
  const [trackedSymbols, setTrackedSymbols] = useState<string[]>([])
  const [myWatchlist, setMyWatchlist] = useState<string[]>([])
  const [showMyWatchlistOnly, setShowMyWatchlistOnly] = useState(false)
  const [selectedSymbol, setSelectedSymbol] = useState('')
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)
  const [showTable, setShowTable] = useState(false)
  const [symbolsLoading, setSymbolsLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setSymbolsLoading(true)
    getActiveUniverse(category)
      .then(syms => { if (!cancelled) setTrackedSymbols(syms) })
      .catch(console.error)
      .finally(() => { if (!cancelled) setSymbolsLoading(false) })
    return () => { cancelled = true }
  }, [category])

  useEffect(() => {
    if (!user) { setMyWatchlist([]); setShowMyWatchlistOnly(false); return }
    let cancelled = false
    getWatchlist(user.id, category)
      .then(rows => { if (!cancelled) setMyWatchlist((rows || []).map(r => r.symbol)) })
      .catch(console.error)
    return () => { cancelled = true }
  }, [user, category])

  // Followed symbols always show up, even before the cron has scanned them yet -
  // otherwise a user who just added a ticker sees nothing and assumes it's broken.
  const symbols = showMyWatchlistOnly
    ? myWatchlist
    : Array.from(new Set([...trackedSymbols, ...myWatchlist])).sort()

  useEffect(() => {
    if (symbols.length > 0 && !symbols.includes(selectedSymbol)) {
      setSelectedSymbol(symbols[0])
      setHoveredIndex(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbols.join(',')])

  const { snapshots, loading } = useIndicatorSnapshots(selectedSymbol, category)
  const xLabels = useMemo(() => buildXLabels(snapshots.map(s => s.timestamp)), [snapshots])

  const selectCategory = (next: 'day_trade' | 'swing') => {
    setCategory(next)
    setHoveredIndex(null)
  }

  const selectSymbol = (sym: string) => {
    setSelectedSymbol(sym)
    setHoveredIndex(null)
  }

  const tableRows = useMemo(() => [...snapshots].reverse().slice(0, 30), [snapshots])

  // Day-trade only - `snapshots` is already scoped to today for this category
  // (see useIndicatorSnapshots), so this is naturally "today's patterns," no
  // extra date filtering needed here.
  const patternHistory = useMemo(() => {
    if (category !== 'day_trade') return []
    const rows: Array<{ index: number; pattern: string; direction: 'bullish' | 'bearish' | 'neutral'; timestamp: string }> = []
    snapshots.forEach((s, index) => {
      if (s.candlestick_pattern) {
        rows.push({ index, pattern: s.candlestick_pattern, direction: s.candlestick_direction ?? 'neutral', timestamp: s.timestamp })
      }
    })
    return rows
  }, [snapshots, category])

  return (
    <div className="p-4">
      <h2 className="text-2xl font-bold text-white mb-4">Indicators</h2>

      <div className="flex gap-2 mb-3">
        <button
          onClick={() => selectCategory('day_trade')}
          className={`px-3 py-1 rounded text-sm font-bold ${category === 'day_trade' ? 'bg-green-600 text-white' : 'bg-gray-700 text-gray-400'}`}
        >
          Day Trade
        </button>
        <button
          onClick={() => selectCategory('swing')}
          className={`px-3 py-1 rounded text-sm font-bold ${category === 'swing' ? 'bg-green-600 text-white' : 'bg-gray-700 text-gray-400'}`}
        >
          Swing
        </button>
        {user && (
          <label className="flex items-center text-sm text-gray-400 cursor-pointer" style={{ marginLeft: 8 }}>
            <input
              type="checkbox"
              checked={showMyWatchlistOnly}
              onChange={(e) => setShowMyWatchlistOnly(e.target.checked)}
              className="mr-2"
            />
            My Watchlist only
          </label>
        )}
      </div>

      {!symbolsLoading && symbols.length === 0 && (
        <p className="text-gray-400 mb-4">
          {showMyWatchlistOnly
            ? "You haven't followed any tickers in this category yet."
            : 'No symbols tracked in this category yet.'}
        </p>
      )}

      <div className="flex gap-2 mb-4" style={{ flexWrap: 'wrap' }}>
        {symbols.map(sym => (
          <button
            key={sym}
            onClick={() => selectSymbol(sym)}
            title={myWatchlist.includes(sym) ? 'On your watchlist' : undefined}
            className={`px-3 py-1 rounded text-sm font-bold ${selectedSymbol === sym ? 'bg-green-600 text-white' : 'bg-gray-700 text-gray-400'}`}
          >
            {sym}{myWatchlist.includes(sym) && ' ★'}
          </button>
        ))}
      </div>

      {loading && <p className="text-gray-400">Loading indicator history...</p>}

      {!loading && snapshots.length === 0 && selectedSymbol && (
        <p className="text-gray-400">No indicator history yet for {selectedSymbol}. It'll start filling in as cron runs occur.</p>
      )}

      {!loading && snapshots.length > 0 && (
        <>
          <div className="flex justify-between items-center mb-2" style={{ borderBottom: '1px solid #374151', paddingBottom: 8 }}>
            <h3 className="text-xl font-bold text-white">
              {selectedSymbol} <span className="text-sm text-gray-400 font-bold">{category === 'day_trade' ? 'Day Trade' : 'Swing'}</span>
            </h3>
            <span className="text-lg font-bold" style={{ color: COLOR_CLOSE }}>${fmt(snapshots[snapshots.length - 1]?.close_price)}</span>
          </div>
          {category === 'day_trade' ? (
            patternHistory.length > 0 && (
              <div className="mb-3" style={{ overflowX: 'auto', whiteSpace: 'nowrap', paddingBottom: 4 }}>
                {patternHistory.map(p => {
                  const color = p.direction === 'bullish' ? COLOR_BULLISH : p.direction === 'bearish' ? COLOR_BEARISH : COLOR_MUTED
                  const isSelected = hoveredIndex === p.index
                  return (
                    <button
                      key={`${p.index}-${p.timestamp}`}
                      onClick={() => setHoveredIndex(p.index)}
                      className="text-xs font-bold rounded"
                      style={{
                        display: 'inline-block',
                        marginRight: 6,
                        padding: '4px 8px',
                        background: isSelected ? color : '#1f2937',
                        border: `1px solid ${color}`,
                        color: isSelected ? '#1f2937' : color
                      }}
                    >
                      🕯️ {timeLabel(p.timestamp)} {p.pattern}
                    </button>
                  )
                })}
              </div>
            )
          ) : (
            snapshots[snapshots.length - 1]?.candlestick_pattern && (() => {
              const latest = snapshots[snapshots.length - 1]
              const color = latest.candlestick_direction === 'bullish' ? COLOR_BULLISH
                : latest.candlestick_direction === 'bearish' ? COLOR_BEARISH
                : COLOR_MUTED
              return (
                <div className="mb-3 p-2 rounded text-sm font-bold" style={{ background: '#1f2937', border: `1px solid ${color}`, color }}>
                  🕯️ {latest.candlestick_pattern}{latest.candlestick_direction !== 'neutral' && ` (${latest.candlestick_direction})`}
                </div>
              )
            })()
          )}
          <PriceChart snapshots={snapshots} xLabels={xLabels} category={category} hoveredIndex={hoveredIndex} onHover={setHoveredIndex} />
          <RSIChart snapshots={snapshots} xLabels={xLabels} hoveredIndex={hoveredIndex} onHover={setHoveredIndex} />
          <MACDChart snapshots={snapshots} xLabels={xLabels} hoveredIndex={hoveredIndex} onHover={setHoveredIndex} />

          {hoveredIndex !== null && snapshots[hoveredIndex] && (
            <p className="text-xs text-gray-400 mb-3">{timeLabel(snapshots[hoveredIndex].timestamp)}</p>
          )}

          <button
            onClick={() => setShowTable(v => !v)}
            className="px-3 py-1 bg-gray-700 text-gray-400 rounded text-sm mb-3"
          >
            {showTable ? 'Hide' : 'Show'} data table
          </button>

          {showTable && (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    {['Time', 'Close', 'RSI', 'MACD Hist', 'EMA50', 'EMA200', 'VWAP', 'Pattern'].map(h => (
                      <th key={h} className="text-xs text-gray-400" style={{ textAlign: 'left', padding: '4px 8px', borderBottom: '1px solid #374151' }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {tableRows.map(row => (
                    <tr key={row.id}>
                      <td className="text-xs text-white" style={{ padding: '4px 8px' }}>{timeLabel(row.timestamp)}</td>
                      <td className="text-xs text-white" style={{ padding: '4px 8px' }}>${fmt(row.close_price)}</td>
                      <td className="text-xs text-white" style={{ padding: '4px 8px' }}>{fmt(row.rsi, 1)}</td>
                      <td className="text-xs text-white" style={{ padding: '4px 8px' }}>{fmt(row.macd_histogram, 3)}</td>
                      <td className="text-xs text-white" style={{ padding: '4px 8px' }}>${fmt(row.ema_50)}</td>
                      <td className="text-xs text-white" style={{ padding: '4px 8px' }}>${fmt(row.ema_200)}</td>
                      <td className="text-xs text-white" style={{ padding: '4px 8px' }}>{row.vwap !== null ? `$${fmt(row.vwap)}` : '—'}</td>
                      <td
                        className="text-xs font-bold"
                        style={{
                          padding: '4px 8px',
                          color: row.candlestick_direction === 'bullish' ? COLOR_BULLISH
                            : row.candlestick_direction === 'bearish' ? COLOR_BEARISH
                            : COLOR_MUTED
                        }}
                      >
                        {row.candlestick_pattern ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}
