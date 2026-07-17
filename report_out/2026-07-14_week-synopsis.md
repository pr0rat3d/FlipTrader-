# FlipTrader Weekly Synopsis — Week of 2026-07-13

Three live-fire sessions of the options execution bot (paper trading): 7/15, 7/16, 7/17. This is a synthesis across all three, organized by market-day archetype, since the week happened to produce a clean example of each of the regimes that matter most for this strategy.

---

## The week in one line

**Account: $2,000.00 → $914.27 (-54.3%).** One good day (+2.9%), then two bad ones that compounded (-22.0%, then -43.0% of what was left). The account is effectively halved. This synopsis exists to answer: what pattern connects the two bad days, and what's different about the one good one.

| Date | Regime | Day P&L | Account close | Cumulative |
|---|---|---:|---:|---:|
| 7/15 | Supertrend (felt like one for hours, wasn't by the close) | +2.9% | $2,058.48 | +2.9% |
| 7/16 | Controlled bleedout | -22.0% | $1,604.95 | -19.8% |
| 7/17 | Sharp two-sided, market closed green | -43.0% | $914.27 | **-54.3%** |

---

## Regime 1: The supertrend day (7/15)

All three indices spiked in the first 6-8 minutes, faded hard into a shared midday low, recovered into a local afternoon peak, then genuinely reversed and chopped into the close. Ended the week's only positive day (+$62 realized), but the report from that day itself notes it "wasn't a trend day by the close, despite feeling like one intraday for several hours at a time."

**What worked**: IV signals caught the tradeable legs. 100% of the day's real capital went through IV — every winner and every loser.

**What didn't get tested**: ORB fired 7 times (all sub-0.61 confidence, below its own floor) and never traded. TTTF/DTTF/STTF never fired at all. A real reversal at 2:36pm was structurally missed because RSI-divergence and MACD-curl confirmation lag each other by design.

**Gaps flagged that day, still open**: order-placement 403/422 failures (unresolved all week, see below), no daily loss limit (unresolved all week, see below), same-symbol pyramiding into whipsaw (partially addressed later in the week via the momentum-reset gate, see Regime 3).

---

## Regime 2: The controlled bleedout (7/16)

A grinding, orderly stair-step decline from ~12:05pm ET through the close, after a morning peak. Not violent — just a steady, one-directional bleed, hence "controlled." This is the day that did the most *diagnostic* work of the week, even though it also lost money.

**Root cause found and fixed**: `pdl_bounce`/`pdh_rejection` (the IV sub-signal behind most of the week's reversal bets) was firing on mere 1% price proximity to the prior-day high/low, with no requirement that a bounce was actually happening. 22 of the last 24 `pdl_bounce` trades had stopped out regardless of confidence (0.78-0.98) — confidence tracked zero correlation with outcome. Fixed to require an actual tested-and-reclaimed level. Verified live within an hour of shipping.

**Also shipped that day**: a tighter 10/15/20/25/30% scalper tier ladder (no runner), which on a 90-day backtest of the *fixed* signal swung the result from -$1,508 to +$3,139 — the single largest backtested improvement of the week.

**The gap that mattered most this day**: a genuine, clean bearish ORB continuation setup existed almost the entire stair-step decline and was blocked every time by the daily-trend-alignment gate — SPY's daily EMA50 sat well above its EMA200 (a multi-month uptrend), so ORB's bearish thesis was structurally locked out regardless of how clean the intraday breakdown looked. **This is a real, unsolved design tension**: a fix was proposed and tested (an intraday-VWAP OR-gate) the following day, and it made things dramatically worse in aggregate (see Regime 3) — so the daily-trend gate is doing more good than it cost on 7/16, but the underlying tension (multi-month trend vs. today's realized trend) is still open.

---

## Regime 3: Sharp two-sided moves (7/17)

Gapped down hard, bounced hard, pulled back, bounced again, declined sharply in the afternoon — and the underlying **closed green on all three indices** (SPY +0.15%, QQQ +0.52%, IWM +0.65%). The account lost 43% of its value on a day the market went up. That gap between "the market was fine" and "the account was not" is the single most important fact of the week.

**Root cause found and fixed live, mid-session**: `DIV` (a signal type added after the momentum-reset gate was built for `IV`/`ORB`) was never given the same protection. It re-fired 7 times on QQQ/IWM within a 12-minute chop stretch, each entry stopped by leverage before the next fired. Fixed and deployed same-day (`5c6798f`), confirmed no further re-fires through the close.

**Three hypotheses tested and rejected** (all correctly, backed by 90-day data, not intuition):
- Widening ORB's stop to give momentum trades room to survive chop — worse at every width tested, dramatically worse at 30%.
- An intraday-VWAP trend gate for ORB, to address the Regime-2 finding directly — made the 90-day backtest go from +$3,139 to -$1,771.
- A capital-based daily cap instead of a flat count — worse than count-based at every budget level, because fast capital recycling let *more* total trades through, not fewer.

**Two market-prediction questions tested directly, both came back negative** for this specific 90-day, 10-symbol dataset: "buy the gap-down dip within a still-bullish trend" (coin flip, slightly negative), and "short daily-overbought" (loses money both same-day and over the following week). The one positive finding: gap-**aligned**-with-trend continuation showed real signal (+0.20% avg, ~60% continuation rate) — further evidence that trend-alignment, not reversal-chasing, is where this system's actual edge lives.

**One confirmed-rare tail event**: a stop triggered correctly at its intended 15% threshold but filled at 33.3% due to a sub-second liquidity flash-dip — checked against all 21 stops since 7/16, this was the only one to slip meaningfully past its trigger. Real, but rare.

---

## What connects the two bad days

Both 7/16 and 7/17's losses trace to the **same structural pattern**: the bot's signal mix is heavily weighted toward reversal theses (`IV`'s `pdl_bounce`/`pdh_rejection`, `DTTF`/`TTTF`/`STTF`'s RSI divergence, `DIV`'s early pre-confirmation), and this week's actual market behavior consistently punished betting against the prevailing move — whether that move was the 7/16 stair-step decline or the countless small chop-swings of 7/17. `ORB`, the one pure continuation signal, is also the most gate-constrained (blocked by the daily-trend gate on 7/16, base-confidence-capped on 7/15) and is structurally the hardest of the five types to actually get a trade out of, despite showing the most real edge when it *does* fire.

Today's direct backtests of "buy the dip" and "short the overbought" both came back with no real edge in this market — reinforcing that this week wasn't unlucky variance on a sound reversal strategy, it's a mismatch between what the signal mix is built to catch (reversals) and what the market has actually been doing (trending, with sharp-but-temporary counter-moves that don't turn into real reversals).

---

## Open gaps, ranked by how many days they've now cost

1. **403/422 order-placement failures** — flagged 7/15, still unresolved, recurred 7/17 and blocked a 0.98-confidence signal from ever trading. Three days old, zero root-cause progress. Highest priority.
2. **No daily-loss circuit breaker** — flagged 7/15, still not built. 7/17's 43% single-day drawdown is the clearest case yet for why this can't wait.
3. **The reversal-heavy signal mix vs. a trending market** — not a bug, a design imbalance now backed by two independent 90-day empirical tests (gap-fade, overbought-short) plus two days of live evidence. Worth a real conversation about rebalancing which signal types get priority, not just tuning confidence floors.
4. **ORB's daily-trend gate blocking real intraday trend days** — found 7/16, one fix attempt rejected 7/17 (net negative). Still unsolved; needs a smarter design, not a blunter one.
5. **Signal-type gate parity** (the DIV gap) — found and fixed 7/17, but raises the question of whether other signal types have similar unaudited gaps.
6. **Rare stop-market slippage** — confirmed real but rare (1-in-21) on 7/17; a stop-limit design is a candidate fix, not yet built or backtested.

## Carried into next week

- [ ] Root-cause 403/422 (oldest open item, now 3 days overdue)
- [ ] Build and backtest a daily-loss circuit breaker
- [ ] Revert the daily entry cap from uncapped back to 10 before the next live session
- [ ] Design and test a smarter ORB intraday-trend gate (the VWAP attempt was too blunt)
- [ ] Have the harder conversation about signal-mix rebalancing given two independent negative results on reversal-chasing this week
- [ ] Consider a stop-limit order design for the rare slippage tail risk
- [ ] Audit remaining signal types for gate-parity gaps like the one found in DIV
