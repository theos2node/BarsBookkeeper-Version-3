import type { InventoryPosition } from '../domain/types.js'
import { toNumber, toStringValue, type Db } from './database.js'

const dayMs = 24 * 60 * 60 * 1000

export type InventoryPositionOptions = {
  asOf?: string
  usageWindowDays?: number
}

type SkuRow = {
  id: number
  name: string
  unit: string
  category: string | null
  parLevel: number | null
}

const readSkus = (db: Db): SkuRow[] =>
  db
    .prepare('SELECT id, name, unit, category, par_level FROM skus ORDER BY name')
    .all()
    .map((row) => ({
      id: toNumber(row.id),
      name: toStringValue(row.name),
      unit: toStringValue(row.unit),
      category: row.category === null ? null : toStringValue(row.category),
      parLevel: row.par_level === null ? null : toNumber(row.par_level),
    }))

const averageDailyUsage = (db: Db, skuId: number, asOf: string, windowDays: number): { usage: number; confidence: number } => {
  const start = new Date(new Date(asOf).getTime() - windowDays * dayMs).toISOString()
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(ABS(quantity)), 0) AS used,
              COUNT(DISTINCT substr(occurred_at, 1, 10)) AS active_days
       FROM inventory_events
       WHERE sku_id = ?
         AND event_type IN ('sale', 'shrink')
         AND quantity < 0
         AND occurred_at >= ?
         AND occurred_at <= ?`,
    )
    .get(skuId, start, asOf)

  const used = toNumber(row?.used)
  const activeDays = toNumber(row?.active_days)
  return {
    usage: used / windowDays,
    confidence: Math.max(0.35, Math.min(0.95, activeDays / Math.min(windowDays, 14))),
  }
}

const warningState = (onHand: number, parLevel: number | null, avgDailyUsage: number): InventoryPosition['warningState'] => {
  const daysRemaining = avgDailyUsage > 0 ? onHand / avgDailyUsage : null
  if (onHand <= 0) return 'critical'
  if (daysRemaining !== null && daysRemaining < 2) return 'critical'
  if (parLevel !== null && onHand < parLevel * 0.5) return 'low'
  if (daysRemaining !== null && daysRemaining < 5) return 'low'
  if (parLevel !== null && onHand < parLevel) return 'watch'
  return 'ok'
}

export const getInventoryPositions = (db: Db, options: InventoryPositionOptions = {}): InventoryPosition[] => {
  const asOf = options.asOf ?? new Date().toISOString()
  const usageWindowDays = options.usageWindowDays ?? 28

  return readSkus(db).map((sku) => {
    const onHandRow = db
      .prepare('SELECT COALESCE(SUM(quantity), 0) AS on_hand FROM inventory_events WHERE sku_id = ? AND occurred_at <= ?')
      .get(sku.id, asOf)
    const onHand = toNumber(onHandRow?.on_hand)
    const usage = averageDailyUsage(db, sku.id, asOf, usageWindowDays)
    const daysRemaining = usage.usage > 0 ? onHand / usage.usage : null

    return {
      skuId: sku.id,
      name: sku.name,
      unit: sku.unit,
      category: sku.category,
      onHand,
      parLevel: sku.parLevel,
      avgDailyUsage: Number(usage.usage.toFixed(3)),
      daysRemaining: daysRemaining === null ? null : Number(daysRemaining.toFixed(1)),
      confidence: Number(usage.confidence.toFixed(2)),
      warningState: warningState(onHand, sku.parLevel, usage.usage),
    }
  })
}

export const getInventoryPosition = (db: Db, skuId: number, options: InventoryPositionOptions = {}): InventoryPosition | null =>
  getInventoryPositions(db, options).find((position) => position.skuId === skuId) ?? null
