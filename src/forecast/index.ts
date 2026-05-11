import { getInventoryPositions } from '../db/inventory.js'
import { lastInsertId, stringifyJson, toNumber, type Db } from '../db/database.js'

export type ForecastOptions = {
  asOf?: string
  horizonDays?: number
  usageWindowDays?: number
}

export type ForecastRow = {
  id: number
  skuId: number
  forecastDate: string
  horizonDays: number
  avgDailyUsage: number
  confidence: number
  method: string
}

export const generateForecasts = (db: Db, options: ForecastOptions = {}): ForecastRow[] => {
  const asOf = options.asOf ?? new Date().toISOString()
  const forecastDate = asOf.slice(0, 10)
  const horizonDays = options.horizonDays ?? 7
  const positions = getInventoryPositions(db, { asOf, usageWindowDays: options.usageWindowDays ?? 28 })

  return positions.map((position) => {
    const existing = db
      .prepare('SELECT id FROM forecasts WHERE sku_id = ? AND forecast_date = ? AND horizon_days = ?')
      .get(position.skuId, forecastDate, horizonDays)
    if (existing) {
      db.prepare(
        `UPDATE forecasts
         SET avg_daily_usage = ?, confidence = ?, method = ?, generated_at = CURRENT_TIMESTAMP, evidence_json = ?
         WHERE id = ?`,
      ).run(
        position.avgDailyUsage,
        position.confidence,
        'event_usage_average',
        stringifyJson({ warningState: position.warningState, onHand: position.onHand }),
        toNumber(existing.id),
      )
      return {
        id: toNumber(existing.id),
        skuId: position.skuId,
        forecastDate,
        horizonDays,
        avgDailyUsage: position.avgDailyUsage,
        confidence: position.confidence,
        method: 'event_usage_average',
      }
    }

    const result = db
      .prepare(
        `INSERT INTO forecasts
         (sku_id, forecast_date, horizon_days, avg_daily_usage, confidence, method, evidence_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        position.skuId,
        forecastDate,
        horizonDays,
        position.avgDailyUsage,
        position.confidence,
        'event_usage_average',
        stringifyJson({ warningState: position.warningState, onHand: position.onHand }),
      )
    return {
      id: lastInsertId(result.lastInsertRowid),
      skuId: position.skuId,
      forecastDate,
      horizonDays,
      avgDailyUsage: position.avgDailyUsage,
      confidence: position.confidence,
      method: 'event_usage_average',
    }
  })
}
