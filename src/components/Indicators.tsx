import React, { useMemo, useState } from 'react'
import { useIndicatorSnapshots } from '../hooks/useIndicatorSnapshots'
import { IndicatorSnapshot } from '../types'

const DAY_TRADE_SYMBOLS = ['SPY', 'QQQ', 'IWM']
const SWING_SYMBOLS = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'TSLA', 'META', 'NFLX']

// Dark-mode categorical slots, validated against this app's card surface (#1f2937)
const COLOR_CLOSE = '#3987e5'
const COLOR_EMA50 = '#199e70'
const COLOR_EMA200 = '#c98500'
// This app's existing bullish/bearish convention (AlertCard.tsx) - kept for consistency
const COLOR_BULLISH = '#4ade80'
const COLOR_BEARISH = '#f87171'
const COLOR_MUTED = '#898781'
const COLOR_GRID = '#374151'

const CHART_WIDTH = 600
const CHART_HEIGHT = 140
const PAD = 10

const xScale = (i: number, n: number) => (n <= 1 ? CHART_WIDTH / 2 : (i / (n - 1)) * (CHART_WIDTH - PAD * 2) + PAD)

const buildYScale = (values: number[]) => {
  const finite = values.filter(v => Number.isFinite(v))
  const min = finite.length ? Math.min(...finite) : 0
  const max = finite.length ? Math.max(...finite) : 1
  const span = max - min || 1
  return (v: number) => CHART_HEIGHT - PAD - ((v - min) / span) * (CHART_HEIGHT - PAD * 2)
}

const linePath = (points: Array<{ x: number; y: number } | null>): string => {
  let d = ''
  let started = false
  for (const p of points) {
    if (!p) { started = false; continue }
    d += (started ? ' L ' : 'M ') + p.x.toFixed(1) + ' ' + p.y.toFixed(1)
    started = true
  }
  return d
}

interface ChartFrameProps {
  title: string
  subtitle?: string
  hoveredIndex: number | null
  onHover: (i: number | null) => void
  n: number
  children: React.ReactNode
  legend?: React.ReactNode
}

const ChartFrame: React.FC<ChartFrameProps> = ({ title, subtitle, hoveredIndex, onHover, n, children, legend }) => {
  const handleMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const relX = ((e.clientX - rect.left) / rect.width) * CHART_WIDTH
    if (n <= 1) { onHover(0); return }
    const step = (CHART_WIDTH - PAD * 2) / (n - 1)
    const idx = Math.round((relX - PAD) / step)
    onHover(Math.min(n - 1, Math.max(0, idx)))
  }

  return (
    <div className="p-3 bg-gray-800 rounded mb-3">
      <div className="flex justify-between items-center mb-2">
        <div>
          <p className="text-sm font-bold text-white">{title}</p>
          {subtitle && <p className="text-xs text-gray-400">{subtitle}</p>}
        </div>
        {legend}
      </div>
      <svg
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
        style={{ width: '100%', height: 'auto', display: 'block' }}
        onPointerMove={handleMove}
        onPointerLeave={() => onHover(null)}
      >
        {children}
        {hoveredIndex !== null && n > 0 && (
          <line
            x1={xScale(hoveredIndex, n)}
            x2={xScale(hoveredIndex, n)}
            y1={0}
            y2={CHART_HEIGHT}
            stroke={COLOR_MUTED}
            strokeWidth={1}
          />
        )}
      </svg>
    </div>
  )
}

const LegendItem: React.FC<{ color: string; label: string; value: string }> = ({ color, label, value }) => (
  <div className="flex items-center" style={{ gap: 4, marginLeft: 10 }}>
    <span style={{ display: 'inline-block', width: 10, height: 2, background: color }} />
    <span className="text-xs text-gray-400">{label}</span>
    <span className="text-xs text-white font-bold">{value}</span>
  </div>
)

const fmt = (v: number | null | undefined, digits = 2) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(digits))

interface ChartsProps {
  snapshots: IndicatorSnapshot[]
}

const PriceChart: React.FC<ChartsProps & { hoveredIndex: number | null; onHover: (i: number | null) => void }> = ({ snapshots, hoveredIndex, onHover }) => {
  const n = snapshots.length
  const closes = snapshots.map(s => s.close_price)
  const ema50s = snapshots.map(s => s.ema_50 ?? NaN)
  const ema200s = snapshots.map(s => s.ema_200 ?? NaN)
  const y = buildYScale([...closes, ...ema50s, ...ema200s].filter(Number.isFinite))

  const toPoints = (vals: number[]) => vals.map((v, i) => (Number.isFinite(v) ? { x: xScale(i, n), y: y(v) } : null))

  const last = snapshots[n - 1]
  const hovered = hoveredIndex !== null ? snapshots[hoveredIndex] : last

  return (
    <ChartFrame
      title="Price vs EMA50 / EMA200"
      hoveredIndex={hoveredIndex}
      onHover={onHover}
      n={n}
      legend={
        <div className="flex items-center">
          <LegendItem color={COLOR_CLOSE} label="Close" value={`$${fmt(hovered?.close_price)}`} />
          <LegendItem color={COLOR_EMA50} label="EMA50" value={`$${fmt(hovered?.ema_50)}`} />
          <LegendItem color={COLOR_EMA200} label="EMA200" value={`$${fmt(hovered?.ema_200)}`} />
        </div>
      }
    >
      <path d={linePath(toPoints(ema200s))} fill="none" stroke={COLOR_EMA200} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      <path d={linePath(toPoints(ema50s))} fill="none" stroke={COLOR_EMA50} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      <path d={linePath(toPoints(closes))} fill="none" stroke={COLOR_CLOSE} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      {n > 0 && Number.isFinite(closes[n - 1]) && (
        <circle cx={xScale(n - 1, n)} cy={y(closes[n - 1])} r={4} fill={COLOR_CLOSE} stroke="#1f2937" strokeWidth={2} />
      )}
    </ChartFrame>
  )
}

