// Thin bootstrap: loads .env.local into process.env, THEN dynamically
// imports the actual backtest logic - a dynamic import() runs at runtime,
// after this file's own code has executed, unlike a static import (which
// ES modules hoist and execute before anything else in the importing file
// runs). backtestRun.ts transitively imports server/supportResistance.ts,
// which imports server/supabaseAdmin.ts, which throws at module-load time
// if Supabase credentials aren't already in process.env - so env vars have
// to be set before that import chain resolves, not just before main() runs.
import { readFileSync } from 'fs'

try {
  const env = readFileSync('.env.local', 'utf8')
  for (const line of env.split('\n')) {
    if (!line.includes('=')) continue
    const i = line.indexOf('=')
    const key = line.slice(0, i).trim()
    // Vercel's pulled format wraps every value in double quotes - strip a
    // single matching pair (not a general unescape) so the raw value is
    // usable as-is, same as how Vercel's own runtime injects it unquoted.
    let value = line.slice(i + 1).trim()
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1)
    }
    if (key && !(key in process.env)) process.env[key] = value
  }
} catch {
  // .env.local not found - assume env vars are already set (e.g. CI).
}

const { run } = await import('./backtestRun.js')
run().catch((err: unknown) => {
  console.error('Backtest failed:', err)
  process.exit(1)
})
