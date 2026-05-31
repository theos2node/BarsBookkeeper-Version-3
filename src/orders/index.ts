import type { OrderRecommendation } from '../domain/types.js'
import { getInventoryPositions } from '../db/inventory.js'
import { lastInsertId, toNumber, toStringValue, type Db } from '../db/database.js'
import { generateForecasts } from '../forecast/index.js'

export type VendorOrderGroup = {
  vendorId: number
  vendorName: string
  totalEstimatedCost: number
  items: (OrderRecommendation & {
    skuId: number
    recommendationId: number
    estimatedCost: number | null
  })[]
}

export type OrderRecommendationOptions = {
  asOf?: string
  horizonDays?: number
  usageWindowDays?: number
}

const roundUpToMultiple = (value: number, multiple: number): number => {
  if (multiple <= 0) return Math.ceil(value)
  return Math.ceil(value / multiple) * multiple
}

const closeOpenRecommendationsForSku = (db: Db, skuId: number, exceptId?: number): void => {
  if (exceptId) {
    db.prepare(
      `UPDATE order_recommendations
       SET status = 'dismissed'
       WHERE sku_id = ? AND status = 'open' AND id != ?`,
    ).run(skuId, exceptId)
    return
  }

  db.prepare(
    `UPDATE order_recommendations
     SET status = 'dismissed'
     WHERE sku_id = ? AND status = 'open'`,
  ).run(skuId)
}

export const generateVendorGroupedOrderRecommendations = (
  db: Db,
  options: OrderRecommendationOptions = {},
): VendorOrderGroup[] => {
  const asOf = options.asOf ?? new Date().toISOString()
  const horizonDays = options.horizonDays ?? 7
  const forecasts = generateForecasts(db, { asOf, horizonDays, usageWindowDays: options.usageWindowDays })
  const positions = getInventoryPositions(db, { asOf, usageWindowDays: options.usageWindowDays })
  const groups = new Map<number, VendorOrderGroup>()

  for (const position of positions) {
    const forecast = forecasts.find((candidate) => candidate.skuId === position.skuId)
    const vendorItem = db
      .prepare(
        `SELECT vi.*, v.name AS vendor_name
         FROM vendor_items vi
         JOIN vendors v ON v.id = vi.vendor_id
         WHERE vi.sku_id = ? AND vi.active = 1
         ORDER BY COALESCE(vi.price, 999999), vi.lead_time_days
         LIMIT 1`,
      )
      .get(position.skuId)
    if (!forecast) continue
    if (!vendorItem) {
      closeOpenRecommendationsForSku(db, position.skuId)
      continue
    }

    const leadTimeDays = toNumber(vendorItem.lead_time_days, 2)
    const targetStock = Math.max(position.parLevel ?? 0, forecast.avgDailyUsage * (horizonDays + leadTimeDays))
    const rawNeed = targetStock - position.onHand
    if (rawNeed <= 0) {
      closeOpenRecommendationsForSku(db, position.skuId)
      continue
    }

    const packSize = Math.max(1, toNumber(vendorItem.pack_size, 1))
    const minOrderQty = Math.max(0, toNumber(vendorItem.min_order_qty))
    const recommendedQty = roundUpToMultiple(Math.max(rawNeed, minOrderQty), packSize)
    const price = vendorItem.price === null ? null : toNumber(vendorItem.price)
    const estimatedCost = price === null ? null : (recommendedQty / packSize) * price
    const reason = `Bring ${position.name} from ${position.onHand} ${position.unit} toward ${Number(targetStock.toFixed(2))} ${position.unit}`
    const vendorId = toNumber(vendorItem.vendor_id)
    const confidence = Math.min(position.confidence, forecast.confidence)
    const existing = db
      .prepare(
        `SELECT id
         FROM order_recommendations
         WHERE forecast_id = ? AND vendor_id = ? AND sku_id = ? AND status = 'open'
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(forecast.id, vendorId, position.skuId)
    const recommendationId = existing
      ? toNumber(existing.id)
      : lastInsertId(
          db
            .prepare(
              `INSERT INTO order_recommendations
               (forecast_id, vendor_id, sku_id, recommended_qty, unit, estimated_cost, reason, confidence)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(forecast.id, vendorId, position.skuId, recommendedQty, position.unit, estimatedCost, reason, confidence)
            .lastInsertRowid,
        )

    if (existing) {
      db.prepare(
        `UPDATE order_recommendations
         SET recommended_qty = ?, unit = ?, estimated_cost = ?, reason = ?, confidence = ?
         WHERE id = ?`,
      ).run(recommendedQty, position.unit, estimatedCost, reason, confidence, recommendationId)
    }
    closeOpenRecommendationsForSku(db, position.skuId, recommendationId)

    const group =
      groups.get(vendorId) ??
      {
        vendorId,
        vendorName: toStringValue(vendorItem.vendor_name),
        totalEstimatedCost: 0,
        items: [],
      }
    group.items.push({
      vendorName: group.vendorName,
      skuName: position.name,
      skuId: position.skuId,
      quantity: recommendedQty,
      unit: position.unit,
      reason,
      confidence,
      recommendationId,
      estimatedCost,
    })
    group.totalEstimatedCost += estimatedCost ?? 0
    groups.set(vendorId, group)
  }

  return [...groups.values()].map((group) => ({
    ...group,
    totalEstimatedCost: Number(group.totalEstimatedCost.toFixed(2)),
  }))
}