const RSIChart: React.FC<ChartsProps & { hoveredIndex: number | null; onHover: (i: number | null) => void }> = ({ snapshots, hoveredIndex, onHover }) => {
  const n = snapshots.length
  const rsis = snapshots.map(s => s.rsi ?? NaN)
  const y = (v: number) => CHART_HEIGHT - PAD - (v / 100) * (CHART_HEIGHT - PAD * 2)
  const points = rsis.map((v, i) => (Number.isFinite(v) ? { x: xScale(i, n), y: y(v) } : null))

  const last = snapshots[n - 1]
  const hovered = hoveredIndex !== null ? snapshots[hoveredIndex] : last

  return (
    <ChartFrame
      title="RSI (14)"
      subtitle="Oversold below 30, overbought above 70"
      hoveredIndex={hoveredIndex}
      onHover={onHover}
      n={n}
      legend={<span className="text-lg font-bold text-white">{fmt(hovered?.rsi, 1)}</span>}
    >
      <line x1={PAD} x2={CHART_WIDTH - PAD} y1={y(70)} y2={y(70)} stroke={COLOR_GRID} strokeWidth={1} />
      <line x1={PAD} x2={CHART_WIDTH - PAD} y1={y(30)} y2={y(30)} stroke={COLOR_GRID} strokeWidth={1} />
      <text x={CHART_WIDTH - PAD} y={y(70) - 3} textAnchor="end" fontSize={9} fill={COLOR_MUTED}>70</text>
      <text x={CHART_WIDTH - PAD} y={y(30) - 3} textAnchor="end" fontSize={9} fill={COLOR_MUTED}>30</text>
      <path d={linePath(points)} fill="none" stroke={COLOR_CLOSE} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      {n > 0 && Number.isFinite(rsis[n - 1]) && (
        <circle cx={xScale(n - 1, n)} cy={y(rsis[n - 1])} r={4} fill={COLOR_CLOSE} stroke="#1f2937" strokeWidth={2} />
      )}
    </ChartFrame>
  )
}

const MACDChart: React.FC<ChartsProps & { hoveredIndex: number | null; onHover: (i: number | null) => void }> = ({ snapshots, hoveredIndex, onHover }) => {
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

  return (
    <ChartFrame
      title="MACD Histogram"
      subtitle="Crosses zero = bullish/bearish curl"
      hoveredIndex={hoveredIndex}
      onHover={onHover}
      n={n}
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

const timeLabel = (iso: string) => {
  const d = new Date(iso)
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export const Indicators: React.FC = () => {
  const [category, setCategory] = useState<'day_trade' | 'swing'>('day_trade')
  const symbols = category === 'day_trade' ? DAY_TRADE_SYMBOLS : SWING_SYMBOLS
  const [selectedSymbol, setSelectedSymbol] = useState(symbols[0])
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)
  const [showTable, setShowTable] = useState(false)

  const { snapshots, loading } = useIndicatorSnapshots(selectedSymbol)

  const selectCategory = (next: 'day_trade' | 'swing') => {
    setCategory(next)
    const nextSymbols = next === 'day_trade' ? DAY_TRADE_SYMBOLS : SWING_SYMBOLS
    setSelectedSymbol(nextSymbols[0])
    setHoveredIndex(null)
  }

  const selectSymbol = (sym: string) => {
    setSelectedSymbol(sym)
    setHoveredIndex(null)
  }

  const tableRows = useMemo(() => [...snapshots].reverse().slice(0, 30), [snapshots])

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
      </div>

      <div className="flex gap-2 mb-4" style={{ flexWrap: 'wrap' }}>
        {symbols.map(sym => (
          <button
            key={sym}
            onClick={() => selectSymbol(sym)}
            className={`px-3 py-1 rounded text-sm font-bold ${selectedSymbol === sym ? 'bg-green-600 text-white' : 'bg-gray-700 text-gray-400'}`}
          >
            {sym}
          </button>
        ))}
      </div>

      {loading && <p className="text-gray-400">Loading indicator history...</p>}

      {!loading && snapshots.length === 0 && (
        <p className="text-gray-400">No indicator history yet for {selectedSymbol}. It'll start filling in as cron runs occur.</p>
      )}

      {!loading && snapshots.length > 0 && (
        <>
          <PriceChart snapshots={snapshots} hoveredIndex={hoveredIndex} onHover={setHoveredIndex} />
          <RSIChart snapshots={snapshots} hoveredIndex={hoveredIndex} onHover={setHoveredIndex} />
          <MACDChart snapshots={snapshots} hoveredIndex={hoveredIndex} onHover={setHoveredIndex} />

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
                    {['Time', 'Close', 'RSI', 'MACD Hist', 'EMA50', 'EMA200'].map(h => (
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
