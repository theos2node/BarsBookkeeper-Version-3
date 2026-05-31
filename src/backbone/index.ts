import { getInventoryPositions } from '../db/inventory.js'
import { lastInsertId, parseJson, stringifyJson, toNumber, toStringValue, withTransaction, type Db } from '../db/database.js'
import { generateForecasts } from '../forecast/index.js'
import { generateVendorGroupedOrderRecommendations } from '../orders/index.js'

export type BackboneMode = 'live' | 'simulation' | 'evaluation'

export type BackboneOptions = {
  asOf?: string
  horizonDays?: number
  usageWindowDays?: number
  mode?: BackboneMode
  environmentId?: number | null
}

export type BackbonePrediction = {
  skuId: number
  skuName: string
  unit: string
  onHand: number
  predictedOnHand: number
  predictedDaysRemaining: number | null
  avgDailyUsage: number
  confidence: number
  lowStockRisk: 'ok' | 'watch' | 'low' | 'high' | 'critical'
  recommendedOrderQty: number
  estimatedCost: number | null
  costSignal: string
  calibrationSamples: number
}

export type BackboneRunResult = {
  runId: number
  asOf: string
  horizonDays: number
  usageWindowDays: number
  predictionCount: number
  predictedStockouts: number
  lowStockCount: number
  costCuttingOptions: number
  feedbackItems: number
  calibratedSkus: number
  predictions: BackbonePrediction[]
}

type VendorCost = {
  vendorName: string
  unitCost: number | null
  packSize: number
  price: number | null
}

type Calibration = {
  sampleCount: number
  usageAdjustmentDaily: number
  confidenceAdjustment: number
  meanBottleError: number
}

const riskRank: Record<BackbonePrediction['lowStockRisk'], number> = {
  ok: 0,
  watch: 1,
  low: 2,
  high: 3,
  critical: 4,
}

const round = (value: number, decimals = 3): number => Number(value.toFixed(decimals))

const daysBetween = (left: string, right: string): number => {
  const diff = new Date(left).getTime() - new Date(right).getTime()
  if (!Number.isFinite(diff)) return 999
  return Math.max(0, diff / (24 * 60 * 60 * 1000))
}

const createRun = (db: Db, options: Required<Omit<BackboneOptions, 'environmentId'>> & { environmentId: number | null }): number =>
  lastInsertId(
    db
      .prepare(
        `INSERT INTO backbone_runs
         (environment_id, mode, as_of, horizon_days, usage_window_days, status)
         VALUES (?, ?, ?, ?, ?, 'running')`,
      )
      .run(options.environmentId, options.mode, options.asOf, options.horizonDays, options.usageWindowDays).lastInsertRowid,
  )

const finishRun = (db: Db, runId: number, status: 'completed' | 'failed', metrics: Record<string, unknown>): void => {
  db.prepare(
    `UPDATE backbone_runs
     SET status = ?, metrics_json = ?, completed_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  ).run(status, stringifyJson(metrics), runId)
}

const targetAsOf = (asOf: string, horizonDays: number): string => {
  const date = new Date(asOf)
  date.setUTCDate(date.getUTCDate() + horizonDays)
  return date.toISOString()
}

const bottleSize = (db: Db, skuId: number): number => {
  const row = db
    .prepare(
      `SELECT pack_size
       FROM vendor_items
       WHERE sku_id = ? AND active = 1
       ORDER BY pack_size ASC
       LIMIT 1`,
    )
    .get(skuId)
  return Math.max(1, toNumber(row?.pack_size, 1000))
}

const updateCalibrationForSku = (db: Db, skuId: number): void => {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS sample_count,
              AVG(error_quantity) AS mean_error,
              AVG(absolute_error_quantity) AS mean_abs_error,
              AVG(bottle_error) AS mean_bottle_error
       FROM backbone_feedback
       WHERE sku_id = ?`,
    )
    .get(skuId)

  const sampleCount = toNumber(row?.sample_count)
  if (sampleCount === 0) return
  const meanError = toNumber(row?.mean_error)
  const meanAbsError = toNumber(row?.mean_abs_error)
  const meanBottleError = toNumber(row?.mean_bottle_error)
  const usageAdjustmentDaily = round(-meanError / 7, 4)
  const confidenceAdjustment = round(-Math.min(0.3, meanBottleError * 0.2), 3)

  db.prepare(
    `INSERT INTO backbone_calibrations
     (sku_id, sample_count, mean_error_quantity, mean_abs_error_quantity, mean_bottle_error,
      usage_adjustment_daily, confidence_adjustment, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(sku_id) DO UPDATE SET
       sample_count = excluded.sample_count,
       mean_error_quantity = excluded.mean_error_quantity,
       mean_abs_error_quantity = excluded.mean_abs_error_quantity,
       mean_bottle_error = excluded.mean_bottle_error,
       usage_adjustment_daily = excluded.usage_adjustment_daily,
       confidence_adjustment = excluded.confidence_adjustment,
       updated_at = CURRENT_TIMESTAMP`,
  ).run(skuId, sampleCount, meanError, meanAbsError, meanBottleError, usageAdjustmentDaily, confidenceAdjustment)
}

