import { writeFileSync } from 'fs'
import { Resvg } from '@resvg/resvg-js'
import { Attempt, DayFlags } from './engine.js'
import { SymbolSeries } from './candles.js'

const W = 1000
const H = 520
const PAD = { l: 60, r: 20, t: 40, b: 30 }

const fmtTime = (ms: number) =>
  new Date(ms).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false })

// One trade: real 1m candles, EMA50 (HA), the trendline used at entry,
// confirmed swing points for the trade's direction, entry/exit markers.
export const renderAttemptPng = (a: Attempt, f: DayFlags, s: SymbolSeries, file: string) => {
  const from = Math.max(0, a.entryIdx - 60)
  const to = Math.min(f.n - 1, a.exitIdx + 15)
  const idx = Array.from({ length: to - from + 1 }, (_, k) => from + k)
  const bars = idx.map(i => s.bars[f.start + i])
  const ema = idx.map(i => s.ema50[f.start + i])
  const eng = f.engines[a.direction]

  const prices = bars.flatMap(b => [b.high, b.low]).concat(ema.filter(Number.isFinite), [a.initialStop])
  const lo = Math.min(...prices)
  const hi = Math.max(...prices)
  const x = (i: number) => PAD.l + ((i - from + 0.5) / idx.length) * (W - PAD.l - PAD.r)
  const y = (p: number) => PAD.t + (1 - (p - lo) / (hi - lo || 1)) * (H - PAD.t - PAD.b)
  const cw = Math.max(1, ((W - PAD.l - PAD.r) / idx.length) * 0.6)

  const parts: string[] = []
  parts.push(`<rect width="${W}" height="${H}" fill="#ffffff"/>`)
  for (let k = 0; k <= 5; k++) {
    const p = lo + ((hi - lo) * k) / 5
    parts.push(`<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(p)}" y2="${y(p)}" stroke="#eee"/>`)
    parts.push(`<text x="${PAD.l - 6}" y="${y(p) + 4}" font-size="11" text-anchor="end" fill="#666">${p.toFixed(2)}</text>`)
  }
  for (let k = 0; k < idx.length; k += 15) {
    parts.push(`<text x="${x(idx[k])}" y="${H - 10}" font-size="11" text-anchor="middle" fill="#666">${fmtTime(bars[k].t)}</text>`)
  }
  bars.forEach((b, k) => {
    const up = b.close >= b.open
    const col = up ? '#26a69a' : '#ef5350'
    const cx = x(idx[k])
    parts.push(`<line x1="${cx}" x2="${cx}" y1="${y(b.high)}" y2="${y(b.low)}" stroke="${col}"/>`)
    const top = y(Math.max(b.open, b.close))
    parts.push(`<rect x="${cx - cw / 2}" y="${top}" width="${cw}" height="${Math.max(1, y(Math.min(b.open, b.close)) - top)}" fill="${col}"/>`)
  })
  const emaPts = idx.map((i, k) => (Number.isFinite(ema[k]) ? `${x(i)},${y(ema[k])}` : null)).filter(Boolean)
  if (emaPts.length) parts.push(`<polyline points="${emaPts.join(' ')}" fill="none" stroke="#f59e0b" stroke-width="1.5"/>`)

  const lineObj = a.lineId ? eng.lines.find(l => l.id === a.lineId) : null
  if (lineObj) {
    const x0 = Math.max(from, lineObj.a.idx)
    parts.push(`<line x1="${x(x0)}" y1="${y(eng.lineValue(lineObj, x0))}" x2="${x(to)}" y2="${y(eng.lineValue(lineObj, to))}" stroke="#2563eb" stroke-width="2"/>`)
  }
  for (const sw of eng.swings) {
    if (sw.idx < from || sw.idx > to) continue
    parts.push(`<circle cx="${x(sw.idx)}" cy="${y(sw.price)}" r="3.5" fill="none" stroke="#7c3aed" stroke-width="1.5"/>`)
  }
  parts.push(`<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(a.initialStop)}" y2="${y(a.initialStop)}" stroke="#ef4444" stroke-dasharray="4 4"/>`)
  parts.push(`<circle cx="${x(a.entryIdx)}" cy="${y(a.entryPrice)}" r="6" fill="#16a34a"/>`)
  for (const ex of a.exits) {
    const i = f.minute.findIndex((_, k) => s.bars[f.start + k].t === ex.t)
    if (i >= 0) parts.push(`<rect x="${x(i) - 5}" y="${y(ex.price) - 5}" width="10" height="10" fill="#111"/>`)
  }
  parts.push(`<text x="${PAD.l}" y="22" font-size="14" fill="#111">${a.symbol} ${a.day} ${a.direction} - variant ${a.variant} - ${a.r.toFixed(2)}R - exits: ${a.exits.map(e => e.reason).join(', ')}</text>`)
  parts.push(`<text x="${W - PAD.r}" y="22" font-size="11" text-anchor="end" fill="#666">green=entry  black=exit  blue=trendline  orange=EMA50(HA)  purple=swings  red dashed=stop</text>`)

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="Arial, sans-serif">${parts.join('')}</svg>`
  writeFileSync(file, new Resvg(svg).render().asPng())
}
