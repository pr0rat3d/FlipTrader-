import React, { useEffect, useState } from 'react'
import { Alert, ProfitTarget } from '../types'
import { getTierColor, getTierLabel } from '../lib/alerts'
import { getProfitTargetsForAlert } from '../lib/supabase'
import { suggestOptionStrike } from '../lib/optionSuggestion'

interface AlertCardProps {
  alert: Alert
  livePrices?: Record<string, number | null>
  occurrenceCount?: number
  firstSeenAt?: string
}

const MILESTONE_COLOR_HIT = '#4ade80'
const MILESTONE_COLOR_NEXT = '#facc15'
const MILESTONE_COLOR_PENDING = '#6b7280'

// Scale-out ladder for one leg: 10/20/30% of the entry->target distance, plus
// the full target itself. `milestone_X_hit_at`/`target_hit_at` are set by the
// live per-minute tracker (track-profit-targets.ts) the moment price actually
// crosses each level, so "hit" here reflects the real trade, not a live
// recompute against current price - the two agree except for that tracker's
// own ~18s-worst-case lag. The first not-yet-hit step is called out as
// "next" so it reads as an answer to "what's coming up," not just a static
// list of five numbers.
const MilestoneLadder: React.FC<{ leg: ProfitTarget }> = ({ leg }) => {
  const steps = [
    { label: '10%', price: leg.milestone_10_price, hitAt: leg.milestone_10_hit_at },
    { label: '20%', price: leg.milestone_20_price, hitAt: leg.milestone_20_hit_at },
    { label: '30%', price: leg.milestone_30_price, hitAt: leg.milestone_30_hit_at },
    { label: 'Target', price: leg.target_50ema_price, hitAt: leg.target_hit_at ?? null }
  ].filter((step): step is { label: string; price: number; hitAt: string | null } => step.price != null)

  const nextIndex = steps.findIndex(step => !step.hitAt)

  return (
    <div className="flex mt-1" style={{ gap: 4 }}>
      {steps.map((step, i) => {
        const hit = !!step.hitAt
        const isNext = i === nextIndex
        const color = hit ? MILESTONE_COLOR_HIT : isNext ? MILESTONE_COLOR_NEXT : MILESTONE_COLOR_PENDING
        const isLast = i === steps.length - 1
        return (
          <div
            key={step.label}
            className="flex-1 text-center rounded"
            style={{ padding: '3px 2px', background: hit ? 'rgba(74,222,128,0.15)' : isNext ? 'rgba(250,204,21,0.12)' : '#1f2937', border: `1px solid ${color}` }}
            title={
              hit
                ? `Hit at ${new Date(step.hitAt!).toLocaleTimeString()} - take your scheduled slice here`
                : isNext
                  ? 'Next level up - the one to watch right now'
                  : 'Not yet reached'
            }
          >
            <div style={{ fontSize: 9, fontWeight: 'bold', color }}>
              {hit ? '✓ ' : ''}{step.label}{isLast && ' (runner)'}
            </div>
            <div className="text-xs font-bold text-white">${step.price.toFixed(2)}</div>
          </div>
        )
      })}
    </div>
  )
}

