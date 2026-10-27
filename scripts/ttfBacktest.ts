// Thin bootstrap for the TTF backtest - same pattern as scripts/backtest.ts:
// load .env.local into process.env, THEN dynamically import the run logic.
import { readFileSync } from 'fs'

try {
  const env = readFileSync('.env.local', 'utf8')
  for (const line of env.split('\n')) {
    if (!line.includes('=')) continue
    const i = line.indexOf('=')
    const key = line.slice(0, i).trim()
    let value = line.slice(i + 1).trim()
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
    if (key && !(key in process.env)) process.env[key] = value
  }
} catch {
  // .env.local not found - assume env vars are already set (e.g. CI).
}

const { run } = await import('./ttfBacktestRun.js')
run().catch((err: unknown) => {
  console.error('TTF backtest failed:', err)
  process.exit(1)
})
