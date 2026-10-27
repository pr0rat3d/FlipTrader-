// TTF (Triple Time Frame reversal) backtest - 2026-10-27. Backtest-only,
// lives entirely under server/backtest/ttf + this script; touches no live
// trading code. See server/backtest/ttf/config.ts for every spec decision
// and default.
//
// Usage: npx tsx scripts/ttfBacktest.ts [--months 12] [--end 2026-10-23]
//   [--logs backtest_in/ttf_human_logs.csv] [--match-variant B]
//   [--skip-options] [--no-divergence-filter] [--macd-exit-before-target]
//   [--require-rejection] [--rejection-window 2]  (window implies the filter)
//   [--trend-filter open|prevclose|ema50slope|ema200|daily] [--trend-days 5]
//   [--charts 10]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { fetchMinuteHistory } from '../server/backtest/fetchHistory.js'
import { toSessionBars, buildSeries, SymbolSeries, Bar } from '../server/backtest/ttf/candles.js'
import { DEFAULT_TTF_CONFIG, TtfConfig, VARIANTS, START_TIMES, SYMBOLS, Variant, TrendFilter, TREND_FILTERS } from '../server/backtest/ttf/config.js'
import { computeDayFlags, dayRanges, rawSignalsForDay, simulateDay, lineLogRows, DayFlags, Attempt, RawSignal } from '../server/backtest/ttf/engine.js'
import { TrendlineParams } from '../server/backtest/ttf/trendlines.js'
import { fetchOptionDay, priceAttempt, contractsFor } from '../server/backtest/ttf/options.js'
import { PricedAttempt, SUMMARY_HEADER, summaryRow, breakdownTable, attemptsCsv, stats, MIN_SAMPLE } from '../server/backtest/ttf/report.js'
import { renderAttemptPng } from '../server/backtest/ttf/charts.js'
import { loadHumanLogs, seededSplit, matchTrades, matchRate, HumanTrade, MatchRow } from '../server/backtest/ttf/humanLogs.js'

const parseArgs = () => {
  const args = process.argv.slice(2)
  const get = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined }
  const end = get('--end') ?? '2026-10-23'
  const months = parseInt(get('--months') ?? '12', 10)
  const startDate = new Date(`${end}T00:00:00Z`)
  startDate.setUTCMonth(startDate.getUTCMonth() - months)
  return {
    start: startDate.toISOString().slice(0, 10), end, months,
    logs: get('--logs') ?? 'backtest_in/ttf_human_logs.csv',
    matchVariant: (get('--match-variant') ?? 'B') as Variant,
    skipOptions: args.includes('--skip-options'),
    divergenceFilter: !args.includes('--no-divergence-filter'),
    macdExitBeforeTarget: args.includes('--macd-exit-before-target'),
    requireRejection: args.includes('--require-rejection') || get('--rejection-window') !== undefined,
    rejectionWindowBars: parseInt(get('--rejection-window') ?? '0', 10),
    trendFilter: (get('--trend-filter') ?? 'none') as TrendFilter,
    trendDays: parseInt(get('--trend-days') ?? '5', 10),
    charts: parseInt(get('--charts') ?? '10', 10)
  }
}

const loadBars = async (symbol: string, start: string, end: string): Promise<Bar[]> => {
  mkdirSync('backtest_out/cache', { recursive: true })
  // 10 calendar days of warm-up before the window so RSI/MACD/EMA50/HA are
  // settled on the first traded day.
  const warm = new Date(`${start}T00:00:00Z`)
  warm.setUTCDate(warm.getUTCDate() - 10)
  const from = warm.toISOString().slice(0, 10)
  const file = `backtest_out/cache/ttf_1min_sip_${symbol}_${from}_${end}.json`
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'))
  console.log(`  fetching ${symbol} 1m SIP ${from}..${end}`)
  const bars = toSessionBars(await fetchMinuteHistory(symbol, `${from}T00:00:00Z`, `${end}T23:59:59Z`, 'sip'))
  writeFileSync(file, JSON.stringify(bars))
  return bars
}

const tlParams = (cfg: TtfConfig): TrendlineParams => ({ pivotStrength: cfg.pivotStrength, touchTolAtr: cfg.touchTolAtr, minAnchorSpacing: cfg.minAnchorSpacing })