export const AlertCard: React.FC<AlertCardProps> = ({ alert, livePrices, occurrenceCount, firstSeenAt }) => {
  const tierColor = getTierColor(alert.ttf_status)
  const tierLabel = getTierLabel(alert.ttf_status)
  // macd_curl is always populated (both signal types require it), unlike
  // rsi_divergence which is null for IV alerts - use it as the direction source.
  const isBullish = alert.macd_curl === 'bullish'
  const isIV = alert.ttf_status === 'IV'
  const isORB = alert.ttf_status === 'ORB'

  // day_trade_alerts.entry_price/target_50ema are a single blended number even for a
  // DTF/TTF alert (2-3 symbols) - blending an ~$600 SPY price with an ~$220 IWM price
  // was never meaningful. profit_targets now has one row per triggered symbol with
  // its own real entry/target, so fetch those for an accurate per-symbol breakdown.
  const [legs, setLegs] = useState<ProfitTarget[]>([])

  useEffect(() => {
    let cancelled = false
    getProfitTargetsForAlert(alert.id)
      .then(data => { if (!cancelled) setLegs(data || []) })
      .catch(err => console.error('Error loading profit targets for alert:', err))
    return () => { cancelled = true }
  }, [alert.id])

  return (
    <div className="p-4 bg-gray-800 border-l-4 rounded mb-3" style={{ borderColor: tierColor }}>
      <div className="flex justify-between items-start mb-2">
        <div>
          <h3 className="text-lg font-bold text-white">{alert.symbol}</h3>
          <p className="text-sm text-gray-400">{new Date(alert.timestamp).toLocaleTimeString()}</p>
          {occurrenceCount != null && occurrenceCount > 1 && firstSeenAt && (
            <p className="text-xs text-gray-500">
              Continuation - {occurrenceCount}x since {new Date(firstSeenAt).toLocaleTimeString()}
            </p>
          )}
        </div>
        <span className="px-3 py-1 rounded-full text-white text-sm font-bold" style={{ backgroundColor: tierColor }}>
          {alert.ttf_status} - {tierLabel}
        </span>
      </div>

      <div className="mb-2">
        <p className="text-gray-400 text-sm">Signal</p>
        <p className={`font-bold ${isBullish ? 'text-green-400' : 'text-red-400'}`}>
          {isBullish ? '↑ BULLISH' : '↓ BEARISH'}
        </p>
      </div>

      {alert.confidence != null && (
        <div className="flex items-center mb-2" style={{ gap: 8 }}>
          <span className="text-xs text-gray-400" style={{ width: 66, flexShrink: 0 }}>Confidence</span>
          <div style={{ flex: 1, background: '#374151', borderRadius: 3, height: 8, overflow: 'hidden' }}>
            <div style={{ width: `${Math.round(alert.confidence * 100)}%`, background: tierColor, height: '100%' }} />
          </div>
          <span className="text-xs text-white font-bold" style={{ width: 36, textAlign: 'right', flexShrink: 0 }}>
            {Math.round(alert.confidence * 100)}%
          </span>
        </div>
      )}

      <div className="bg-gray-700 p-2 rounded mb-2 text-xs">
        <p className="text-gray-300 mb-1">
          {isIV ? (
            <>
              <strong>Early Momentum:</strong> {alert.confluence_type}
              {alert.confluence_level != null && ` at $${alert.confluence_level.toFixed(2)}`}
            </>
          ) : isORB ? (
            <>
              <strong>Breakout Continuation:</strong> {alert.orb_breakout_direction} beyond opening range
            </>
          ) : (
            <>
              <strong>Full Confluence:</strong> RSI {alert.rsi_divergence} + MACD {alert.macd_curl}
            </>
          )}
        </p>
        {isORB && alert.orh != null && <p className="text-gray-400">OR High: ${alert.orh.toFixed(2)}</p>}
        {isORB && alert.orl != null && <p className="text-gray-400">OR Low: ${alert.orl.toFixed(2)}</p>}
        {alert.pdh != null && <p className="text-gray-400">PDH: ${alert.pdh.toFixed(2)}</p>}
        {alert.pdl != null && <p className="text-gray-400">PDL: ${alert.pdl.toFixed(2)}</p>}
        {alert.pdc != null && <p className="text-gray-400">PDC: ${alert.pdc.toFixed(2)}</p>}
        {(alert.gap_up || alert.gap_down) && (
          <p className={`font-bold ${alert.gap_up ? 'text-green-400' : 'text-red-400'}`}>
            Gap {alert.gap_up ? 'UP' : 'DOWN'}
          </p>
        )}
        {alert.orb_breakout_direction && (
          <p className={`font-bold ${alert.orb_breakout_direction === 'bullish' ? 'text-green-400' : 'text-red-400'}`}>
            ORB: {alert.orb_breakout_direction === 'bullish' ? 'Bullish' : 'Bearish'} breakout
          </p>
        )}
        {isORB && (() => {
          // Pullback level is the OR boundary that just got broken - it's the
          // level that made this an ORB signal in the first place, now acting
          // as support (bullish) or resistance (bearish) on a retest.
          const pullback = isBullish ? alert.orh : alert.orl
          if (pullback == null) return null
          const momentumPrice = livePrices?.[legs[0]?.symbol] ?? legs[0]?.entry_price
          return (
            <p className="text-yellow-400 font-bold mt-1">
              Ideal Entry: momentum now{momentumPrice != null && ` (~$${momentumPrice.toFixed(2)})`}, or pullback to ~${pullback.toFixed(2)} (former OR {isBullish ? 'high, now support' : 'low, now resistance'})
            </p>
          )
        })()}
        {isIV && alert.confluence_level != null && (
          <p className="text-yellow-400 font-bold mt-1">
            Ideal Entry: ~${alert.confluence_level.toFixed(2)} (at the {alert.confluence_type} level - don't chase, let it come to you)
          </p>
        )}
      </div>

      {legs.length > 0 ? (
        <div className="space-y-2">
          {legs.map(leg => {
            const priceChange = ((leg.target_50ema_price - leg.entry_price) / leg.entry_price * 100).toFixed(2)
            // Falls back to the frozen entry price until the live feed has a
            // value for this symbol, so R:R shows the original at-signal-time
            // number rather than a blank/"—" flash on first render.
            const livePrice = livePrices?.[leg.symbol]
            const currentPrice = livePrice ?? leg.entry_price
            return (
              <div key={leg.id} className="p-2 bg-gray-700 rounded">
                <div className="flex justify-between items-center">
                  <span className="font-bold text-white">{leg.symbol}</span>
                  <span className={`text-sm font-bold ${parseFloat(priceChange) > 0 ? 'text-green-400' : 'text-red-400'}`}>
                    {priceChange}% to target
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs mt-1">
                  <span className="text-gray-400">Entry <span className="text-white font-bold">${leg.entry_price.toFixed(2)}</span></span>
                  <span className="text-gray-400">
                    Current <span className="text-white font-bold">${currentPrice.toFixed(2)}</span>
                    {livePrice != null && <span className="text-green-400" title="Live price">  ●</span>}
                  </span>
                  <span className="text-gray-400">Target <span className="text-white font-bold">${leg.target_50ema_price.toFixed(2)}</span></span>
                  {leg.stop_loss_price != null && (
                    <span className="text-gray-400">Stop <span className="text-red-400 font-bold">${leg.stop_loss_price.toFixed(2)}</span></span>
                  )}
                  {leg.stop_loss_price != null && (() => {
                    const risk = Math.abs(currentPrice - leg.stop_loss_price)
                    const reward = Math.abs(leg.target_50ema_price - currentPrice)
                    return risk > 0 ? (
                      <span className="text-gray-400">R:R <span className="text-white font-bold">1:{(reward / risk).toFixed(1)}</span></span>
                    ) : null
                  })()}
                </div>
                <MilestoneLadder leg={leg} />
                {(() => {
                  // IV's whole thesis is a reversal AT the confluence level (the
                  // level shown in "Ideal Entry" above), not wherever price
                  // happens to be by the time the alert fired - basing the
                  // strike on leg.entry_price instead would pick a strike
                  // already past the level the reversal is actually pivoting
                  // on. ORB/TTF/DTF/STF keep using entry_price - "straightforward,
                  // nearest strike to where price actually is."
                  //
                  // confluence_level is computed from ONE representative symbol
                  // (SPY when triggered, else the first triggered symbol - see
                  // scan-confluence.ts) and stored once per alert, not per leg -
                  // applying a SPY-scale level to a QQQ/IWM leg would suggest a
                  // nonsense strike (e.g. "753 P" on a stock trading at $720).
                  // Only the representative leg gets the confluence-level basis;
                  // every other leg in the same multi-symbol alert falls back to
                  // its own entry_price, same as ORB/TTF/DTF/STF.
                  const representativeSymbol = alert.indices_triggered.includes('SPY') ? 'SPY' : alert.indices_triggered[0]
                  const isRepresentativeLeg = leg.symbol === representativeSymbol
                  const strikeBasisPrice = isIV && isRepresentativeLeg && alert.confluence_level != null ? alert.confluence_level : leg.entry_price
                  const opt = suggestOptionStrike(isBullish ? 'bullish' : 'bearish', strikeBasisPrice, leg.target_50ema_price)
                  return (
                    <p className="text-xs text-gray-500 mt-1">
                      Options (computed, not a live quote): <span className="text-white font-bold">{leg.symbol} {opt.entryStrike}{opt.contractType}</span>
                      {' '}· target ~{opt.targetStrike}
                      {leg.stop_loss_price != null && ` · invalidate ${isBullish ? 'below' : 'above'} $${leg.stop_loss_price.toFixed(2)}`}
                    </p>
                  )
                })()}
              </div>
            )
          })}
          <p className="text-xs text-gray-500">Scale out a slice at each level as it's hit; hold the rest past Target as a runner.</p>
        </div>
      ) : (
        <p className="text-xs text-gray-400">Indices: {alert.indices_triggered.join('/')}</p>
      )}
    </div>
  )
}
