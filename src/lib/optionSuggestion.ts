// Computed label only - NOT a live options quote (no chain data source is wired
// up anywhere in this app yet). Rounds the underlying signal's own entry/target
// to the nearest $1 strike, which is how SPY/QQQ/IWM weekly/0DTE strikes are
// actually spaced near the money. Rounding to nearest (not floor/ceil) means the
// suggested strike is never more than $0.50 from the real price - i.e. never
// more than one strike out - as a property of the rounding itself, not a
// separate check bolted on afterward.
const STRIKE_INCREMENT = 1

export interface OptionSuggestion {
  contractType: 'C' | 'P'
  entryStrike: number
  targetStrike: number
}

export const suggestOptionStrike = (
  direction: 'bullish' | 'bearish',
  entryPrice: number,
  targetPrice: number
): OptionSuggestion => ({
  contractType: direction === 'bullish' ? 'C' : 'P',
  entryStrike: Math.round(entryPrice / STRIKE_INCREMENT) * STRIKE_INCREMENT,
  targetStrike: Math.round(targetPrice / STRIKE_INCREMENT) * STRIKE_INCREMENT
})
