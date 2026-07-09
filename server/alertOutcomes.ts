import { hasSessionClosedSince } from './marketHours.js'

export interface MilestonePrices {
  milestone10: number
  milestone20: number
  milestone30: number
}

// Milestones are % of the price distance from entry to the 50 EMA target, not a raw
// % price move (a raw 10-30% intraday move is essentially impossible for SPY/QQQ/IWM).
// E.g. entry $100, target $110 -> 10%=$101, 20%=$102, 30%=$103.
export const deriveMilestonePrices = (entryPrice: number, target50ema: number): MilestonePrices => {
  const distance = target50ema - entryPrice
  return {
    milestone10: entryPrice + distance * 0.10,
    milestone20: entryPrice + distance * 0.20,
    milestone30: entryPrice + distance * 0.30
  }
}

export interface ProfitTargetRow {
  entry_price: number
  target_50ema_price: number
  milestone_10_price: number | null
  milestone_10_hit_at: string | null
  milestone_20_price: number | null
  milestone_20_hit_at: string | null
  milestone_30_price: number | null
  milestone_30_hit_at: string | null
  max_favorable_pct: number | null
  target_hit_at: string | null
}

export interface PriceSampleUpdate {
  max_favorable_price?: number
  max_favorable_pct?: number
  max_favorable_at?: string
  milestone_10_hit_at?: string
  milestone_20_hit_at?: string
  milestone_30_hit_at?: string
  target_hit_at?: string
  status?: 'target_hit'
}

// Direction-aware: applies one new price observation to an open profit_targets row,
// returning only the fields that changed (or null if nothing new happened). Used by
// both the live per-minute tracker (real quotes) and retrospective replay (historical
// indicator_snapshots closes) - same function, so the two paths can't drift apart.
export const applyPriceSample = (row: ProfitTargetRow, price: number, at: Date): PriceSampleUpdate | null => {
  const isBullish = row.target_50ema_price > row.entry_price
  const distance = Math.abs(row.target_50ema_price - row.entry_price)
  const update: PriceSampleUpdate = {}
  const atISO = at.toISOString()

  const favorableMove = isBullish ? price - row.entry_price : row.entry_price - price
  const favorablePct = distance !== 0 ? (favorableMove / distance) * 100 : 0

  const currentBestPct = row.max_favorable_pct ?? -Infinity
  if (favorablePct > currentBestPct) {
    update.max_favorable_price = price
    update.max_favorable_pct = favorablePct
    update.max_favorable_at = atISO
  }

  const crossed = (target: number | null) =>
    target !== null && (isBullish ? price >= target : price <= target)

  if (!row.milestone_10_hit_at && crossed(row.milestone_10_price)) update.milestone_10_hit_at = atISO
  if (!row.milestone_20_hit_at && crossed(row.milestone_20_price)) update.milestone_20_hit_at = atISO
  if (!row.milestone_30_hit_at && crossed(row.milestone_30_price)) update.milestone_30_hit_at = atISO

  if (!row.target_hit_at && crossed(row.target_50ema_price)) {
    update.target_hit_at = atISO
    update.status = 'target_hit'
  }

  return Object.keys(update).length > 0 ? update : null
}

// True if an open row's trading session has closed since entry without reaching
// target - a same-day expiry rule matching day-trading discipline. A signal firing
// late in the session (e.g. 3:57pm ET) will nearly always expire - that's a
// deliberate consequence of the rule, not a bug.
export const checkExpiry = (entryTime: Date, now: Date = new Date()): boolean =>
  hasSessionClosedSince(entryTime, now)