const seededPick = <T>(items: T[], k: number, seed: number): T[] => {
  let a = seed >>> 0
  const rand = () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296 }
  return items.map(x => ({ x, r: rand() })).sort((p, q) => p.r - q.r).slice(0, k).map(p => p.x)
}

const label = (v: Variant, start: number) => `${v} @ ${Math.floor(start / 60)}:${String(start % 60).padStart(2, '0')}`

const main = async () => {
  const opts = parseArgs()
  const cfg: TtfConfig = { ...DEFAULT_TTF_CONFIG, divergenceFilter: opts.divergenceFilter, macdExitBeforeTarget: opts.macdExitBeforeTarget, requireRejection: opts.requireRejection, rejectionWindowBars: opts.rejectionWindowBars, trendFilter: opts.trendFilter, trendDays: opts.trendDays }
  if (!TREND_FILTERS.includes(cfg.trendFilter)) throw new Error(`--trend-filter must be one of ${TREND_FILTERS.join(', ')}`)
  console.log(`TTF backtest ${opts.start}..${opts.end} (${opts.months} months)`)

  const series = new Map<string, SymbolSeries>()
  for (const sym of SYMBOLS) series.set(sym, buildSeries(sym, await loadBars(sym, opts.start, opts.end), cfg.rsiPeriod))
  const ranges = new Map(SYMBOLS.map(sym => [sym, dayRanges(series.get(sym)!)]))
  const tradeDays = [...ranges.get('SPY')!.keys()].filter(d => d >= opts.start && d <= opts.end).sort()
  console.log(`  ${tradeDays.length} sessions`)

  const flagsByKey = new Map<string, DayFlags>()
  const allSignals: RawSignal[] = []
  const attempts: Attempt[] = []
  const lineLog: ReturnType<typeof lineLogRows> = []
  for (const day of tradeDays) {
    const dayFlags: DayFlags[] = []
    for (const sym of SYMBOLS) {
      const r = ranges.get(sym)!.get(day)
      if (!r) continue
      const f = computeDayFlags(series.get(sym)!, r.start, r.end, cfg, tlParams(cfg))
      dayFlags.push(f)
      flagsByKey.set(`${sym}|${day}`, f)
      lineLog.push(...lineLogRows(f))
    }
    const signals = rawSignalsForDay(dayFlags, cfg, series)
    allSignals.push(...signals)
    const byKey = new Map(dayFlags.map(f => [f.symbol, f]))
    for (const v of VARIANTS) for (const st of START_TIMES) attempts.push(...simulateDay(signals, byKey, series, v, st, cfg))
  }
  console.log(`  ${allSignals.length} raw signal bars, ${attempts.length} attempts across ${VARIANTS.length * START_TIMES.length} variant/start combos`)

  // Phase 2: real 0DTE option bars
  const priced: PricedAttempt[] = attempts.map(a => ({ ...a, options: [] }))
  let optionNote = 'skipped (--skip-options)'
  if (!opts.skipOptions) {
    const needed = new Map<string, string>()
    for (const a of attempts) for (const n of [1, 2]) needed.set(contractsFor(a, n), a.day)
    console.log(`  fetching ${needed.size} option contracts (cached after first run)`)
    const barsByContract = new Map<string, Awaited<ReturnType<typeof fetchOptionDay>>>()
    const queue = [...needed.entries()]
    let done = 0
    await Promise.all(Array.from({ length: 4 }, async () => {
      for (let item = queue.shift(); item; item = queue.shift()) {
        barsByContract.set(item[0], await fetchOptionDay(item[0], item[1]))
        if (++done % 200 === 0) console.log(`    ${done}/${needed.size}`)
      }
    }))
    for (const a of priced) for (const n of [1, 2]) {
      const c = contractsFor(a, n)
      a.options.push(priceAttempt(a, barsByContract.get(c) ?? [], n, c, cfg))
    }
    const filled = priced.flatMap(a => a.options).filter(o => o.filled).length
    optionNote = `${filled}/${priced.length * 2} attempt-legs filled from real trade bars`
  }

  const tag = `${opts.start}_to_${opts.end}${cfg.divergenceFilter ? '' : '_nodivfilter'}${cfg.macdExitBeforeTarget ? '_macdexitearly' : ''}${cfg.requireRejection ? `_rejection${cfg.rejectionWindowBars ? `_w${cfg.rejectionWindowBars}` : ''}` : ''}${cfg.trendFilter !== 'none' ? `_trend-${cfg.trendFilter}${cfg.trendFilter === 'daily' ? cfg.trendDays : ''}` : ''}`
  const outDir = `backtest_out/ttf/${tag}`
  mkdirSync(`${outDir}/charts`, { recursive: true })
  writeFileSync(`${outDir}/attempts.csv`, attemptsCsv(priced, cfg.optionHaircuts))
  writeFileSync(`${outDir}/trendlines_log.csv`, ['symbol,day,direction,event,time,line_id,anchor_a_time,anchor_a_price,anchor_b_time,anchor_b_price,touches',
    ...lineLog.map(l => [l.symbol, l.day, l.direction, l.event, new Date(l.t).toISOString(), l.lineId, new Date(l.aT).toISOString(), l.aPrice, new Date(l.bT).toISOString(), l.bPrice, l.touches].join(','))].join('\n'))

  // Charts: N random trades per variant (10:00 start)
  const chartFiles: string[] = []
  for (const v of VARIANTS) {
    const pool = priced.filter(a => a.variant === v && a.startMinute === START_TIMES[0])
    seededPick(pool, opts.charts, 7).forEach((a, k) => {
      const file = `${outDir}/charts/${v}_${k + 1}_${a.symbol}_${a.day}.png`
      renderAttemptPng(a, flagsByKey.get(`${a.symbol}|${a.day}`)!, series.get(a.symbol)!, file)
      chartFiles.push(file.replace(`${outDir}/`, ''))
    })
  }

  const h = cfg.optionHaircuts[cfg.optionHaircuts.length - 1]
  const md: string[] = []
  md.push(`# TTF backtest - ${opts.start} to ${opts.end}`, '')
  md.push(`SPY/QQQ/IWM, Alpaca SIP 1m bars, ${tradeDays.length} sessions. Option leg: ${optionNote}.`, '')
  md.push('## Settings and decisions', '',
    `- RSI(${cfg.rsiPeriod}) < ${cfg.rsiOversold} / > ${cfg.rsiOverbought} on 1m+3m+5m HA closes (3m/5m resampled from real 1m, last CLOSED bar only); TTF active window ${cfg.ttfActiveBars} bars`,
    `- Trendlines on real 1m lows/highs: pivot ${cfg.pivotStrength}, touch tolerance ${cfg.touchTolAtr}×ATR(14, HA), min anchor spacing ${cfg.minAnchorSpacing} bars (untuned defaults unless a human-log tuning section below says otherwise)`,
    `- MACD curl: slope < 0 then >= ${-cfg.macdFlatEps} for 2 bars ("flat" = slope >= 0 - spec didn't define flat)`,
    `- MACD-flip exit applies ${cfg.macdExitBeforeTarget ? 'to the full position, before and after' : 'only AFTER'} the EMA50 half-off (spec lists it under "Remainder")`,
    `- Stops: % stop ${(cfg.stopPct * 100).toFixed(2)}% intrabar (filled at stop or worse open); B/C also exit on a 1m close beyond the entry trendline by > tolerance (next bar open). Variant A has no trendline, so % stop only. R uses the nearer stop.`,
    `- Rejection filter (not in spec): ${cfg.requireRejection ? `ON - a B/C line touch only counts once a bar ${cfg.rejectionWindowBars ? `within ${cfg.rejectionWindowBars} bar(s) after the touch (or the touch bar itself)` : '(the touch bar itself)'} closes back on the reversal side of the line in the trade direction, line not broken in between; entry off that bar` : 'off'}`,
    `- Trend filter (not in spec): ${cfg.trendFilter === 'none' ? 'off' : `${cfg.trendFilter}${cfg.trendFilter === 'daily' ? ` (${cfg.trendDays} sessions)` : ''} - shorts skipped while the read is up, longs while it's down`}`,
    `- Index-divergence filter: ${cfg.divergenceFilter ? 'ON' : 'OFF'}. Max ${cfg.maxAttemptsPerSymbolDay} attempts/symbol/day, one position per symbol at a time. No entries at/after 15:30; force exit 15:55.`,
    `- Entries fill at the next 1m bar open after the signal bar closes. EMA50 target = previous bar's EMA50(HA) value, touched by the real high/low.`,
    `- Options: 0DTE, strike = 1st/2nd $1 strike strictly OTM from the entry price, ${cfg.contractsPerTrade} contracts (half = 1). Entry = first option trade bar within ${cfg.optionMaxEntryDelayMin} min of the underlying entry (else no fill); each exit = next option bar at/after the 1m bar following the trigger. Haircut $${h.toFixed(2)}/share per side unless noted.`,
    '')
  md.push('## Summary', '', SUMMARY_HEADER)
  for (const v of VARIANTS) for (const st of START_TIMES) md.push(summaryRow(label(v, st), priced.filter(a => a.variant === v && a.startMinute === st), h))
  md.push('', `Option columns: fills / win rate / total $ / max drawdown $, ${cfg.contractsPerTrade} contracts per attempt, $${h.toFixed(2)} haircut. ⚠ <30 = too small to judge.`, '')

  for (const v of VARIANTS) for (const st of START_TIMES) {
    const g = priced.filter(a => a.variant === v && a.startMinute === st)
    if (!g.length) continue
    md.push(`## Variant ${label(v, st)}`, '')
    md.push(breakdownTable('TTF index count', g, a => String(a.indexCount), h))
    md.push(breakdownTable('Time bucket', g, a => a.timeBucket, h))
    md.push(breakdownTable('Direction', g, a => a.direction, h))
    md.push(breakdownTable('Trend day (|open-close| > 1%)', g, a => (a.trendDay ? 'trend day' : 'non-trend day'), h))
    md.push(breakdownTable('Exit path', g, a => a.exits.map(e => e.reason).join('+'), h))
  }

  md.push(...humanLogSection(opts, cfg, series, ranges, allSignals, flagsByKey))
  md.push('## Charts', '', ...chartFiles.map(f => `- ${f}`), '')
  writeFileSync(`${outDir}/summary.md`, md.join('\n'))
  console.log(`\nWrote ${outDir}/summary.md, attempts.csv, trendlines_log.csv, ${chartFiles.length} charts`)
  console.log('\n' + md.slice(md.indexOf('## Summary'), md.indexOf('## Summary') + 4 + VARIANTS.length * START_TIMES.length).join('\n'))
}

