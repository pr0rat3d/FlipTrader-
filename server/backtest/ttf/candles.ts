import { RSI, MACD, EMA, ATR } from 'technicalindicators'
import type { Candle } from '../../twelvedata.js'

export interface Bar {
  t: number // epoch ms, bar START
  open: number
  high: number
  low: number
  close: number
  day: string // NY date key
  minute: number // NY minutes since midnight of bar start
}

const nyParts = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false
})

export const nyDayMinute = (ms: number): { day: string; minute: number } => {
  const p = Object.fromEntries(nyParts.formatToParts(new Date(ms)).map(x => [x.type, x.value]))
  const hour = parseInt(p.hour, 10) % 24
  return { day: `${p.year}-${p.month}-${p.day}`, minute: hour * 60 + parseInt(p.minute, 10) }
}

export const SESSION_OPEN = 9 * 60 + 30
export const SESSION_CLOSE = 16 * 60

// Regular session only: bars starting 09:30..15:59 ET.
export const toSessionBars = (candles: Candle[]): Bar[] => {
  const out: Bar[] = []
  for (const c of candles) {
    const t = Date.parse(c.datetime)
    const { day, minute } = nyDayMinute(t)
    if (minute < SESSION_OPEN || minute >= SESSION_CLOSE) continue
    out.push({ t, open: c.open, high: c.high, low: c.low, close: c.close, day, minute })
  }
  return out
}

export interface ResampledBar extends Bar {
  lastIdx: number // index into the 1m series of the last minute in this bucket
}

// Resample REAL 1m OHLC into N-minute buckets aligned to the 09:30 open,
// never crossing a session. HA is applied afterwards (never resample HA).
export const resample = (bars: Bar[], minutes: number): ResampledBar[] => {
  const out: ResampledBar[] = []
  let curKey = ''
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]
    const slot = Math.floor((b.minute - SESSION_OPEN) / minutes)
    const key = `${b.day}|${slot}`
    const cur = out[out.length - 1]
    if (key !== curKey || !cur) {
      curKey = key
      out.push({ ...b, minute: SESSION_OPEN + slot * minutes, lastIdx: i })
    } else {
      cur.high = Math.max(cur.high, b.high)
      cur.low = Math.min(cur.low, b.low)
      cur.close = b.close
      cur.lastIdx = i
    }
  }
  return out
}

export interface HACandle { open: number; high: number; low: number; close: number }

// Standard Heikin Ashi, continuous across sessions (same as a chart with
// extended history loaded).
export const heikinAshi = (bars: Array<{ open: number; high: number; low: number; close: number }>): HACandle[] => {
  const out: HACandle[] = []
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]
    const close = (b.open + b.high + b.low + b.close) / 4
    const open = i === 0 ? (b.open + b.close) / 2 : (out[i - 1].open + out[i - 1].close) / 2
    out.push({ open, high: Math.max(b.high, open, close), low: Math.min(b.low, open, close), close })
  }
  return out
}

// technicalindicators returns arrays shorter than the input (warm-up
// dropped from the front); pad with NaN so index i lines up with bar i.
export const alignEnd = (values: number[], length: number): number[] =>
  [...new Array(Math.max(0, length - values.length)).fill(NaN), ...values]

export const rsiSeries = (closes: number[], period: number): number[] =>
  alignEnd(RSI.calculate({ values: closes, period }), closes.length)

export const macdLineSeries = (closes: number[]): number[] =>
  alignEnd(MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false })
    .map(m => m.MACD ?? NaN), closes.length)

export const emaSeries = (closes: number[], period: number): number[] =>
  alignEnd(EMA.calculate({ values: closes, period }), closes.length)

export const atrSeries = (ha: HACandle[], period: number): number[] =>
  alignEnd(ATR.calculate({ high: ha.map(c => c.high), low: ha.map(c => c.low), close: ha.map(c => c.close), period }), ha.length)

// For each 1m bar i: index of the latest higher-timeframe bar that has
// CLOSED by the end of bar i (no lookahead - a 3m bucket only counts once
// its last minute has closed).
export const lastClosedIndex = (oneMinCount: number, htf: ResampledBar[]): number[] => {
  const out = new Array(oneMinCount).fill(-1)
  let j = -1
  for (let i = 0; i < oneMinCount; i++) {
    while (j + 1 < htf.length && htf[j + 1].lastIdx <= i) j++
    out[i] = j
  }
  return out
}

export interface SymbolSeries {
  symbol: string
  bars: Bar[]
  rsi1: number[]
  rsi3: number[] // aligned to 1m index via last closed 3m bar
  rsi5: number[]
  macd1: number[]
  ema50: number[]
  atr: number[]
}

export const buildSeries = (symbol: string, bars: Bar[], rsiPeriod: number): SymbolSeries => {
  const ha1 = heikinAshi(bars)
  const closes1 = ha1.map(c => c.close)
  const b3 = resample(bars, 3)
  const b5 = resample(bars, 5)
  const rsi3raw = rsiSeries(heikinAshi(b3).map(c => c.close), rsiPeriod)
  const rsi5raw = rsiSeries(heikinAshi(b5).map(c => c.close), rsiPeriod)
  const idx3 = lastClosedIndex(bars.length, b3)
  const idx5 = lastClosedIndex(bars.length, b5)
  return {
    symbol,
    bars,
    rsi1: rsiSeries(closes1, rsiPeriod),
    rsi3: idx3.map(j => (j >= 0 ? rsi3raw[j] : NaN)),
    rsi5: idx5.map(j => (j >= 0 ? rsi5raw[j] : NaN)),
    macd1: macdLineSeries(closes1),
    ema50: emaSeries(closes1, 50),
    atr: atrSeries(ha1, 14)
  }
}
