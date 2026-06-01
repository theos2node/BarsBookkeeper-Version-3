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

type VendorOrderItem = {
  id: number
  vendor_id: number
  vendor_name: string
  lead_time_days: number | null
  min_order_qty: number | null
  effective_pack_size: number | null
  effective_price: number | null
  effective_unit_cost: number | null
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
        `WITH price_candidates AS (
           SELECT vi.id,
                  vi.vendor_id,
                  v.name AS vendor_name,
                  vi.lead_time_days,
                  vi.min_order_qty,
                  vi.pack_size AS catalog_pack_size,
                  vi.price AS catalog_price,
                  observed.pack_size AS observed_pack_size,
                  observed.price AS observed_price,
                  observed.unit_cost AS observed_unit_cost,
                  EXISTS (
                    SELECT 1
                    FROM vendor_item_prices vip_any
                    WHERE vip_any.vendor_item_id = vi.id
                  ) AS has_price_observations
           FROM vendor_items vi
           JOIN vendors v ON v.id = vi.vendor_id
           LEFT JOIN vendor_item_prices observed
             ON observed.id = (
               SELECT vip.id
               FROM vendor_item_prices vip
               WHERE vip.vendor_item_id = vi.id
                 AND vip.observed_at <= ?
               ORDER BY vip.observed_at DESC, vip.id DESC
               LIMIT 1
             )
           WHERE vi.sku_id = ? AND vi.active = 1
         )
         SELECT id,
                vendor_id,
                vendor_name,
                lead_time_days,
                min_order_qty,
                COALESCE(observed_pack_size, catalog_pack_size) AS effective_pack_size,
                COALESCE(
                  observed_price,
                  observed_unit_cost * COALESCE(observed_pack_size, catalog_pack_size),
                  CASE WHEN has_price_observations = 0 THEN catalog_price END
                ) AS effective_price,
                COALESCE(
                  observed_unit_cost,
                  CASE WHEN has_price_observations = 0 THEN catalog_price / NULLIF(catalog_pack_size, 0) END
                ) AS effective_unit_cost
         FROM price_candidates
         ORDER BY
           CASE WHEN effective_unit_cost IS NULL THEN 1 ELSE 0 END,
           effective_unit_cost,
           lead_time_days
         LIMIT 1`,
      )
      .get(asOf, position.skuId) as VendorOrderItem | undefined
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

    const packSize = Math.max(1, toNumber(vendorItem.effective_pack_size, 1))
    const minOrderQty = Math.max(0, toNumber(vendorItem.min_order_qty))
    const recommendedQty = roundUpToMultiple(Math.max(rawNeed, minOrderQty), packSize)
    const price = vendorItem.effective_price === null ? null : toNumber(vendorItem.effective_price)
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
