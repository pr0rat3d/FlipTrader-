// Trendline engine for the TTF backtest (1m, one session at a time).
//
// Written for the bullish case on swing LOWS (falling line connecting a
// lower later low). Bearish runs the exact same code on negated prices:
// -high makes "rising highs" into "falling lows" and -close flips the
// invalidation side, so there's one implementation to test, not two.
//
// No lookahead: a swing at index p is only known once the pivotStrength
// bars to its right have closed (i.e. at step p + pivotStrength).

export interface TrendlineParams {
  pivotStrength: number
  touchTolAtr: number
  minAnchorSpacing: number
}

export interface EngineBar {
  t: number
  high: number
  low: number
  close: number
  atr: number
}

export interface Swing {
  idx: number // session-local bar index
  t: number
  price: number // real price (low for bullish engine, high for bearish)
}

export interface Line {
  id: number
  a: Swing
  b: Swing
  touches: number
  valid: boolean
}

export interface LineLogEntry {
  event: 'created' | 'invalidated' | 'activated' | 'deactivated'
  t: number
  lineId: number
  aT: number
  aPrice: number
  bT: number
  bPrice: number
  touches: number
}

export class TrendlineEngine {
  readonly swings: Swing[] = []
  readonly lines: Line[] = []
  readonly log: LineLogEntry[] = []
  active: Line | null = null

  private readonly sign: number
  private readonly bars: EngineBar[] = []
  private nextId = 1

  constructor(readonly direction: 'bullish' | 'bearish', readonly params: TrendlineParams) {
    this.sign = direction === 'bullish' ? 1 : -1
  }

  // Transformed accessors - the engine reasons about "lows" of these.
  private lowAt = (i: number) => (this.sign === 1 ? this.bars[i].low : -this.bars[i].high)
  private closeAt = (i: number) => this.sign * this.bars[i].close
  private tolAt = (i: number) => this.params.touchTolAtr * this.bars[i].atr

  // Real-price value of a line at session index x.
  lineValue(line: Line, x: number): number {
    const av = this.sign * line.a.price
    const bv = this.sign * line.b.price
    return this.sign * (av + ((bv - av) * (x - line.a.idx)) / (line.b.idx - line.a.idx))
  }

  private tValue(line: Line, x: number): number {
    return this.sign * this.lineValue(line, x)
  }

  // Feed the next bar of the session. Returns the swing confirmed on this
  // step, if any.
  step(bar: EngineBar): Swing | null {
    this.bars.push(bar)
    const i = this.bars.length - 1
    const k = this.params.pivotStrength
    let confirmed: Swing | null = null

    const p = i - k
    if (p >= k) {
      const v = this.lowAt(p)
      let isPivot = true
      for (let j = p - k; j <= p + k && isPivot; j++) if (j !== p && !(v < this.lowAt(j))) isPivot = false
      if (isPivot) {
        confirmed = { idx: p, t: this.bars[p].t, price: this.sign === 1 ? this.bars[p].low : this.bars[p].high }
        this.addSwing(confirmed, i)
      }
    }

    // Invalidate lines broken by this bar's close.
    for (const line of this.lines) {
      if (!line.valid || i < line.a.idx) continue
      if (this.closeAt(i) < this.tValue(line, i) - this.tolAt(i)) {
        line.valid = false
        this.logLine('invalidated', bar.t, line)
      }
    }
    this.pickActive(bar.t)
    return confirmed
  }

  isTouch(i: number): boolean {
    if (!this.active) return false
    return Math.abs(this.lowAt(i) - this.tValue(this.active, i)) <= this.tolAt(i)
  }

  // Line break for the stop: close beyond `line` by more than tolerance.
  isBroken(line: Line, i: number): boolean {
    return this.closeAt(i) < this.tValue(line, i) - this.tolAt(i)
  }

  private addSwing(s: Swing, now: number) {
    const sv = this.sign * s.price
    for (const a of this.swings) {
      if (!(sv < this.sign * a.price)) continue
      if (s.idx - a.idx < this.params.minAnchorSpacing) continue
      const line: Line = { id: this.nextId++, a, b: s, touches: 0, valid: true }
      // Born invalid if any close since the first anchor already broke it.
      let ok = true
      for (let x = a.idx; x <= now && ok; x++) if (this.closeAt(x) < this.tValue(line, x) - this.tolAt(x)) ok = false
      if (!ok) continue
      this.lines.push(line)
      this.logLine('created', this.bars[now].t, line)
    }
    this.swings.push(s)
    for (const line of this.lines) if (line.valid) line.touches = this.countTouches(line)
  }

  private countTouches(line: Line): number {
    let n = 0
    for (const s of this.swings) {
      if (s.idx < line.a.idx) continue
      if (Math.abs(this.sign * s.price - this.tValue(line, s.idx)) <= this.tolAt(s.idx)) n++
    }
    return n
  }

  private pickActive(t: number) {
    let best: Line | null = null
    for (const line of this.lines) {
      if (!line.valid || line.touches < 2) continue
      if (!best || line.touches > best.touches
        || (line.touches === best.touches && (line.b.idx > best.b.idx || (line.b.idx === best.b.idx && line.a.idx > best.a.idx)))) best = line
    }
    if (best !== this.active) {
      if (this.active && this.active.valid) this.logLine('deactivated', t, this.active)
      if (best) this.logLine('activated', t, best)
      this.active = best
    }
  }

  private logLine(event: LineLogEntry['event'], t: number, line: Line) {
    this.log.push({ event, t, lineId: line.id, aT: line.a.t, aPrice: line.a.price, bT: line.b.t, bPrice: line.b.price, touches: line.touches })
  }
}
