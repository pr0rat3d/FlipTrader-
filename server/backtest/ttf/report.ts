import { Attempt } from './engine.js'
import { OptionResult } from './options.js'

export interface PricedAttempt extends Attempt {
  options: OptionResult[]
}

export const MIN_SAMPLE = 30

export interface Stats {
  n: number
  winRate: number
  avgWin: number
  avgLoss: number
  expectancy: number
  total: number
  maxConsecLosses: number
  maxDrawdown: number
}

// values in chronological order
export const stats = (values: number[]): Stats => {
  const wins = values.filter(v => v > 0)
  const losses = values.filter(v => v <= 0)
  let run = 0, maxRun = 0, cum = 0, peak = 0, dd = 0
  for (const v of values) {
    run = v <= 0 ? run + 1 : 0
    maxRun = Math.max(maxRun, run)
    cum += v
    peak = Math.max(peak, cum)
    dd = Math.max(dd, peak - cum)
  }
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
  return {
    n: values.length, winRate: values.length ? wins.length / values.length : 0,
    avgWin: mean(wins), avgLoss: mean(losses), expectancy: mean(values),
    total: values.reduce((a, b) => a + b, 0), maxConsecLosses: maxRun, maxDrawdown: dd
  }
}

export const dayStats = (items: Array<{ day: string; v: number }>) => {
  const byDay = new Map<string, number>()
  for (const it of items) byDay.set(it.day, (byDay.get(it.day) ?? 0) + it.v)
  const vals = [...byDay.values()]
  return { days: vals.length, positive: vals.filter(v => v > 0).length }
}

export const optionPnl = (a: PricedAttempt, nOtm: number, haircut: number): number | null => {
  const o = a.options.find(x => x.nOtm === nOtm)
  return o?.filled ? o.pnlByHaircut![haircut.toFixed(2)] : null
}

const pct = (x: number) => `${(x * 100).toFixed(0)}%`
const small = (n: number) => (n < MIN_SAMPLE ? ' ⚠ <30' : '')

export const breakdownTable = (
  title: string, attempts: PricedAttempt[], keyFn: (a: PricedAttempt) => string, haircut: number
): string => {
  const groups = new Map<string, PricedAttempt[]>()
  for (const a of attempts) {
    const k = keyFn(a)
    groups.set(k, [...(groups.get(k) ?? []), a])
  }
  const rows = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, g]) => {
    const r = stats(g.map(a => a.r))
    const o = stats(g.map(a => optionPnl(a, 1, haircut)).filter((v): v is number => v !== null))
    return `| ${k} | ${r.n}${small(r.n)} | ${pct(r.winRate)} | ${r.expectancy.toFixed(2)} | ${r.total.toFixed(1)} | ${o.n}${small(o.n)} | ${pct(o.winRate)} | $${o.expectancy.toFixed(0)} | $${o.total.toFixed(0)} |`
  })
  return [`**${title}**`, '',
    '| Group | Trades | Win | Exp R | Total R | Opt fills (1 OTM) | Opt win | Opt avg $ | Opt total $ |',
    '|---|---|---|---|---|---|---|---|---|', ...rows, ''].join('\n')
}

export const summaryRow = (label: string, attempts: PricedAttempt[], haircut: number): string => {
  const r = stats(attempts.map(a => a.r))
  const d = dayStats(attempts.map(a => ({ day: a.day, v: a.r })))
  const opt = (n: number, h: number) => {
    const s = stats(attempts.map(a => optionPnl(a, n, h)).filter((v): v is number => v !== null))
    return `${s.n} / ${pct(s.winRate)} / $${s.total.toFixed(0)} / -$${s.maxDrawdown.toFixed(0)}`
  }
  return `| ${label} | ${r.n}${small(r.n)} | ${pct(r.winRate)} | ${r.avgWin.toFixed(2)} | ${r.avgLoss.toFixed(2)} | **${r.expectancy.toFixed(3)}** | ${r.maxConsecLosses} | ${r.maxDrawdown.toFixed(1)} | ${d.positive}/${d.days} | ${opt(1, haircut)} | ${opt(2, haircut)} | ${opt(1, 0)} |`
}

export const SUMMARY_HEADER = [
  '| Variant / start | Attempts | Win | Avg win R | Avg loss R | Expectancy R | Max consec L | Max DD R | +Days | 1 OTM n/win/total/maxDD | 2 OTM n/win/total/maxDD | 1 OTM @ $0 haircut |',
  '|---|---|---|---|---|---|---|---|---|---|---|---|'
].join('\n')

const csvEscape = (v: unknown) => {
  const s = String(v ?? '')
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export const attemptsCsv = (attempts: PricedAttempt[], haircuts: number[]): string => {
  const iso = (t: number) => new Date(t).toISOString()
  const head = ['variant', 'start', 'symbol', 'day', 'direction', 'signal_time', 'entry_time', 'entry_price', 'initial_stop', 'risk', 'points', 'r',
    'exit_reasons', 'exit_times', 'exit_prices', 'index_count', 'time_bucket', 'trend_day', 'line_id',
    ...[1, 2].flatMap(n => [`otm${n}_contract`, `otm${n}_filled`, `otm${n}_entry`, ...haircuts.map(h => `otm${n}_pnl_h${h.toFixed(2)}`)])]
  const rows = attempts.map(a => [
    a.variant, `${Math.floor(a.startMinute / 60)}:${String(a.startMinute % 60).padStart(2, '0')}`, a.symbol, a.day, a.direction,
    iso(a.signalT), iso(a.entryT), a.entryPrice, a.initialStop.toFixed(4), a.risk.toFixed(4), a.points.toFixed(4), a.r.toFixed(3),
    a.exits.map(e => e.reason).join('|'), a.exits.map(e => iso(e.t)).join('|'), a.exits.map(e => e.price.toFixed(4)).join('|'),
    a.indexCount, a.timeBucket, a.trendDay, a.lineId ?? '',
    ...[1, 2].flatMap(n => {
      const o = a.options.find(x => x.nOtm === n)
      return [o?.contract ?? '', o?.filled ?? false, o?.entryPrice ?? '', ...haircuts.map(h => (o?.filled ? o.pnlByHaircut![h.toFixed(2)].toFixed(2) : ''))]
    })
  ].map(csvEscape).join(','))
  return [head.join(','), ...rows].join('\n')
}
