// Standalone, single-symbol backtest for REM (Remora) - deliberately NOT
// bolted onto scripts/backtestRun.ts, which is hard-typed around exactly
// SYMBOLS = ['SPY','QQQ','IWM'] throughout (Record<Symbol,...> everywhere) -
// retrofitting an arbitrary 4th symbol there would mean touching a large,
// heavily-typed file for what's meant to be a quick exploratory check.
// Reuses the same walk-forward, no-lookahead discipline and the same real
// outcome-tracking functions (applyPriceSample/checkExpiry) every other
// backtest in this repo already uses, just without the Phase 2 multi-symbol
// gated-account simulation, which isn't meaningful for a single ticker's
// signal-quality question.
//
// Usage: npx tsx scripts/backtestSingleStock.ts -- --symbol TSLA --days 90
import { fetchIntradayHistory } from '../server/backtest/fetchHistory.js'
import { sessionVWAPFor } from '../server/backtest/replayHelpers.js'
import { detectRemoraSetup } from '../server/remora.js'
import { deriveMilestonePrices, applyPriceSample, checkExpiry, ProfitTargetRow } from '../server/alertOutcomes.js'
import { nyDateKey } from '../server/marketHours.js'

const ROLLING_WINDOW_BARS = 300

const parseArgs = () => {
  const args = process.argv.slice(2)
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag)
    return i >= 0 ? args[i + 1] : undefined
  }
  const symbol = get('--symbol') ?? 'TSLA'
  const days = get('--days')
  const end = get('--end') ?? new Date().toISOString().slice(0, 10)
  const start = get('--start') ?? (() => {
    const d = new Date(end)
    d.setDate(d.getDate() - parseInt(days ?? '90', 10))
    return d.toISOString().slice(0, 10)
  })()
  const reversalBodyPct = get('--remora-reversal-body-pct')
  const minScoreArg = get('--remora-min-score')
  return {
    symbol, start, end,
    reversalBodyPctOverride: reversalBodyPct ? parseFloat(reversalBodyPct) : undefined,
    minScore: minScoreArg ? parseFloat(minScoreArg) : 50
  }
}

interface Leg {
  id: number
  direction: 'bullish' | 'bearish'
  entryTimeIso: string
  score: number
  status: 'open' | 'target_hit' | 'stopped_out' | 'expired'
  row: ProfitTargetRow
}

const main = async () => {
  const { symbol, start, end, reversalBodyPctOverride, minScore } = parseArgs()
  console.log(`Backtesting REM (Remora) on ${symbol} from ${start} to ${end}, min score ${minScore}${reversalBodyPctOverride !== undefined ? `, reversal-body-pct override ${reversalBodyPctOverride}` : ' (live default 0.5%)'}`)

  // Extra lookback before `start` so the rolling window has real history
  // from day 1 of the scored range, same reasoning backtestRun.ts uses.
  const fetchStart = new Date(new Date(start).getTime() - 10 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  console.log(`Fetching history for ${symbol}...`)
  const candles = await fetchIntradayHistory(symbol, `${fetchStart}T00:00:00Z`, `${end}T23:59:59Z`)
  console.log(`  ${symbol}: ${candles.length} 5-min bars`)
  if (candles.length === 0) {
    console.log('No data returned - check the symbol is valid and has intraday history on this account.')
    return
  }

  const scoredStartMs = new Date(`${start}T00:00:00Z`).getTime()

  const dayStartIndex = new Map<string, number>()
  candles.forEach((c, i) => {
    const key = nyDateKey(c.datetime)
    if (!dayStartIndex.has(key)) dayStartIndex.set(key, i)
  })

  const legs: Leg[] = []
  let nextId = 1
  let barsEvaluated = 0

  for (let gi = 0; gi < candles.length; gi++) {
    const bar = candles[gi]
    const barMs = new Date(bar.datetime).getTime()

    // Update every currently-open leg against this bar's close, same as
    // backtestRun.ts's own Phase 1 loop - happens every bar regardless of
    // whether it's inside the scored range, so a leg opened near the range
    // boundary still gets tracked to resolution.
    for (const leg of legs) {
      if (leg.status !== 'open') continue
      const update = applyPriceSample(leg.row, leg.direction, bar.close, new Date(bar.datetime))
      if (update) Object.assign(leg.row, update)
      if (update?.status === 'target_hit') leg.status = 'target_hit'
      else if (update?.status === 'stopped_out') leg.status = 'stopped_out'
      else if (checkExpiry(new Date(leg.entryTimeIso), new Date(bar.datetime))) leg.status = 'expired'
    }

    if (barMs < scoredStartMs) continue
    barsEvaluated++

    const windowStart = Math.max(0, gi - ROLLING_WINDOW_BARS + 1)
    const window = candles.slice(windowStart, gi + 1)

    const dayKey = nyDateKey(bar.datetime)
    const dayStart = dayStartIndex.get(dayKey) ?? gi
    const sessionCandlesSoFar = candles.slice(dayStart, gi + 1)
    const vwap = sessionVWAPFor(sessionCandlesSoFar)

    for (const direction of ['bullish', 'bearish'] as const) {
      const rem = detectRemoraSetup(window, direction, vwap, reversalBodyPctOverride)
      if (!rem || rem.score < minScore) continue

      const milestones = deriveMilestonePrices(rem.entryPrice, rem.target)
      const row: ProfitTargetRow = {
        entry_price: rem.entryPrice, target_50ema_price: rem.target, stop_loss_price: rem.stopLoss,
        milestone_10_price: milestones.milestone10, milestone_10_hit_at: null,
        milestone_20_price: milestones.milestone20, milestone_20_hit_at: null,
        milestone_30_price: milestones.milestone30, milestone_30_hit_at: null,
        max_favorable_pct: null, target_hit_at: null, stopped_out_at: null
      }
      legs.push({ id: nextId++, direction, entryTimeIso: bar.datetime, score: rem.score, status: 'open', row })
    }
  }

  console.log(`\nEvaluated ${barsEvaluated} bars, generated ${legs.length} REM legs on ${symbol}.\n`)

  const hit = legs.filter(l => l.status === 'target_hit').length
  const stopped = legs.filter(l => l.status === 'stopped_out').length
  const expired = legs.filter(l => l.status === 'expired').length
  const open = legs.filter(l => l.status === 'open').length
  const resolved = hit + stopped
  const winRate = resolved > 0 ? ((hit / resolved) * 100).toFixed(1) + '%' : '—'
  const avgScore = legs.length > 0 ? (legs.reduce((a, l) => a + l.score, 0) / legs.length).toFixed(1) : '—'

  console.log('Type     Legs   TargetHit  StoppedOut  Expired  Open  WinRate  AvgScore')
  console.log(`REM      ${String(legs.length).padEnd(6)} ${String(hit).padEnd(10)} ${String(stopped).padEnd(11)} ${String(expired).padEnd(8)} ${String(open).padEnd(5)} ${winRate.padEnd(8)} ${avgScore}`)

  const bullish = legs.filter(l => l.direction === 'bullish').length
  const bearish = legs.filter(l => l.direction === 'bearish').length
  console.log(`\nDirection split: ${bullish} bullish, ${bearish} bearish`)
}

export const run = main
