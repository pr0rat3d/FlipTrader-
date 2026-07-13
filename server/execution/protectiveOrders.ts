import { placeOrder } from './alpacaClient.js'
import { clientOrderIds } from './clientOrderIds.js'

export interface ProtectiveOrderState {
  stopOrderId: string | null
  tier1OrderId: string | null
  tier2OrderId: string | null
  tier3OrderId: string | null
}

export interface ProtectiveOrderPlan {
  symbol: string
  exitSide: 'buy' | 'sell'
  qty: number // full remaining qty the resting stop should cover
  stopPrice: number
  tierQty: { tier1: number; tier2: number; tier3: number }
  tierPrices: { tier1: number; tier2: number; tier3: number }
  ids: ReturnType<typeof clientOrderIds>
}

export interface ProtectiveOrderResult extends ProtectiveOrderState {
  failure: string | null
}

// Idempotent by construction: only places whatever is still missing in
// `current` - safe to call both right after entry fills (nothing placed yet)
// and later as a reconciliation retry (some orders already went through, one
// or two failed). Same code path for both callers so they can't drift apart.
export const placeProtectiveOrders = async (
  plan: ProtectiveOrderPlan,
  current: ProtectiveOrderState
): Promise<ProtectiveOrderResult> => {
  let failure: string | null = null
  let stopOrderId = current.stopOrderId
  let tier1OrderId = current.tier1OrderId
  let tier2OrderId = current.tier2OrderId
  let tier3OrderId = current.tier3OrderId

  if (!stopOrderId) {
    try {
      const order = await placeOrder({
        symbol: plan.symbol, qty: plan.qty, side: plan.exitSide, type: 'stop', timeInForce: 'day',
        stopPrice: plan.stopPrice, clientOrderId: plan.ids.stop
      })
      stopOrderId = order.id
    } catch (e) {
      failure = `stop order failed: ${String(e)}`
    }
  }

  const tierSpecs = [
    { key: 'tier1' as const, qty: plan.tierQty.tier1, price: plan.tierPrices.tier1, clientOrderId: plan.ids.tier1, current: tier1OrderId },
    { key: 'tier2' as const, qty: plan.tierQty.tier2, price: plan.tierPrices.tier2, clientOrderId: plan.ids.tier2, current: tier2OrderId },
    { key: 'tier3' as const, qty: plan.tierQty.tier3, price: plan.tierPrices.tier3, clientOrderId: plan.ids.tier3, current: tier3OrderId }
  ]

  for (const tier of tierSpecs) {
    if (tier.current || tier.qty <= 0) continue
    try {
      const order = await placeOrder({
        symbol: plan.symbol, qty: tier.qty, side: plan.exitSide, type: 'limit', timeInForce: 'day',
        limitPrice: tier.price, clientOrderId: tier.clientOrderId
      })
      if (tier.key === 'tier1') tier1OrderId = order.id
      if (tier.key === 'tier2') tier2OrderId = order.id
      if (tier.key === 'tier3') tier3OrderId = order.id
    } catch (e) {
      failure = `${tier.key} order failed: ${String(e)}`
    }
  }

  return { stopOrderId, tier1OrderId, tier2OrderId, tier3OrderId, failure }
}
