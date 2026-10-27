// Run: npx tsx --test server/backtest/ttf/*.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TrendlineEngine, EngineBar } from './trendlines.js'
import { heikinAshi, resample, lastClosedIndex, Bar } from './candles.js'

const P = { pivotStrength: 3, touchTolAtr: 0.15, minAnchorSpacing: 10 }

// Bars from a list of lows; highs = low + 1, closes = low + 0.5, ATR 1
// (so tolerance = 0.15).
const barsFromLows = (lows: number[]): EngineBar[] =>
  lows.map((low, i) => ({ t: i * 60000, low, high: low + 1, close: low + 0.5, atr: 1 }))

// A falling V-pattern: dips at index 5 (100) and 20 (98), flat 105 elsewhere.
const twoDips = () => {
  const lows = new Array(30).fill(105)
  lows[5] = 100
  lows[20] = 98
  return lows
}

test('swing low only confirms after pivotStrength right-side bars close', () => {
  const eng = new TrendlineEngine('bullish', P)
  const bars = barsFromLows(twoDips())
  const confirmedAt: number[] = []
  bars.forEach((b, i) => { if (eng.step(b)) confirmedAt.push(i) })
  assert.deepEqual(confirmedAt, [8, 23])
  assert.deepEqual(eng.swings.map(s => s.idx), [5, 20])
})

test('falling line between two lows becomes active with 2 touches', () => {
  const eng = new TrendlineEngine('bullish', P)
  barsFromLows(twoDips()).forEach(b => eng.step(b))
  assert.ok(eng.active)
  assert.equal(eng.active!.a.idx, 5)
  assert.equal(eng.active!.b.idx, 20)
  assert.equal(eng.active!.touches, 2)
  // slope -2/15 per bar
  assert.ok(Math.abs(eng.lineValue(eng.active!, 35) - (100 - (2 * 30) / 15)) < 1e-9)
})

test('anchors closer than minAnchorSpacing do not form a line', () => {
  const lows = new Array(30).fill(105)
  lows[5] = 100
  lows[12] = 98 // 7 bars apart < 10
  const eng = new TrendlineEngine('bullish', P)
  barsFromLows(lows).forEach(b => eng.step(b))
  assert.equal(eng.lines.length, 0)
  assert.equal(eng.active, null)
})

test('rising pair of lows is not a bullish candidate', () => {
  const lows = new Array(30).fill(105)
  lows[5] = 98
  lows[20] = 100
  const eng = new TrendlineEngine('bullish', P)
  barsFromLows(lows).forEach(b => eng.step(b))
  assert.equal(eng.lines.length, 0)
})

test('a close beyond line by more than tolerance invalidates it and logs it', () => {
  const eng = new TrendlineEngine('bullish', P)
  const bars = barsFromLows(twoDips())
  bars.forEach(b => eng.step(b))
  const line = eng.active!
  // projected value at index 30 is 100 - 2*25/15 = 96.667; close 96.3 is 0.367 below (> 0.15)
  eng.step({ t: 30 * 60000, low: 96, high: 97, close: 96.3, atr: 1 })
  assert.equal(line.valid, false)
  assert.equal(eng.active, null)
  assert.ok(eng.log.some(e => e.event === 'invalidated' && e.lineId === line.id))
})

test('close within tolerance does not invalidate', () => {
  const eng = new TrendlineEngine('bullish', P)
  barsFromLows(twoDips()).forEach(b => eng.step(b))
  const line = eng.active!
  eng.step({ t: 30 * 60000, low: 96.6, high: 97.5, close: 96.6, atr: 1 }) // 0.067 below
  assert.equal(line.valid, true)
})

test('line touch = bar low within tolerance of projected value', () => {
  const eng = new TrendlineEngine('bullish', P)
  barsFromLows(twoDips()).forEach(b => eng.step(b))
  const v = eng.lineValue(eng.active!, 30)
  eng.step({ t: 30 * 60000, low: v + 0.1, high: v + 1, close: v + 0.5, atr: 1 })
  assert.equal(eng.isTouch(30), true)
  eng.step({ t: 31 * 60000, low: v + 2, high: v + 3, close: v + 2.5, atr: 1 })
  assert.equal(eng.isTouch(31), false)
})

test('third touching swing raises score and wins over a 2-touch line', () => {
  const lows = new Array(50).fill(110)
  lows[5] = 100
  lows[20] = 98
  lows[35] = 96 // exactly on the 5->20 line extended
  const eng = new TrendlineEngine('bullish', P)
  barsFromLows(lows).forEach(b => eng.step(b))
  assert.equal(eng.active!.touches, 3)
  assert.equal(eng.active!.a.idx, 5)
})

test('bearish engine mirrors on swing highs (rising line)', () => {
  const highs = new Array(30).fill(95)
  highs[5] = 100
  highs[20] = 102
  const bars: EngineBar[] = highs.map((high, i) => ({ t: i * 60000, high, low: high - 1, close: high - 0.5, atr: 1 }))
  const eng = new TrendlineEngine('bearish', P)
  bars.forEach(b => eng.step(b))
  assert.ok(eng.active)
  assert.equal(eng.active!.a.price, 100)
  assert.equal(eng.active!.b.price, 102)
  // close well ABOVE the rising line breaks it
  const v = eng.lineValue(eng.active!, 30)
  eng.step({ t: 30 * 60000, high: v + 1, low: v, close: v + 0.5, atr: 1 })
  assert.equal(eng.active, null)
})

test('heikin ashi first and second candle', () => {
  const ha = heikinAshi([{ open: 10, high: 12, low: 9, close: 11 }, { open: 11, high: 13, low: 10, close: 12 }])
  assert.equal(ha[0].close, 10.5)
  assert.equal(ha[0].open, 10.5)
  assert.equal(ha[1].open, 10.5)
  assert.equal(ha[1].close, 11.5)
  assert.equal(ha[1].high, 13)
})

test('3m resample aligns to 09:30 and lastClosedIndex never looks ahead', () => {
  const bars: Bar[] = Array.from({ length: 7 }, (_, i) => ({
    t: i, open: i, high: i + 1, low: i - 1, close: i + 0.5, day: '2026-01-02', minute: 570 + i
  }))
  const b3 = resample(bars, 3)
  assert.equal(b3.length, 3)
  assert.deepEqual(b3.map(b => b.lastIdx), [2, 5, 6])
  assert.equal(b3[0].open, 0)
  assert.equal(b3[0].close, 2.5)
  assert.equal(b3[0].high, 3)
  // minute 0,1 -> no closed 3m bar yet; minute 2 closes the first bucket
  assert.deepEqual(lastClosedIndex(7, b3), [-1, -1, 0, 0, 0, 1, 2])
})