export const scoreBackboneFeedback = (db: Db, options: { asOf?: string } = {}): number => {
  const asOf = options.asOf ?? new Date().toISOString()
  const countRows = db
    .prepare(
      `SELECT e.id AS count_event_id,
              e.sku_id,
              e.occurred_at,
              COALESCE(SUM(position.quantity), 0) AS actual_on_hand
       FROM inventory_events e
       JOIN inventory_events position
         ON position.sku_id = e.sku_id
        AND position.occurred_at <= e.occurred_at
       WHERE e.event_type = 'adjustment'
         AND e.occurred_at <= ?
       GROUP BY e.id
       ORDER BY e.occurred_at`,
    )
    .all(asOf)

  let created = 0
  const touchedSkus = new Set<number>()
  for (const count of countRows) {
    const skuId = toNumber(count.sku_id)
    const countEventId = toNumber(count.count_event_id)
    const occurredAt = toStringValue(count.occurred_at)
    const prediction = db
      .prepare(
        `SELECT p.id AS prediction_id,
                p.run_id,
                p.predicted_on_hand,
                r.as_of,
                r.horizon_days
         FROM backbone_predictions p
         JOIN backbone_runs r ON r.id = p.run_id
         WHERE p.sku_id = ?
           AND r.status = 'completed'
           AND datetime(r.as_of, '+' || r.horizon_days || ' days') <= datetime(?)
           AND NOT EXISTS (
             SELECT 1
             FROM backbone_feedback f
             WHERE f.prediction_id = p.id AND f.count_event_id = ?
           )
         ORDER BY datetime(r.as_of, '+' || r.horizon_days || ' days') DESC, p.id DESC
         LIMIT 1`,
      )
      .get(skuId, occurredAt, countEventId)
    if (!prediction) continue

    const predictedOnHand = toNumber(prediction.predicted_on_hand)
    const actualOnHand = toNumber(count.actual_on_hand)
    const error = round(actualOnHand - predictedOnHand, 3)
    const absoluteError = Math.abs(error)
    const bottleError = round(absoluteError / bottleSize(db, skuId), 4)
    const result = db.prepare(
      `INSERT OR IGNORE INTO backbone_feedback
       (prediction_id, run_id, sku_id, count_event_id, predicted_on_hand, actual_on_hand,
        error_quantity, absolute_error_quantity, bottle_error, evaluated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      toNumber(prediction.prediction_id),
      toNumber(prediction.run_id),
      skuId,
      countEventId,
      predictedOnHand,
      actualOnHand,
      error,
      absoluteError,
      bottleError,
      occurredAt,
    )
    if (toNumber(result.changes) > 0) {
      created += 1
      touchedSkus.add(skuId)
    }
  }

  for (const skuId of touchedSkus) updateCalibrationForSku(db, skuId)
  return created
}

const calibrationFor = (db: Db, skuId: number): Calibration => {
  const row = db.prepare('SELECT * FROM backbone_calibrations WHERE sku_id = ?').get(skuId)
  if (!row) {
    return {
      sampleCount: 0,
      usageAdjustmentDaily: 0,
      confidenceAdjustment: 0,
      meanBottleError: 0,
    }
  }
  return {
    sampleCount: toNumber(row.sample_count),
    usageAdjustmentDaily: toNumber(row.usage_adjustment_daily),
    confidenceAdjustment: toNumber(row.confidence_adjustment),
    meanBottleError: toNumber(row.mean_bottle_error),
  }
}

const cheapestVendorCost = (db: Db, skuId: number): VendorCost | null => {
  const row = db
    .prepare(
      `SELECT v.name AS vendor_name, vi.pack_size, vi.price
       FROM vendor_items vi
       JOIN vendors v ON v.id = vi.vendor_id
       WHERE vi.sku_id = ? AND vi.active = 1
       ORDER BY
         CASE WHEN vi.price IS NULL THEN 1 ELSE 0 END,
         (vi.price / NULLIF(vi.pack_size, 0)),
         vi.lead_time_days
       LIMIT 1`,
    )
    .get(skuId)
  if (!row) return null
  const packSize = Math.max(1, toNumber(row.pack_size, 1))
  const price = row.price === null ? null : toNumber(row.price)
  return {
    vendorName: toStringValue(row.vendor_name),
    unitCost: price === null ? null : price / packSize,
    packSize,
    price,
  }
}

const latestPurchaseCost = (db: Db, skuId: number): number | null => {
  const row = db
    .prepare(
      `SELECT unit_cost
       FROM inventory_events
       WHERE sku_id = ? AND event_type = 'purchase' AND unit_cost IS NOT NULL
       ORDER BY occurred_at DESC, id DESC
       LIMIT 1`,
    )
    .get(skuId)
  return row?.unit_cost === null || row?.unit_cost === undefined ? null : toNumber(row.unit_cost)
}

const highHistoricalPurchaseCost = (db: Db, skuId: number, asOf: string): number | null => {
  const row = db
    .prepare(
      `SELECT MAX(unit_cost) AS unit_cost
       FROM inventory_events
       WHERE sku_id = ?
         AND event_type = 'purchase'
         AND unit_cost IS NOT NULL
         AND occurred_at <= ?`,
    )
    .get(skuId, asOf)
  return row?.unit_cost === null || row?.unit_cost === undefined ? null : toNumber(row.unit_cost)
}

const latestCountAgeDays = (db: Db, skuId: number, asOf: string): number | null => {
  const row = db
    .prepare(
      `SELECT occurred_at
       FROM inventory_events
       WHERE sku_id = ? AND event_type = 'adjustment'
       ORDER BY occurred_at DESC, id DESC
       LIMIT 1`,
    )
    .get(skuId)
  return row?.occurred_at ? daysBetween(asOf, toStringValue(row.occurred_at)) : null
}

const shrinkRate = (db: Db, skuId: number, asOf: string, windowDays: number): number => {
  const start = new Date(new Date(asOf).getTime() - windowDays * 24 * 60 * 60 * 1000).toISOString()
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(ABS(quantity)), 0) AS shrink
       FROM inventory_events
       WHERE sku_id = ?
         AND event_type IN ('shrink', 'adjustment')
         AND quantity < 0
         AND occurred_at >= ?
         AND occurred_at <= ?`,
    )
    .get(skuId, start, asOf)
  return toNumber(row?.shrink) / Math.max(1, windowDays)
}

const weekdayUsageAverages = (db: Db, skuId: number, asOf: string, windowDays: number): Map<number, number> => {
  const start = new Date(new Date(asOf).getTime() - windowDays * 24 * 60 * 60 * 1000).toISOString()
  const rows = db
    .prepare(
      `WITH daily AS (
         SELECT CAST(strftime('%w', occurred_at) AS INTEGER) AS weekday,
                substr(occurred_at, 1, 10) AS day,
                SUM(ABS(quantity)) AS used
         FROM inventory_events
         WHERE sku_id = ?
           AND event_type = 'sale'
           AND quantity < 0
           AND occurred_at >= ?
           AND occurred_at <= ?
         GROUP BY weekday, day
       )
       SELECT weekday, AVG(used) AS avg_used
       FROM daily
       GROUP BY weekday`,
    )
    .all(skuId, start, asOf)

  return new Map(rows.map((row) => [toNumber(row.weekday), toNumber(row.avg_used)]))
}

type UsageTrend = {
  recentDailyUsage: number
  priorDailyUsage: number
  multiplier: number
  recentActiveDays: number
  priorActiveDays: number
}

type ProjectionMethod = 'weekday' | 'average' | 'trend-weekday' | 'trend-average'

const usageTrend = (db: Db, skuId: number, asOf: string): UsageTrend => {
  const asOfDate = new Date(asOf)
  const recentStart = new Date(asOfDate.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const priorStart = new Date(asOfDate.getTime() - 28 * 24 * 60 * 60 * 1000).toISOString()
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN occurred_at > ? THEN ABS(quantity) ELSE 0 END), 0) AS recent_used,
              COALESCE(SUM(CASE WHEN occurred_at > ? AND occurred_at <= ? THEN ABS(quantity) ELSE 0 END), 0) AS prior_used,
              COUNT(DISTINCT CASE WHEN occurred_at > ? THEN substr(occurred_at, 1, 10) END) AS recent_active_days,
              COUNT(DISTINCT CASE WHEN occurred_at > ? AND occurred_at <= ? THEN substr(occurred_at, 1, 10) END) AS prior_active_days
       FROM inventory_events
       WHERE sku_id = ?
         AND event_type = 'sale'
         AND quantity < 0
         AND occurred_at > ?
         AND occurred_at <= ?`,
    )
    .get(recentStart, priorStart, recentStart, recentStart, priorStart, recentStart, skuId, priorStart, asOf)

  const recentDailyUsage = toNumber(row?.recent_used) / 7
  const priorDailyUsage = toNumber(row?.prior_used) / 21
  const recentActiveDays = toNumber(row?.recent_active_days)
  const priorActiveDays = toNumber(row?.prior_active_days)
  const hasEnoughSignal = recentActiveDays >= 3 && priorActiveDays >= 7 && priorDailyUsage > 0
  if (!hasEnoughSignal) {
    return {
      recentDailyUsage: round(recentDailyUsage, 3),
      priorDailyUsage: round(priorDailyUsage, 3),
      multiplier: 1,
      recentActiveDays,
      priorActiveDays,
    }
  }

  const rawMultiplier = recentDailyUsage / priorDailyUsage
  const multiplier = Math.abs(rawMultiplier - 1) >= 0.15
    ? Math.max(0.6, Math.min(2, rawMultiplier))
    : 1
  return {
    recentDailyUsage: round(recentDailyUsage, 3),
    priorDailyUsage: round(priorDailyUsage, 3),
    multiplier: round(multiplier, 3),
    recentActiveDays,
    priorActiveDays,
  }
}

const projectedUsageForHorizon = (input: {
  db: Db
  skuId: number
  asOf: string
  horizonDays: number
  usageWindowDays: number
  fallbackDailyUsage: number
}): { totalUsage: number; dailyUsage: number; method: ProjectionMethod; trend: UsageTrend } => {
  const trend = usageTrend(input.db, input.skuId, input.asOf)
  const weekdayAverages = weekdayUsageAverages(input.db, input.skuId, input.asOf, input.usageWindowDays)
  if (weekdayAverages.size === 0) {
    const dailyUsage = input.fallbackDailyUsage * trend.multiplier
    return {
      totalUsage: round(dailyUsage * input.horizonDays, 3),
      dailyUsage: round(dailyUsage, 3),
      method: trend.multiplier === 1 ? 'average' : 'trend-average',
      trend,
    }
  }

  let totalUsage = 0
  const cursor = new Date(input.asOf)
  for (let day = 1; day <= input.horizonDays; day += 1) {
    cursor.setUTCDate(cursor.getUTCDate() + 1)
    totalUsage += (weekdayAverages.get(cursor.getUTCDay()) ?? input.fallbackDailyUsage) * trend.multiplier
  }

  return {
    totalUsage: round(totalUsage, 3),
    dailyUsage: round(totalUsage / Math.max(1, input.horizonDays), 3),
    method: trend.multiplier === 1 ? 'weekday' : 'trend-weekday',
    trend,
  }
}

const riskFor = (input: {
  predictedOnHand: number
  avgDailyUsage: number
  parLevel: number | null
  leadTimeDays: number
}): BackbonePrediction['lowStockRisk'] => {
  const daysRemaining = input.avgDailyUsage > 0 ? input.predictedOnHand / input.avgDailyUsage : null
  if (input.predictedOnHand <= 0) return 'critical'
  if (daysRemaining !== null && daysRemaining <= Math.max(1, input.leadTimeDays)) return 'high'
  if (input.parLevel !== null && input.predictedOnHand < input.parLevel * 0.5) return 'high'
  if (daysRemaining !== null && daysRemaining < 5) return 'low'
  if (input.parLevel !== null && input.predictedOnHand < input.parLevel) return 'watch'
  return 'ok'
}

const recommendationFor = (db: Db, skuId: number): { quantity: number; estimatedCost: number | null } => {
  const row = db
    .prepare(
      `SELECT recommended_qty, estimated_cost
       FROM order_recommendations
       WHERE sku_id = ? AND status = 'open'
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
    )
    .get(skuId)
  if (!row) return { quantity: 0, estimatedCost: null }
  return {
    quantity: round(toNumber(row.recommended_qty), 2),
    estimatedCost: row.estimated_cost === null ? null : round(toNumber(row.estimated_cost), 2),
  }
}

