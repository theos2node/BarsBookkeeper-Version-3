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
  maxFeedbackTargetAgeDays?: number
}

export type BackbonePrediction = {
  skuId: number
  skuName: string
  unit: string
  onHand: number
  predictedOnHand: number
  predictedLowerOnHand: number
  predictedUpperOnHand: number
  predictedDaysRemaining: number | null
  stockoutProbability: number
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

export type UnscoredCountFeedback = {
  countEventId: number
  skuId: number
  skuName: string
  unit: string
  occurredAt: string
  actualOnHand: number
  latestTargetAt: string
  targetAgeDays: number | null
  reason: 'no_prediction_target' | 'stale_prediction_target'
}

type VendorCost = {
  vendorName: string
  unitCost: number | null
  packSize: number
  price: number | null
  leadTimeDays: number
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

const calibrationHalfLifeDays = 45
export const defaultFeedbackTargetAgeDays = 14

const countGroundingPredicate = (eventAlias: string): string => `(
  EXISTS (
    SELECT 1
    FROM evidence_items count_evidence
    WHERE count_evidence.inventory_event_id = ${eventAlias}.id
      AND count_evidence.evidence_type = 'inventory_count'
  )
  OR EXISTS (
    SELECT 1
    FROM source_documents count_document
    WHERE count_document.id = ${eventAlias}.source_document_id
      AND count_document.document_type = 'count'
  )
)`

const recencyWeight = (evaluatedAt: string, latestEvaluatedAt: string): number => {
  const latestTime = new Date(latestEvaluatedAt).getTime()
  const evaluatedTime = new Date(evaluatedAt).getTime()
  if (!Number.isFinite(latestTime) || !Number.isFinite(evaluatedTime)) return 1
  const ageDays = Math.max(0, (latestTime - evaluatedTime) / (24 * 60 * 60 * 1000))
  return Math.pow(0.5, ageDays / calibrationHalfLifeDays)
}

const updateCalibrationForSku = (db: Db, skuId: number): void => {
  const rows = db
    .prepare(
      `SELECT error_quantity,
              absolute_error_quantity,
              bottle_error,
              evaluated_at
       FROM backbone_feedback
       WHERE sku_id = ?
       ORDER BY evaluated_at`,
    )
    .all(skuId)

  const sampleCount = rows.length
  if (sampleCount === 0) return
  const latestEvaluatedAt = rows.reduce((latest, row) => {
    const evaluatedAt = toStringValue(row.evaluated_at)
    return !latest || new Date(evaluatedAt).getTime() > new Date(latest).getTime() ? evaluatedAt : latest
  }, '')
  let totalWeight = 0
  let weightedError = 0
  let weightedAbsError = 0
  let weightedBottleError = 0
  for (const row of rows) {
    const weight = recencyWeight(toStringValue(row.evaluated_at), latestEvaluatedAt)
    totalWeight += weight
    weightedError += toNumber(row.error_quantity) * weight
    weightedAbsError += toNumber(row.absolute_error_quantity) * weight
    weightedBottleError += toNumber(row.bottle_error) * weight
  }

  const meanError = round(weightedError / Math.max(1, totalWeight), 3)
  const meanAbsError = round(weightedAbsError / Math.max(1, totalWeight), 3)
  const meanBottleError = round(weightedBottleError / Math.max(1, totalWeight), 4)
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

export const scoreBackboneFeedback = (db: Db, options: { asOf?: string; maxTargetAgeDays?: number } = {}): number => {
  const asOf = options.asOf ?? new Date().toISOString()
  const maxTargetAgeDays = Math.max(0, options.maxTargetAgeDays ?? defaultFeedbackTargetAgeDays)
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
         AND ${countGroundingPredicate('e')}
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
    const oldestTargetAt = new Date(new Date(occurredAt).getTime() - maxTargetAgeDays * 24 * 60 * 60 * 1000).toISOString()
    const prediction = db
      .prepare(
        `SELECT p.id AS prediction_id,
                p.run_id,
                p.predicted_on_hand,
                p.predicted_lower_on_hand,
                p.predicted_upper_on_hand,
                p.stockout_probability,
                r.as_of,
                r.horizon_days
         FROM backbone_predictions p
         JOIN backbone_runs r ON r.id = p.run_id
         WHERE p.sku_id = ?
           AND r.status = 'completed'
           AND datetime(r.as_of, '+' || r.horizon_days || ' days') <= datetime(?)
           AND datetime(r.as_of, '+' || r.horizon_days || ' days') >= datetime(?)
           AND NOT EXISTS (
             SELECT 1
             FROM backbone_feedback f
             WHERE f.prediction_id = p.id AND f.count_event_id = ?
           )
         ORDER BY datetime(r.as_of, '+' || r.horizon_days || ' days') DESC, p.id DESC
         LIMIT 1`,
      )
      .get(skuId, occurredAt, oldestTargetAt, countEventId)
    if (!prediction) continue

    const predictedOnHand = toNumber(prediction.predicted_on_hand)
    const predictedLowerOnHand =
      prediction.predicted_lower_on_hand === null || prediction.predicted_lower_on_hand === undefined
        ? predictedOnHand
        : toNumber(prediction.predicted_lower_on_hand)
    const predictedUpperOnHand =
      prediction.predicted_upper_on_hand === null || prediction.predicted_upper_on_hand === undefined
        ? predictedOnHand
        : toNumber(prediction.predicted_upper_on_hand)
    const actualOnHand = toNumber(count.actual_on_hand)
    const inBand = actualOnHand >= predictedLowerOnHand && actualOnHand <= predictedUpperOnHand ? 1 : 0
    const stockoutProbability =
      prediction.stockout_probability === null || prediction.stockout_probability === undefined
        ? null
        : toNumber(prediction.stockout_probability)
    const error = round(actualOnHand - predictedOnHand, 3)
    const absoluteError = Math.abs(error)
    const bottleError = round(absoluteError / bottleSize(db, skuId), 4)
    const result = db.prepare(
      `INSERT OR IGNORE INTO backbone_feedback
       (prediction_id, run_id, sku_id, count_event_id, predicted_on_hand, actual_on_hand,
        predicted_lower_on_hand, predicted_upper_on_hand, in_band, stockout_probability,
        error_quantity, absolute_error_quantity, bottle_error, evaluated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      toNumber(prediction.prediction_id),
      toNumber(prediction.run_id),
      skuId,
      countEventId,
      predictedOnHand,
      actualOnHand,
      predictedLowerOnHand,
      predictedUpperOnHand,
      inBand,
      stockoutProbability,
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

const cheapestVendorCost = (db: Db, skuId: number, asOf: string): VendorCost | null => {
  const row = db
    .prepare(
      `SELECT v.name AS vendor_name,
              vi.pack_size AS catalog_pack_size,
              vi.price AS catalog_price,
              vi.lead_time_days,
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
       ORDER BY
         CASE
           WHEN observed.unit_cost IS NOT NULL THEN 0
           WHEN has_price_observations = 0 AND vi.price IS NOT NULL THEN 0
           ELSE 1
         END,
         COALESCE(
           observed.unit_cost,
           CASE WHEN has_price_observations = 0 THEN vi.price / NULLIF(vi.pack_size, 0) END
         ),
         vi.lead_time_days
       LIMIT 1`,
    )
    .get(asOf, skuId)
  if (!row) return null
  const hasPriceObservations = toNumber(row.has_price_observations) > 0
  const observedPackSize = row.observed_pack_size === null || row.observed_pack_size === undefined ? null : toNumber(row.observed_pack_size)
  const catalogPackSize = toNumber(row.catalog_pack_size, 1)
  const packSize = Math.max(1, observedPackSize ?? catalogPackSize)
  const observedPrice = row.observed_price === null || row.observed_price === undefined ? null : toNumber(row.observed_price)
  const catalogPrice = row.catalog_price === null || row.catalog_price === undefined ? null : toNumber(row.catalog_price)
  const price = observedPrice ?? (hasPriceObservations ? null : catalogPrice)
  const observedUnitCost = row.observed_unit_cost === null || row.observed_unit_cost === undefined ? null : toNumber(row.observed_unit_cost)
  return {
    vendorName: toStringValue(row.vendor_name),
    unitCost: observedUnitCost ?? (price === null ? null : price / packSize),
    packSize,
    price,
    leadTimeDays: Math.max(1, toNumber(row.lead_time_days, 2)),
  }
}

const latestPurchaseCost = (db: Db, skuId: number, asOf: string): number | null => {
  const row = db
    .prepare(
      `SELECT unit_cost
       FROM inventory_events
       WHERE sku_id = ?
         AND event_type = 'purchase'
         AND unit_cost IS NOT NULL
         AND occurred_at <= ?
       ORDER BY occurred_at DESC, id DESC
       LIMIT 1`,
    )
    .get(skuId, asOf)
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
       WHERE sku_id = ?
         AND event_type = 'adjustment'
         AND occurred_at <= ?
         AND ${countGroundingPredicate('inventory_events')}
       ORDER BY occurred_at DESC, id DESC
       LIMIT 1`,
    )
    .get(skuId, asOf)
  return row?.occurred_at ? daysBetween(asOf, toStringValue(row.occurred_at)) : null
}

const shrinkRates = (
  db: Db,
  skuId: number,
  asOf: string,
  windowDays: number,
): { explicitDaily: number; inferredDaily: number; totalDaily: number } => {
  const start = new Date(new Date(asOf).getTime() - windowDays * 24 * 60 * 60 * 1000).toISOString()
  const explicitShrink = toNumber(
    db
      .prepare(
        `SELECT COALESCE(SUM(ABS(quantity)), 0) AS shrink
         FROM inventory_events
         WHERE sku_id = ?
           AND event_type = 'shrink'
           AND quantity < 0
           AND occurred_at >= ?
           AND occurred_at <= ?`,
      )
      .get(skuId, start, asOf)?.shrink,
  ) / Math.max(1, windowDays)
  const countAdjustments = db
    .prepare(
      `SELECT e.quantity,
              e.occurred_at,
              COALESCE(
                (
                  SELECT MAX(prior.occurred_at)
                  FROM inventory_events prior
                  WHERE prior.sku_id = e.sku_id
                    AND prior.event_type = 'adjustment'
                    AND prior.occurred_at < e.occurred_at
                    AND ${countGroundingPredicate('prior')}
                ),
                (
                  SELECT MIN(first.occurred_at)
                  FROM inventory_events first
                  WHERE first.sku_id = e.sku_id
                    AND first.occurred_at < e.occurred_at
                ),
                ?
              ) AS interval_start
       FROM inventory_events e
       WHERE e.sku_id = ?
         AND e.event_type = 'adjustment'
         AND e.quantity < 0
         AND e.occurred_at >= ?
         AND e.occurred_at <= ?
         AND ${countGroundingPredicate('e')}
       ORDER BY e.occurred_at, e.id`,
    )
    .all(start, skuId, start, asOf)
  const countLoss = countAdjustments.reduce(
    (total, row) => total + Math.abs(toNumber(row.quantity)),
    0,
  )
  const observedDays = countAdjustments.reduce(
    (total, row) =>
      total +
      Math.max(
        1,
        daysBetween(toStringValue(row.occurred_at), toStringValue(row.interval_start, start)),
      ),
    0,
  )
  const inferredShrink = observedDays > 0 ? countLoss / observedDays : 0
  return {
    explicitDaily: explicitShrink,
    inferredDaily: inferredShrink,
    totalDaily: explicitShrink + inferredShrink,
  }
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
  predictedLowerOnHand?: number
  stockoutProbability?: number
  avgDailyUsage: number
  parLevel: number | null
  leadTimeDays: number
}): BackbonePrediction['lowStockRisk'] => {
  const daysRemaining = input.avgDailyUsage > 0 ? input.predictedOnHand / input.avgDailyUsage : null
  if (input.predictedOnHand <= 0) return 'critical'
  if ((input.stockoutProbability ?? 0) >= 0.75) return 'critical'
  if ((input.stockoutProbability ?? 0) >= 0.45) return 'high'
  if (daysRemaining !== null && daysRemaining <= Math.max(1, input.leadTimeDays)) return 'high'
  if (input.predictedLowerOnHand !== undefined && input.predictedLowerOnHand <= 0) return 'low'
  if (input.parLevel !== null && input.predictedOnHand < input.parLevel * 0.5) return 'high'
  if (daysRemaining !== null && daysRemaining < 5) return 'low'
  if (input.parLevel !== null && input.predictedOnHand < input.parLevel) return 'watch'
  return 'ok'
}

const predictionUncertainty = (input: {
  avgDailyUsage: number
  horizonDays: number
  confidence: number
  countAgeDays: number | null
  calibration: Calibration
  trendMultiplier: number
  shrinkDaily: number
  bottleSize: number
}): number => {
  const horizonUsage = input.avgDailyUsage * input.horizonDays
  const demand = horizonUsage * Math.max(0.05, 1 - input.confidence) * 1.2
  const countAge = input.countAgeDays === null
    ? input.bottleSize * 0.5
    : Math.min(input.bottleSize * 0.5, input.bottleSize * (input.countAgeDays / 180))
  const calibration = input.calibration.sampleCount > 0
    ? input.bottleSize * input.calibration.meanBottleError
    : input.bottleSize * 0.1
  const trend = horizonUsage * Math.min(0.4, Math.abs(input.trendMultiplier - 1) * 0.2)
  const shrink = input.shrinkDaily * input.horizonDays * 0.5
  const minimum = input.bottleSize * 0.05
  return round(Math.max(minimum, demand + countAge + calibration + trend + shrink), 3)
}

const stockoutProbabilityFor = (predictedOnHand: number, uncertainty: number): number => {
  if (predictedOnHand <= 0) return 0.98
  if (uncertainty <= 0 || predictedOnHand >= uncertainty) return 0.01
  return round(Math.max(0.01, Math.min(0.98, (uncertainty - predictedOnHand) / (2 * uncertainty))), 3)
}

export const unscoredCountFeedback = (db: Db, options: { asOf?: string; maxTargetAgeDays?: number; limit?: number } = {}): UnscoredCountFeedback[] => {
  const asOf = options.asOf ?? new Date().toISOString()
  const maxTargetAgeDays = Math.max(0, options.maxTargetAgeDays ?? defaultFeedbackTargetAgeDays)
  const rows = db
    .prepare(
      `SELECT e.id AS count_event_id,
              e.sku_id,
              s.name AS sku_name,
              s.unit,
              e.occurred_at,
              COALESCE(SUM(position.quantity), 0) AS actual_on_hand,
              (
                SELECT datetime(r.as_of, '+' || r.horizon_days || ' days')
                FROM backbone_predictions p
                JOIN backbone_runs r ON r.id = p.run_id
                WHERE p.sku_id = e.sku_id
                  AND r.status = 'completed'
                  AND datetime(r.as_of, '+' || r.horizon_days || ' days') <= datetime(e.occurred_at)
                ORDER BY datetime(r.as_of, '+' || r.horizon_days || ' days') DESC, p.id DESC
                LIMIT 1
              ) AS latest_target_at
       FROM inventory_events e
       JOIN skus s ON s.id = e.sku_id
       JOIN inventory_events position
         ON position.sku_id = e.sku_id
        AND position.occurred_at <= e.occurred_at
       WHERE e.event_type = 'adjustment'
         AND e.occurred_at <= ?
         AND ${countGroundingPredicate('e')}
         AND NOT EXISTS (
           SELECT 1
           FROM backbone_feedback f
           WHERE f.count_event_id = e.id
         )
       GROUP BY e.id
       ORDER BY datetime(e.occurred_at) DESC, e.id DESC
       LIMIT ?`,
    )
    .all(asOf, options.limit ?? 100)

  return rows
    .map((row: any): UnscoredCountFeedback | null => {
      const occurredAt = toStringValue(row.occurred_at)
      const latestTargetAt = toStringValue(row.latest_target_at)
      const targetAgeDays = latestTargetAt ? daysBetween(occurredAt, latestTargetAt) : null
      const hasFreshTarget = latestTargetAt && targetAgeDays !== null && targetAgeDays <= maxTargetAgeDays
      if (hasFreshTarget) return null
      return {
        countEventId: toNumber(row.count_event_id),
        skuId: toNumber(row.sku_id),
        skuName: toStringValue(row.sku_name),
        unit: toStringValue(row.unit),
        occurredAt,
        actualOnHand: round(toNumber(row.actual_on_hand), 2),
        latestTargetAt,
        targetAgeDays: targetAgeDays === null ? null : round(targetAgeDays, 1),
        reason: latestTargetAt ? 'stale_prediction_target' : 'no_prediction_target',
      }
    })
    .filter((row): row is UnscoredCountFeedback => row !== null)
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
    maxFeedbackTargetAgeDays: Math.max(0, options.maxFeedbackTargetAgeDays ?? defaultFeedbackTargetAgeDays),
  }

  return withTransaction(db, () => {
    const feedbackItems = scoreBackboneFeedback(db, { asOf: resolved.asOf, maxTargetAgeDays: resolved.maxFeedbackTargetAgeDays })
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
        const vendorCost = cheapestVendorCost(db, position.skuId, resolved.asOf)
        const latestCost = latestPurchaseCost(db, position.skuId, resolved.asOf)
        const highHistoricalCost = highHistoricalPurchaseCost(db, position.skuId, resolved.asOf)
        const countAge = latestCountAgeDays(db, position.skuId, resolved.asOf)
        const shrink = shrinkRates(db, position.skuId, resolved.asOf, resolved.usageWindowDays)
        const shrinkDaily = shrink.totalDaily
        const leadTime = vendorCost?.leadTimeDays ?? 4
        const unobservedShrink = shrink.inferredDaily * (countAge ?? 0)
        const rawPredictedOnHand =
          position.onHand -
          unobservedShrink -
          projectedUsage.totalUsage -
          shrinkDaily * resolved.horizonDays
        const predictedOnHand = round(Math.max(0, rawPredictedOnHand), 2)
        const predictedDaysRemaining = avgDailyUsage > 0 ? round(Math.max(0, predictedOnHand) / avgDailyUsage, 1) : null
        const confidencePenalty = countAge === null ? 0.15 : Math.min(0.25, countAge / 120)
        const confidence = round(
          Math.max(0.25, Math.min(0.98, Math.min(position.confidence, toNumber(forecast?.confidence, position.confidence)) - confidencePenalty + calibration.confidenceAdjustment)),
          2,
        )
        const uncertainty = predictionUncertainty({
          avgDailyUsage,
          horizonDays: resolved.horizonDays,
          confidence,
          countAgeDays: countAge,
          calibration,
          trendMultiplier: projectedUsage.trend.multiplier,
          shrinkDaily,
          bottleSize: bottleSize(db, position.skuId),
        })
        const predictedLowerOnHand = round(Math.max(0, predictedOnHand - uncertainty), 2)
        const predictedUpperOnHand = round(predictedOnHand + uncertainty, 2)
        const stockoutProbability = stockoutProbabilityFor(predictedOnHand, uncertainty)
        const risk = riskFor({
          predictedOnHand,
          predictedLowerOnHand,
          stockoutProbability,
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
          predictedLowerOnHand,
          predictedUpperOnHand,
          predictedDaysRemaining,
          stockoutProbability,
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
           (run_id, sku_id, sku_name, unit, on_hand, predicted_on_hand, predicted_lower_on_hand,
            predicted_upper_on_hand, predicted_days_remaining, stockout_probability, avg_daily_usage,
            confidence, low_stock_risk, recommended_order_qty, estimated_cost, cost_signal, evidence_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          runId,
          prediction.skuId,
          prediction.skuName,
          prediction.unit,
          prediction.onHand,
          prediction.predictedOnHand,
          prediction.predictedLowerOnHand,
          prediction.predictedUpperOnHand,
          prediction.predictedDaysRemaining,
          prediction.stockoutProbability,
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
            unobservedShrink: round(unobservedShrink, 3),
            vendorCost,
            latestCost,
            highHistoricalCost,
            calibration,
            baselineDailyUsage: round(baselineDailyUsage, 3),
            projectionMethod: projectedUsage.method,
            trend: projectedUsage.trend,
            projectedUsage: projectedUsage.totalUsage,
            rawPredictedOnHand: round(rawPredictedOnHand, 2),
            uncertainty,
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
      predictedLowerOnHand: row.predicted_lower_on_hand === null || row.predicted_lower_on_hand === undefined
        ? toNumber(row.predicted_on_hand)
        : toNumber(row.predicted_lower_on_hand),
      predictedUpperOnHand: row.predicted_upper_on_hand === null || row.predicted_upper_on_hand === undefined
        ? toNumber(row.predicted_on_hand)
        : toNumber(row.predicted_upper_on_hand),
      predictedDaysRemaining: row.predicted_days_remaining === null ? null : toNumber(row.predicted_days_remaining),
      stockoutProbability: row.stockout_probability === null || row.stockout_probability === undefined ? 0 : toNumber(row.stockout_probability),
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
