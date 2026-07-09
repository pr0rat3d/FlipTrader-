import React from 'react'

// Shared SVG chart building blocks, extracted from Indicators.tsx so new chart
// pages (e.g. Performance) don't duplicate this plumbing.

// This app's existing bullish/bearish convention (AlertCard.tsx) - kept for consistency
export const COLOR_BULLISH = '#4ade80'
export const COLOR_BEARISH = '#f87171'
export const COLOR_MUTED = '#898781'
export const COLOR_GRID = '#374151'

export const CHART_WIDTH = 600
export const CHART_HEIGHT = 90
export const AXIS_HEIGHT = 16
export const PAD = 8

export const xScale = (i: number, n: number) =>
  n <= 1 ? CHART_WIDTH / 2 : (i / (n - 1)) * (CHART_WIDTH - PAD * 2) + PAD

export const buildYScale = (values: number[]) => {
  const finite = values.filter(v => Number.isFinite(v))
  const min = finite.length ? Math.min(...finite) : 0
  const max = finite.length ? Math.max(...finite) : 1
  const span = max - min || 1
  const scale = (v: number) => CHART_HEIGHT - PAD - ((v - min) / span) * (CHART_HEIGHT - PAD * 2)
  return Object.assign(scale, { min, max })
}

// Picks ~count evenly spaced indices (always including first and last) for x-axis ticks
export const pickTickIndices = (n: number, count: number): number[] => {
  if (n <= 0) return []
  if (n <= count) return Array.from({ length: n }, (_, i) => i)
  const step = (n - 1) / (count - 1)
  return Array.from({ length: count }, (_, i) => Math.round(i * step))
}

// Same-day data shows time-of-day; data spanning multiple days shows the date
// instead - same axis, different granularity depending on what's being charted.
export const buildXLabels = (timestamps: string[]): string[] => {
  if (timestamps.length === 0) return []
  const first = new Date(timestamps[0])
  const last = new Date(timestamps[timestamps.length - 1])
  const sameDay = first.toDateString() === last.toDateString()

  return timestamps.map(t => {
    const d = new Date(t)
    return sameDay
      ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
      : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  })
}

