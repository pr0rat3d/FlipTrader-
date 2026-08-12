// Thin bootstrap, mirrors scripts/backtest.ts exactly (same reason: loads
// .env.local into process.env BEFORE this file's imports resolve, since
// remora.ts -> orb.ts -> supportResistance.ts -> supabaseAdmin.ts throws at
// module-load time without credentials already in process.env - a dynamic
// import() runs after this file's own top-level code, unlike a static one).
import { readFileSync } from 'fs'

try {
  const env = readFileSync('.env.local', 'utf8')
  for (const line of env.split('\n')) {
    if (!line.includes('=')) continue
    const i = line.indexOf('=')
    const key = line.slice(0, i).trim()
    let value = line.slice(i + 1).trim()
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1)
    }
    if (key && !(key in process.env)) process.env[key] = value
  }
} catch {
  // .env.local not found - assume env vars are already set (e.g. CI).
}

const { run } = await import('./backtestSingleStockRun.js')
run().catch((err: unknown) => {
  console.error('Single-stock backtest failed:', err)
  process.exit(1)
})