const costSignalFor = (input: {
  latestCost: number | null
  highHistoricalCost: number | null
  vendorCost: VendorCost | null
  shrinkDaily: number
  avgDailyUsage: number
}): string => {
  const referenceCost = Math.max(input.latestCost ?? 0, input.highHistoricalCost ?? 0)
  if (referenceCost > 0 && input.vendorCost?.unitCost !== null && input.vendorCost?.unitCost !== undefined) {
    const saving = referenceCost - input.vendorCost.unitCost
    if (saving > Math.max(0.01, referenceCost * 0.08)) {
      return `buy ${input.vendorCost.vendorName}: saves ${round(saving, 4)}/unit`
    }
  }
  if (input.shrinkDaily > 0 && input.avgDailyUsage > 0 && input.shrinkDaily / input.avgDailyUsage > 0.12) {
    return `audit shrink: ${round((input.shrinkDaily / input.avgDailyUsage) * 100, 1)}% of usage`
  }
  return 'none'
}

export const runBackboneModel = (db: Db, options: BackboneOptions = {}): BackboneRunResult => {
  const resolved = {
    asOf: options.asOf ?? new Date().toISOString(),
    horizonDays: options.horizonDays ?? 7,
    usageWindowDays: options.usageWindowDays ?? 28,
    mode: options.mode ?? 'live',
    environmentId: options.environmentId ?? null,
  }

  return withTransaction(db, () => {
    const feedbackItems = scoreBackboneFeedback(db, { asOf: resolved.asOf })
    const runId = createRun(db, resolved)
    try {
      generateForecasts(db, resolved)
      generateVendorGroupedOrderRecommendations(db, resolved)
      const forecasts = db
        .prepare(
          `SELECT sku_id, avg_daily_usage, confidence
           FROM forecasts
           WHERE forecast_date = ? AND horizon_days = ?`,
        )
        .all(resolved.asOf.slice(0, 10), resolved.horizonDays)
      const forecastBySku = new Map(forecasts.map((row) => [toNumber(row.sku_id), row]))
      const positions = getInventoryPositions(db, resolved)
      const predictions: BackbonePrediction[] = []

      for (const position of positions) {
        const forecast = forecastBySku.get(position.skuId)
        const calibration = calibrationFor(db, position.skuId)
        const baselineDailyUsage = Math.max(0, (forecast ? toNumber(forecast.avg_daily_usage) : position.avgDailyUsage) + calibration.usageAdjustmentDaily)
        const projectedUsage = projectedUsageForHorizon({
          db,
          skuId: position.skuId,
          asOf: resolved.asOf,
          horizonDays: resolved.horizonDays,
          usageWindowDays: resolved.usageWindowDays,
          fallbackDailyUsage: baselineDailyUsage,
        })
        const avgDailyUsage = Math.max(0, projectedUsage.dailyUsage)
        const vendorCost = cheapestVendorCost(db, position.skuId)
        const latestCost = latestPurchaseCost(db, position.skuId)
        const highHistoricalCost = highHistoricalPurchaseCost(db, position.skuId, resolved.asOf)
        const countAge = latestCountAgeDays(db, position.skuId, resolved.asOf)
        const shrinkDaily = shrinkRate(db, position.skuId, resolved.asOf, resolved.usageWindowDays)
        const leadTime = vendorCost ? 2 : 4
        const predictedOnHand = round(position.onHand - projectedUsage.totalUsage - shrinkDaily * resolved.horizonDays, 2)
        const predictedDaysRemaining = avgDailyUsage > 0 ? round(Math.max(0, predictedOnHand) / avgDailyUsage, 1) : null
        const confidencePenalty = countAge === null ? 0.15 : Math.min(0.25, countAge / 120)
        const confidence = round(
          Math.max(0.25, Math.min(0.98, Math.min(position.confidence, toNumber(forecast?.confidence, position.confidence)) - confidencePenalty + calibration.confidenceAdjustment)),
          2,
        )
        const risk = riskFor({
          predictedOnHand,
          avgDailyUsage,
          parLevel: position.parLevel,
          leadTimeDays: leadTime,
        })
        const recommendation = recommendationFor(db, position.skuId)
        const costSignal = costSignalFor({ latestCost, highHistoricalCost, vendorCost, shrinkDaily, avgDailyUsage })
        const prediction: BackbonePrediction = {
          skuId: position.skuId,
          skuName: position.name,
          unit: position.unit,
          onHand: round(position.onHand, 2),
          predictedOnHand,
          predictedDaysRemaining,
          avgDailyUsage: round(avgDailyUsage, 3),
          confidence,
          lowStockRisk: risk,
          recommendedOrderQty: recommendation.quantity,
          estimatedCost: recommendation.estimatedCost,
          costSignal,
          calibrationSamples: calibration.sampleCount,
        }
        db.prepare(
          `INSERT INTO backbone_predictions
           (run_id, sku_id, sku_name, unit, on_hand, predicted_on_hand, predicted_days_remaining,
            avg_daily_usage, confidence, low_stock_risk, recommended_order_qty, estimated_cost, cost_signal, evidence_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          runId,
          prediction.skuId,
          prediction.skuName,
          prediction.unit,
          prediction.onHand,
          prediction.predictedOnHand,
          prediction.predictedDaysRemaining,
          prediction.avgDailyUsage,
          prediction.confidence,
          prediction.lowStockRisk,
          prediction.recommendedOrderQty,
          prediction.estimatedCost,
          prediction.costSignal,
          stringifyJson({
            positionWarningState: position.warningState,
            countAgeDays: countAge,
            shrinkDaily: round(shrinkDaily, 4),
            vendorCost,
            latestCost,
            highHistoricalCost,
            calibration,
            baselineDailyUsage: round(baselineDailyUsage, 3),
            projectionMethod: projectedUsage.method,
            trend: projectedUsage.trend,
            projectedUsage: projectedUsage.totalUsage,
            targetAsOf: targetAsOf(resolved.asOf, resolved.horizonDays),
          }),
        )
        predictions.push(prediction)
      }

      predictions.sort((left, right) => {
        const riskDelta = riskRank[right.lowStockRisk] - riskRank[left.lowStockRisk]
        if (riskDelta !== 0) return riskDelta
        return left.predictedOnHand - right.predictedOnHand
      })
      const metrics = {
        predictionCount: predictions.length,
        predictedStockouts: predictions.filter((prediction) => prediction.lowStockRisk === 'critical').length,
        lowStockCount: predictions.filter((prediction) => riskRank[prediction.lowStockRisk] >= riskRank.low).length,
        costCuttingOptions: predictions.filter((prediction) => prediction.costSignal !== 'none').length,
        feedbackItems,
        calibratedSkus: predictions.filter((prediction) => prediction.calibrationSamples > 0).length,
      }
      finishRun(db, runId, 'completed', metrics)
      return {
        runId,
        asOf: resolved.asOf,
        horizonDays: resolved.horizonDays,
        usageWindowDays: resolved.usageWindowDays,
        ...metrics,
      predictions,
    }
    } catch (error) {
      finishRun(db, runId, 'failed', { error: error instanceof Error ? error.message : String(error) })
      throw error
    }
  })
}

export const getLatestBackboneRun = (db: Db): BackboneRunResult | null => {
  const run = db
    .prepare(
      `SELECT *
       FROM backbone_runs
       WHERE status = 'completed'
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
    )
    .get()
  if (!run) return null

  const predictions = db
    .prepare(
      `SELECT *
       FROM backbone_predictions
       WHERE run_id = ?
       ORDER BY
         CASE low_stock_risk
           WHEN 'critical' THEN 0
           WHEN 'high' THEN 1
           WHEN 'low' THEN 2
           WHEN 'watch' THEN 3
           ELSE 4
         END,
         predicted_on_hand`,
    )
    .all(toNumber(run.id))
    .map((row): BackbonePrediction => ({
      skuId: toNumber(row.sku_id),
      skuName: toStringValue(row.sku_name),
      unit: toStringValue(row.unit),
      onHand: toNumber(row.on_hand),
      predictedOnHand: toNumber(row.predicted_on_hand),
      predictedDaysRemaining: row.predicted_days_remaining === null ? null : toNumber(row.predicted_days_remaining),
      avgDailyUsage: toNumber(row.avg_daily_usage),
      confidence: toNumber(row.confidence),
      lowStockRisk: toStringValue(row.low_stock_risk, 'ok') as BackbonePrediction['lowStockRisk'],
      recommendedOrderQty: toNumber(row.recommended_order_qty),
      estimatedCost: row.estimated_cost === null ? null : toNumber(row.estimated_cost),
      costSignal: toStringValue(row.cost_signal, 'none'),
      calibrationSamples: parseJson<{ calibration?: Calibration }>(row.evidence_json, {}).calibration?.sampleCount ?? 0,
    }))

  const metrics = parseJson<Record<string, unknown>>(run.metrics_json, {})
  return {
    runId: toNumber(run.id),
    asOf: toStringValue(run.as_of),
    horizonDays: toNumber(run.horizon_days),
    usageWindowDays: toNumber(run.usage_window_days),
    predictionCount: toNumber(metrics.predictionCount, predictions.length),
    predictedStockouts: toNumber(metrics.predictedStockouts),
    lowStockCount: toNumber(metrics.lowStockCount),
    costCuttingOptions: toNumber(metrics.costCuttingOptions),
    feedbackItems: toNumber(metrics.feedbackItems),
    calibratedSkus: toNumber(metrics.calibratedSkus),
    predictions,
  }
}

export const ensureBackboneEnvironment = (
  db: Db,
  input: { name: string; dbPath: string; description?: string | null },
): number => {
  const existing = db.prepare('SELECT id FROM backbone_environments WHERE name = ?').get(input.name)
  if (existing) {
    db.prepare(
      `UPDATE backbone_environments
       SET db_path = ?, description = COALESCE(?, description), last_run_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    ).run(input.dbPath, input.description ?? null, toNumber(existing.id))
    return toNumber(existing.id)
  }
  return lastInsertId(
    db
      .prepare(
        `INSERT INTO backbone_environments (name, db_path, description, last_run_at)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP)`,
      )
      .run(input.name, input.dbPath, input.description ?? null).lastInsertRowid,
  )
}