export const timeLabel = (iso: string) => {
  const d = new Date(iso)
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export const fmt = (v: number | null | undefined, digits = 2) =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(digits)

export const linePath = (points: Array<{ x: number; y: number } | null>): string => {
  let d = ''
  let started = false
  for (const p of points) {
    if (!p) { started = false; continue }
    d += (started ? ' L ' : 'M ') + p.x.toFixed(1) + ' ' + p.y.toFixed(1)
    started = true
  }
  return d
}

export interface OHLCBar {
  open: number
  high: number
  low: number
  close: number
}

// Heikin-Ashi smoothing: each bar folds in the previous HA bar's open/close, so the
// chain must be walked in chronological order from the first bar in view - it can't
// be computed per-bar independently like a regular candle. A null entry (a snapshot
// recorded before OHLC capture existed, or a genuine data gap) breaks the chain -
// the next real bar restarts it rather than chaining across the gap.
export const toHeikinAshi = (bars: Array<OHLCBar | null>): Array<OHLCBar | null> => {
  const result: Array<OHLCBar | null> = []
  let prevHA: OHLCBar | null = null
  for (const bar of bars) {
    if (!bar) { result.push(null); prevHA = null; continue }
    const haClose: number = (bar.open + bar.high + bar.low + bar.close) / 4
    const haOpen: number = prevHA ? (prevHA.open + prevHA.close) / 2 : (bar.open + bar.close) / 2
    const haHigh: number = Math.max(bar.high, haOpen, haClose)
    const haLow: number = Math.min(bar.low, haOpen, haClose)
    const haBar: OHLCBar = { open: haOpen, high: haHigh, low: haLow, close: haClose }
    result.push(haBar)
    prevHA = haBar
  }
  return result
}

export interface TooltipRow {
  label: string
  value: string
  color: string
}

export const HoverTooltip: React.FC<{ x: number; timeLabel: string; rows: TooltipRow[] }> = ({ x, timeLabel, rows }) => {
  const width = 118
  const rowHeight = 11
  const height = 14 + rows.length * rowHeight
  const flip = x > CHART_WIDTH - width - 14
  const boxX = flip ? x - width - 8 : x + 8
  const boxY = 2

  return (
    <g pointerEvents="none">
      <rect x={boxX} y={boxY} width={width} height={height} rx={4} fill="#111827" stroke="#374151" strokeWidth={1} />
      <text x={boxX + 6} y={boxY + 11} fontSize={9} fontWeight="bold" fill="#c3c2b7">{timeLabel}</text>
      {rows.map((row, i) => (
        <text key={row.label} x={boxX + 6} y={boxY + 11 + (i + 1) * rowHeight} fontSize={9}>
          <tspan fill={row.color}>● </tspan>
          <tspan fill="#c3c2b7">{row.label} </tspan>
          <tspan fill="#ffffff" fontWeight="bold">{row.value}</tspan>
        </text>
      ))}
    </g>
  )
}

export interface ChartFrameProps {
  title: string
  subtitle?: string
  hoveredIndex: number | null
  onHover: (i: number | null) => void
  n: number
  xLabels: string[]
  tooltipRows?: TooltipRow[]
  children: React.ReactNode
  legend?: React.ReactNode
}

export const ChartFrame: React.FC<ChartFrameProps> = ({ title, subtitle, hoveredIndex, onHover, n, xLabels, tooltipRows, children, legend }) => {
  const handleMove = (e: React.PointerEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const relX = ((e.clientX - rect.left) / rect.width) * CHART_WIDTH
    if (n <= 1) { onHover(0); return }
    const step = (CHART_WIDTH - PAD * 2) / (n - 1)
    const idx = Math.round((relX - PAD) / step)
    onHover(Math.min(n - 1, Math.max(0, idx)))
  }

  const tickIndices = pickTickIndices(n, 4)

  return (
    <div className="p-2 bg-gray-800 rounded mb-2">
      <div className="flex justify-between items-center mb-1">
        <div>
          <p className="text-xs font-bold text-white">{title}</p>
          {subtitle && <p className="text-xs text-gray-400">{subtitle}</p>}
        </div>
        {legend}
      </div>
      <svg
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT + AXIS_HEIGHT}`}
        style={{ width: '100%', height: 'auto', display: 'block' }}
      >
        {/* SVG only fires pointer events on painted areas by default - most of a line
            chart's area is empty space between thin strokes, so without this the
            crosshair/tooltip would only trigger when the cursor lands exactly on a line. */}
        <rect
          x={0} y={0} width={CHART_WIDTH} height={CHART_HEIGHT}
          fill="transparent"
          onPointerMove={handleMove}
          onPointerLeave={() => onHover(null)}
        />
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
        <line x1={PAD} x2={CHART_WIDTH - PAD} y1={CHART_HEIGHT} y2={CHART_HEIGHT} stroke={COLOR_GRID} strokeWidth={1} />
        {tickIndices.map((idx, k) => (
          <text
            key={idx}
            x={xScale(idx, n)}
            y={CHART_HEIGHT + 13}
            textAnchor={k === 0 ? 'start' : k === tickIndices.length - 1 ? 'end' : 'middle'}
            fontSize={9}
            fill={COLOR_MUTED}
          >
            {xLabels[idx]}
          </text>
        ))}
        {hoveredIndex !== null && n > 0 && tooltipRows && (
          <HoverTooltip x={xScale(hoveredIndex, n)} timeLabel={xLabels[hoveredIndex]} rows={tooltipRows} />
        )}
      </svg>
    </div>
  )
}

// One wick + body per bar. `bars` is index-aligned with the chart's full n (a null
// entry - e.g. a snapshot recorded before OHLC capture existed - simply renders no
// candle at that x position, same convention as linePath's gap handling).
export const CandlestickSeries: React.FC<{ bars: Array<OHLCBar | null>; y: (v: number) => number }> = ({ bars, y }) => {
  const n = bars.length
  const barWidth = n > 1 ? Math.min(14, ((CHART_WIDTH - PAD * 2) / n) * 0.6) : 10

  return (
    <>
      {bars.map((bar, i) => {
        if (!bar) return null
        const x = xScale(i, n)
        const color = bar.close >= bar.open ? COLOR_BULLISH : COLOR_BEARISH
        const bodyTop = y(Math.max(bar.open, bar.close))
        const bodyBottom = y(Math.min(bar.open, bar.close))
        return (
          <g key={i}>
            <line x1={x} x2={x} y1={y(bar.high)} y2={y(bar.low)} stroke={color} strokeWidth={1} />
            <rect
              x={x - barWidth / 2}
              y={bodyTop}
              width={barWidth}
              height={Math.max(bodyBottom - bodyTop, 1)}
              fill={color}
            />
          </g>
        )
      })}
    </>
  )
}

export const LegendItem: React.FC<{ color: string; label: string; value: string }> = ({ color, label, value }) => (
  <div className="flex items-center" style={{ gap: 4, marginLeft: 10 }}>
    <span style={{ display: 'inline-block', width: 10, height: 2, background: color }} />
    <span className="text-xs text-gray-400">{label}</span>
    <span className="text-xs text-white font-bold">{value}</span>
  </div>
)