const humanLogSection = (
  opts: ReturnType<typeof parseArgs>, cfg: TtfConfig, series: Map<string, SymbolSeries>,
  ranges: Map<string, Map<string, { start: number; end: number }>>, allSignals: RawSignal[], flagsByKey: Map<string, DayFlags>
): string[] => {
  if (!existsSync(opts.logs)) {
    return ['## Validation against human logs', '', `Not run - no log file at \`${opts.logs}\`. Copy \`backtest_in/ttf_human_logs.sample.csv\` to that path with real trades and rerun.`, '']
  }
  const trades = loadHumanLogs(opts.logs)
  const { tuning, holdout } = seededSplit(trades, 42)
  const WINDOW = 3
  const flagsCache = new Map<string, DayFlags>()
  const flagsWith = (c: TtfConfig) => (symbol: string, day: string) => {
    const key = `${symbol}|${day}|${c.pivotStrength}|${c.touchTolAtr}|${c.minAnchorSpacing}`
    if (!flagsCache.has(key)) {
      const r = ranges.get(symbol)?.get(day)
      if (!r) return undefined
      flagsCache.set(key, computeDayFlags(series.get(symbol)!, r.start, r.end, c, tlParams(c)))
    }
    return flagsCache.get(key)
  }

  // Tune ONLY pivot strength / touch tolerance / anchor spacing, ONLY on the tuning set.
  let best = { cfg, rate: matchRate(matchTrades(tuning, flagsWith(cfg), opts.matchVariant, WINDOW, cfg)) }
  const defaultTuningRate = best.rate
  for (const pivotStrength of [2, 3, 4, 5]) for (const touchTolAtr of [0.1, 0.15, 0.2, 0.25, 0.3]) for (const minAnchorSpacing of [5, 10, 15, 20]) {
    const c = { ...cfg, pivotStrength, touchTolAtr, minAnchorSpacing }
    const rate = matchRate(matchTrades(tuning, flagsWith(c), opts.matchVariant, WINDOW, c))
    if (rate > best.rate + 1e-9) best = { cfg: c, rate }
  }
  const holdoutDefault = matchRate(matchTrades(holdout, flagsWith(cfg), opts.matchVariant, WINDOW, cfg))
  const holdoutRows = matchTrades(holdout, flagsWith(best.cfg), opts.matchVariant, WINDOW, best.cfg)
  const tuningRows = matchTrades(tuning, flagsWith(best.cfg), opts.matchVariant, WINDOW, best.cfg)
  const holdoutTuned = matchRate(holdoutRows)
  const overfit = best.rate - holdoutTuned > 0.15

  const yn = (b: boolean | undefined) => (b ? '✓' : '✗')
  const rowsMd = (rows: MatchRow[]) => rows.map(r => {
    const c = r.bestConditions
    return `| ${new Date(r.trade.t).toISOString()} | ${r.trade.symbol} | ${r.trade.direction} | ${r.trade.result} | ${r.matched ? `yes (${r.nearestOffset! >= 0 ? '+' : ''}${r.nearestOffset})` : 'no'} | ${yn(c?.ttfActive)} | ${yn(c?.curl)} | ${yn(c?.touch)} | ${yn(c?.rejection)} | ${yn(c?.div)} |`
  })
  const takenNear = (s: RawSignal, trades: HumanTrade[]) => trades.some(t => t.symbol === s.symbol && t.day === s.day && Math.abs(t.minute - s.minute) <= WINDOW)
  const loggedDays = new Set(trades.map(t => t.day))
  const untaken = allSignals.filter(s => loggedDays.has(s.day) && s.variants.includes(opts.matchVariant) && !takenNear(s, trades))

  const n = trades.length
  return ['## Validation against human logs', '',
    `${n} logged trades (${opts.logs}), seed-42 split: ${tuning.length} tuning / ${holdout.length} holdout. Match = variant ${opts.matchVariant}'s conditions pass, same direction, within ±${WINDOW} bars.${n < MIN_SAMPLE ? ' ⚠ fewer than 30 logged trades - match rates are not reliable yet.' : ''}`, '',
    '| | Tuning set | Holdout set |', '|---|---|---|',
    `| Default params (pivot ${cfg.pivotStrength}, tol ${cfg.touchTolAtr}, spacing ${cfg.minAnchorSpacing}) | ${(defaultTuningRate * 100).toFixed(0)}% | ${(holdoutDefault * 100).toFixed(0)}% |`,
    `| Tuned (pivot ${best.cfg.pivotStrength}, tol ${best.cfg.touchTolAtr}, spacing ${best.cfg.minAnchorSpacing}) | ${(best.rate * 100).toFixed(0)}% | ${(holdoutTuned * 100).toFixed(0)}% |`, '',
    overfit ? `**⚠ Overfit flag:** holdout match rate is ${((best.rate - holdoutTuned) * 100).toFixed(0)} points below tuning - the tuned params don't generalize; prefer the defaults.` : 'No overfit flag (holdout within 15 points of tuning).', '',
    'Note: the strategy results above use the DEFAULT params. Rerun with the tuned values only if they hold up on the holdout set.', '',
    '**Per logged trade (tuned params; conditions at the best bar within the window)**', '',
    '| Time (UTC) | Symbol | Dir | Result | Engine match | TTF | Curl | Touch | Rejection | Div |', '|---|---|---|---|---|---|---|---|---|---|',
    '| *tuning set* | | | | | | | | | |', ...rowsMd(tuningRows), '| *holdout set* | | | | | | | | | |', ...rowsMd(holdoutRows), '',
    `**Engine signals on logged days that weren't taken** (variant ${opts.matchVariant}, default params): ${untaken.length}`, '',
    '| Time (UTC) | Symbol | Dir | Index count |', '|---|---|---|---|',
    ...untaken.slice(0, 200).map(s => `| ${new Date(s.t).toISOString()} | ${s.symbol} | ${s.direction} | ${s.indexCount} |`), '']
}

export const run = main
