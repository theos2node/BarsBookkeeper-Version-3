import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type Db } from '../src/db/database.js'
import { migrateDatabase } from '../src/db/migrations.js'
import { ensureMenuItem, ensureSku, ensureVendor, ensureVendorItem, upsertRecipeItem } from '../src/db/repositories.js'
import { ingestCounts, ingestInvoices, ingestToastSales } from '../src/ingest/index.js'
import { getLatestBackboneRun, runBackboneModel, scoreBackboneFeedback, unscoredCountFeedback } from '../src/backbone/index.js'
import { backboneSimulationScenarios, runBackboneAccuracySimulation, runBackboneRollingBacktest } from '../src/backbone/simulation.js'

describe('Backbone prediction model', () => {
  let db: Db

  beforeEach(() => {
    db = openDatabase(':memory:')
    migrateDatabase(db)
  })

  afterEach(() => {
    db.close()
  })

  it('learns from Toast history plus sparse counts and predicts validation inventory accurately', () => {
    const result = runBackboneAccuracySimulation(db)

    expect(result.passed).toBe(true)
    expect(result.bottleMae).toBeLessThanOrEqual(0.1)
    expect(result.maxBottleError).toBeLessThanOrEqual(0.25)
    expect(result.lowStockRecall).toBe(1)
    expect(result.lowStockPrecision).toBeGreaterThanOrEqual(0.75)
    expect(result.uncertaintyCoverage).toBe(1)
    expect(result.meanBandBottles).toBeLessThanOrEqual(1.5)
    expect(result.costCuttingOptions).toBeGreaterThan(0)
    expect(result.feedbackItems).toBeGreaterThanOrEqual(3)
    expect(result.calibratedSkus).toBeGreaterThanOrEqual(3)
    expect(result.predictions.some((prediction) => prediction.sku === 'Backbone Vodka 1L' && prediction.costSignal.includes('saves'))).toBe(true)
    expect(getLatestBackboneRun(db)?.predictionCount).toBeGreaterThanOrEqual(3)
    const feedbackCoverage = db
      .prepare(
        `SELECT COUNT(*) AS samples,
                SUM(CASE WHEN in_band = 1 THEN 1 ELSE 0 END) AS in_band,
                SUM(CASE WHEN predicted_lower_on_hand IS NOT NULL AND predicted_upper_on_hand IS NOT NULL THEN 1 ELSE 0 END) AS with_band,
                SUM(CASE WHEN stockout_probability IS NOT NULL THEN 1 ELSE 0 END) AS with_stockout
         FROM backbone_feedback`,
      )
      .get() as any
    expect(feedbackCoverage.samples).toBeGreaterThanOrEqual(3)
    expect(feedbackCoverage.in_band).toBe(feedbackCoverage.samples)
    expect(feedbackCoverage.with_band).toBe(feedbackCoverage.samples)
    expect(feedbackCoverage.with_stockout).toBe(feedbackCoverage.samples)
    expect(db.prepare("SELECT COUNT(*) AS count FROM source_documents WHERE document_type = 'count' AND external_id LIKE 'NOTE-%'").get()?.count).toBeGreaterThanOrEqual(6)
    expect(db.prepare("SELECT COUNT(*) AS count FROM sources WHERE name LIKE 'Backbone sparse % notes'").get()?.count).toBeGreaterThanOrEqual(2)
  })

  it('persists uncertainty bands and stockout probability with each prediction', () => {
    const result = runBackboneAccuracySimulation(db, { scenario: 'surge' })
    const rows = db
      .prepare(
        `SELECT predicted_on_hand,
                predicted_lower_on_hand,
                predicted_upper_on_hand,
                stockout_probability,
                evidence_json
         FROM backbone_predictions
         WHERE run_id = ?`,
      )
      .all(result.run.runId)

    expect(rows.length).toBeGreaterThanOrEqual(3)
    for (const row of rows as any[]) {
      expect(row.predicted_lower_on_hand).toBeLessThanOrEqual(row.predicted_on_hand)
      expect(row.predicted_upper_on_hand).toBeGreaterThanOrEqual(row.predicted_on_hand)
      expect(row.stockout_probability).toBeGreaterThanOrEqual(0)
      expect(row.stockout_probability).toBeLessThanOrEqual(0.98)
      expect(JSON.parse(String(row.evidence_json)).uncertainty).toBeGreaterThan(0)
    }

    const latest = getLatestBackboneRun(db)
    expect(latest?.predictions.every((prediction) =>
      prediction.predictedLowerOnHand <= prediction.predictedOnHand &&
      prediction.predictedUpperOnHand >= prediction.predictedOnHand &&
      prediction.stockoutProbability >= 0,
    )).toBe(true)
  })

  it('passes the isolated scenario matrix across different operating patterns', () => {
    for (const scenario of backboneSimulationScenarios) {
      const scenarioDb = openDatabase(':memory:')
      try {
        migrateDatabase(scenarioDb)
        const result = runBackboneAccuracySimulation(scenarioDb, { scenario })
        expect(result.passed, scenario).toBe(true)
        expect(result.bottleMae, scenario).toBeLessThanOrEqual(0.1)
        expect(result.lowStockRecall, scenario).toBe(1)
        expect(result.uncertaintyCoverage, scenario).toBe(1)
        expect(result.meanBandBottles, scenario).toBeLessThanOrEqual(1.5)
        expect(result.costCuttingOptions, scenario).toBeGreaterThan(0)
        expect(result.feedbackItems, scenario).toBeGreaterThanOrEqual(3)
      } finally {
        scenarioDb.close()
      }
    }
  })

  it('uses weekday demand shape to stay accurate during volatile Toast patterns', () => {
    const result = runBackboneAccuracySimulation(db, { scenario: 'volatile' })
    const projectionMethods = db
      .prepare(
        `SELECT evidence_json
         FROM backbone_predictions
         WHERE run_id = ?`,
      )
      .all(result.run.runId)
      .map((row: any) => JSON.parse(String(row.evidence_json)).projectionMethod)

    expect(result.passed).toBe(true)
    expect(result.bottleMae).toBeLessThanOrEqual(0.1)
    expect(result.maxBottleError).toBeLessThanOrEqual(0.25)
    expect(result.lowStockRecall).toBe(1)
    expect(projectionMethods).toContain('weekday')
  })

  it('adapts to recent Toast demand surges without waiting for another hand count', () => {
    const result = runBackboneAccuracySimulation(db, { scenario: 'surge' })
    const projectionEvidence = db
      .prepare(
        `SELECT evidence_json
         FROM backbone_predictions
         WHERE run_id = ?`,
      )
      .all(result.run.runId)
      .map((row: any) => JSON.parse(String(row.evidence_json)))

    expect(result.passed).toBe(true)
    expect(result.bottleMae).toBeLessThanOrEqual(0.1)
    expect(result.maxBottleError).toBeLessThanOrEqual(0.25)
    expect(result.lowStockRecall).toBe(1)
    expect(projectionEvidence.some((evidence) => evidence.projectionMethod === 'trend-weekday')).toBe(true)
    expect(projectionEvidence.some((evidence) => evidence.trend?.multiplier > 1.2)).toBe(true)
  })

  it('flags hidden shrink from sparse counts as an audit cost signal', () => {
    const result = runBackboneAccuracySimulation(db, { scenario: 'shrink' })

    expect(result.passed).toBe(true)
    expect(result.feedbackItems).toBeGreaterThanOrEqual(3)
    expect(result.calibratedSkus).toBeGreaterThanOrEqual(3)
    expect(result.predictions.some((prediction) => prediction.costSignal.includes('audit shrink'))).toBe(true)
  })

  it('passes a rolling backtest between sparse monthly count snapshots', () => {
    const result = runBackboneRollingBacktest(db, { days: 60, countCadenceDays: 30, scenario: 'shrink' })

    expect(result.passed).toBe(true)
    expect(result.runCount).toBeGreaterThanOrEqual(30)
    expect(result.countSnapshots).toBe(2)
    expect(result.feedbackItems).toBeGreaterThanOrEqual(3)
    expect(result.calibratedSkus).toBeGreaterThanOrEqual(3)
    expect(result.bottleMae).toBeLessThanOrEqual(0.2)
    expect(result.maxBottleError).toBeLessThanOrEqual(0.5)
    expect(result.lowStockRecall).toBeGreaterThanOrEqual(0.9)
    expect(result.lowStockPrecision).toBeGreaterThanOrEqual(0.7)
    expect(result.uncertaintyCoverage).toBeGreaterThanOrEqual(0.95)
    expect(result.meanBandBottles).toBeLessThanOrEqual(1.75)
    expect(result.shrinkSignals).toBeGreaterThan(0)
    expect(db.prepare("SELECT COUNT(*) AS count FROM source_documents WHERE document_type = 'count' AND external_id LIKE 'NOTE-%'").get()?.count).toBe(6)
  })

  it('finds cost-cutting options learned from sparse vendor invoice drift', () => {
    const result = runBackboneAccuracySimulation(db, { scenario: 'price-drift' })

    expect(result.passed).toBe(true)
    expect(result.costCuttingOptions).toBeGreaterThan(0)
    expect(result.predictions.some((prediction) => prediction.sku === 'Backbone Vodka 1L' && prediction.costSignal.includes('Value Spirits Co'))).toBe(true)
    expect(result.predictions.some((prediction) => prediction.sku === 'Backbone Vodka 1L' && prediction.costSignal.includes('saves 0.022'))).toBe(true)
  })

  it('scores sparse count feedback and carries calibration into future runs', () => {
    const result = runBackboneAccuracySimulation(db)
    expect(result.passed).toBe(true)

    const calibrated = runBackboneModel(db, {
      asOf: result.actualAsOf,
      horizonDays: 1,
      usageWindowDays: 28,
      mode: 'evaluation',
    })

    expect(calibrated.calibratedSkus).toBeGreaterThanOrEqual(3)
    expect(calibrated.predictions.filter((prediction) => prediction.skuName.startsWith('Backbone ') && prediction.calibrationSamples > 0)).toHaveLength(3)
  })

  it('weights recent sparse count feedback above stale calibration errors', () => {
    const vendorId = ensureVendor(db, 'Adaptive Distributor')
    const skuId = ensureSku(db, { name: 'Adaptive Vodka 1L', unit: 'ml', category: 'liquor' })
    ensureVendorItem(db, {
      vendorId,
      skuId,
      packSize: 1000,
      packUnit: 'bottle',
      price: 20,
      leadTimeDays: 2,
      minOrderQty: 1000,
    })
    ingestInvoices(db, [
      {
        vendor: 'Adaptive Distributor',
        invoiceNumber: 'ADAPTIVE-OPEN',
        invoiceDate: '2026-01-01T09:00:00.000Z',
        sku: 'Adaptive Vodka 1L',
        quantity: 1000,
        unit: 'ml',
        unitCost: 0.02,
        category: 'liquor',
      },
    ])

    runBackboneModel(db, {
      asOf: '2026-01-01T12:00:00.000Z',
      horizonDays: 1,
      usageWindowDays: 7,
      mode: 'evaluation',
    })
    ingestCounts(db, [
      {
        countId: 'ADAPTIVE-OLD-HIGH',
        occurredAt: '2026-01-02T12:00:00.000Z',
        sku: 'Adaptive Vodka 1L',
        countedQuantity: 1700,
        unit: 'ml',
      },
    ])
    expect(scoreBackboneFeedback(db, { asOf: '2026-01-02T13:00:00.000Z' })).toBe(1)

    runBackboneModel(db, {
      asOf: '2026-04-01T12:00:00.000Z',
      horizonDays: 1,
      usageWindowDays: 7,
      mode: 'evaluation',
    })
    ingestCounts(db, [
      {
        countId: 'ADAPTIVE-RECENT-LOW',
        occurredAt: '2026-04-02T12:00:00.000Z',
        sku: 'Adaptive Vodka 1L',
        countedQuantity: 1000,
        unit: 'ml',
      },
    ])
    expect(scoreBackboneFeedback(db, { asOf: '2026-04-02T13:00:00.000Z' })).toBe(1)

    const calibration = db.prepare('SELECT * FROM backbone_calibrations WHERE sku_id = ?').get(skuId)
    expect(calibration?.sample_count).toBe(2)
    expect(calibration?.mean_error_quantity).toBeLessThan(-300)
    expect(calibration?.usage_adjustment_daily).toBeGreaterThan(40)
  })

  it('does not calibrate sparse counts against stale prediction targets', () => {
    const vendorId = ensureVendor(db, 'Stale Feedback Distributor')
    const skuId = ensureSku(db, { name: 'Stale Feedback Vodka 1L', unit: 'ml', category: 'liquor' })
    ensureVendorItem(db, {
      vendorId,
      skuId,
      packSize: 1000,
      packUnit: 'bottle',
      price: 20,
      leadTimeDays: 2,
      minOrderQty: 1000,
    })
    ingestInvoices(db, [
      {
        vendor: 'Stale Feedback Distributor',
        invoiceNumber: 'STALE-FEEDBACK-OPEN',
        invoiceDate: '2026-01-01T09:00:00.000Z',
        sku: 'Stale Feedback Vodka 1L',
        quantity: 1000,
        unit: 'ml',
        unitCost: 0.02,
        category: 'liquor',
      },
    ])
    runBackboneModel(db, {
      asOf: '2026-01-01T12:00:00.000Z',
      horizonDays: 1,
      usageWindowDays: 7,
      mode: 'evaluation',
    })
    ingestCounts(db, [
      {
        countId: 'STALE-FEEDBACK-LATE-COUNT',
        occurredAt: '2026-01-20T12:00:00.000Z',
        sku: 'Stale Feedback Vodka 1L',
        countedQuantity: 800,
        unit: 'ml',
      },
    ])

    expect(scoreBackboneFeedback(db, { asOf: '2026-01-20T13:00:00.000Z' })).toBe(0)
    const unscored = unscoredCountFeedback(db, { asOf: '2026-01-20T13:00:00.000Z' })
    expect(unscored).toEqual([
      expect.objectContaining({
        skuName: 'Stale Feedback Vodka 1L',
        reason: 'stale_prediction_target',
        targetAgeDays: expect.any(Number),
      }),
    ])
    expect(unscored[0]?.targetAgeDays ?? 0).toBeGreaterThan(14)
    expect(db.prepare('SELECT COUNT(*) AS count FROM backbone_feedback WHERE sku_id = ?').get(skuId)?.count).toBe(0)
    expect(db.prepare('SELECT COUNT(*) AS count FROM backbone_calibrations WHERE sku_id = ?').get(skuId)?.count).toBe(0)

    runBackboneModel(db, {
      asOf: '2026-01-19T12:00:00.000Z',
      horizonDays: 1,
      usageWindowDays: 7,
      mode: 'evaluation',
    })

    expect(scoreBackboneFeedback(db, { asOf: '2026-01-20T13:00:00.000Z' })).toBe(1)
    expect(db.prepare('SELECT COUNT(*) AS count FROM backbone_feedback WHERE sku_id = ?').get(skuId)?.count).toBe(1)
    expect(unscoredCountFeedback(db, { asOf: '2026-01-20T13:00:00.000Z' })).toHaveLength(0)
  })

  it('uses vendor lead time when escalating low-stock risk', () => {
    const vendorId = ensureVendor(db, 'Slow Distributor')
    const skuId = ensureSku(db, { name: 'Slow Gin 1L', unit: 'ml', category: 'liquor' })
    ensureVendorItem(db, {
      vendorId,
      skuId,
      packSize: 1000,
      packUnit: 'bottle',
      price: 30,
      leadTimeDays: 5,
      minOrderQty: 1000,
    })
    const menuItemId = ensureMenuItem(db, 'Slow Gin Martini', 'slow-gin-martini', 'cocktails')
    upsertRecipeItem(db, { menuItemId, skuId, quantity: 100, unit: 'ml' })
    ingestInvoices(db, [
      {
        vendor: 'Slow Distributor',
        invoiceNumber: 'SLOW-GIN-OPEN',
        invoiceDate: '2026-05-01T09:00:00.000Z',
        sku: 'Slow Gin 1L',
        quantity: 1000,
        unit: 'ml',
        unitCost: 0.03,
        category: 'liquor',
      },
    ])
    for (let day = 1; day <= 5; day += 1) {
      ingestToastSales(db, [
        {
          externalId: `SLOW-GIN-${day}`,
          occurredAt: `2026-05-0${day}T21:00:00.000Z`,
          menuItem: 'Slow Gin Martini',
          quantitySold: 1,
        },
      ])
    }

    const run = runBackboneModel(db, {
      asOf: '2026-05-05T23:00:00.000Z',
      horizonDays: 1,
      usageWindowDays: 5,
      mode: 'evaluation',
    })
    const prediction = run.predictions.find((row) => row.skuName === 'Slow Gin 1L')
    const evidence = JSON.parse(
      String(db.prepare('SELECT evidence_json FROM backbone_predictions WHERE run_id = ? AND sku_id = ?').get(run.runId, skuId)?.evidence_json),
    )

    expect(prediction?.predictedDaysRemaining).toBeGreaterThan(2)
    expect(prediction?.predictedDaysRemaining).toBeLessThanOrEqual(5)
    expect(prediction?.lowStockRisk).toBe('high')
    expect(evidence.vendorCost.leadTimeDays).toBe(5)
  })

  it('does not leak future invoices or counts into time-warped predictions', () => {
    const vendorId = ensureVendor(db, 'Timeline Vendor')
    const skuId = ensureSku(db, { name: 'Timeline Vodka 1L', unit: 'ml', category: 'liquor' })
    ensureVendorItem(db, {
      vendorId,
      skuId,
      packSize: 1000,
      packUnit: 'bottle',
      price: 20,
      leadTimeDays: 2,
      minOrderQty: 1000,
    })
    ingestInvoices(db, [
      {
        vendor: 'Timeline Vendor',
        invoiceNumber: 'TIMELINE-OLD',
        invoiceDate: '2026-05-01T09:00:00.000Z',
        sku: 'Timeline Vodka 1L',
        quantity: 2000,
        unit: 'ml',
        unitCost: 0.02,
        category: 'liquor',
      },
      {
        vendor: 'Timeline Vendor',
        invoiceNumber: 'TIMELINE-FUTURE',
        invoiceDate: '2026-05-20T09:00:00.000Z',
        sku: 'Timeline Vodka 1L',
        quantity: 2000,
        unit: 'ml',
        unitCost: 0.009,
        category: 'liquor',
      },
    ])
    ingestCounts(db, [
      {
        countId: 'TIMELINE-FUTURE-COUNT',
        occurredAt: '2026-05-18T23:00:00.000Z',
        sku: 'Timeline Vodka 1L',
        countedQuantity: 10000,
        unit: 'ml',
      },
    ])

    const run = runBackboneModel(db, {
      asOf: '2026-05-10T12:00:00.000Z',
      horizonDays: 1,
      usageWindowDays: 7,
      mode: 'evaluation',
    })
    const evidence = JSON.parse(
      String(db.prepare('SELECT evidence_json FROM backbone_predictions WHERE run_id = ? AND sku_id = ?').get(run.runId, skuId)?.evidence_json),
    )

    expect(evidence.latestCost).toBe(0.02)
    expect(evidence.highHistoricalCost).toBe(0.02)
    expect(evidence.vendorCost.unitCost).toBe(0.02)
    expect(evidence.vendorCost.price).toBe(40)
    expect(evidence.countAgeDays).toBeNull()
    expect(db.prepare('SELECT COUNT(*) AS count FROM vendor_item_prices WHERE sku_id = ?').get(skuId)?.count).toBe(2)
  })

  it('backfills legacy invoice prices into time-aware vendor evidence', () => {
    const vendorId = ensureVendor(db, 'Legacy Timeline Vendor')
    const skuId = ensureSku(db, { name: 'Legacy Timeline Vodka 1L', unit: 'ml', category: 'liquor' })
    ensureVendorItem(db, {
      vendorId,
      skuId,
      packSize: 1000,
      packUnit: 'bottle',
      price: 20,
      leadTimeDays: 2,
      minOrderQty: 1000,
    })
    ingestInvoices(db, [
      {
        vendor: 'Legacy Timeline Vendor',
        invoiceNumber: 'LEGACY-TIMELINE-OLD',
        invoiceDate: '2026-05-01T09:00:00.000Z',
        sku: 'Legacy Timeline Vodka 1L',
        quantity: 2000,
        unit: 'ml',
        unitCost: 0.02,
        category: 'liquor',
      },
      {
        vendor: 'Legacy Timeline Vendor',
        invoiceNumber: 'LEGACY-TIMELINE-FUTURE',
        invoiceDate: '2026-05-20T09:00:00.000Z',
        sku: 'Legacy Timeline Vodka 1L',
        quantity: 2000,
        unit: 'ml',
        unitCost: 0.009,
        category: 'liquor',
      },
    ])

    db.prepare('DELETE FROM vendor_item_prices WHERE sku_id = ?').run(skuId)
    db.prepare('DELETE FROM schema_migrations WHERE id = 12').run()
    migrateDatabase(db)

    const run = runBackboneModel(db, {
      asOf: '2026-05-10T12:00:00.000Z',
      horizonDays: 1,
      usageWindowDays: 7,
      mode: 'evaluation',
    })
    const evidence = JSON.parse(
      String(db.prepare('SELECT evidence_json FROM backbone_predictions WHERE run_id = ? AND sku_id = ?').get(run.runId, skuId)?.evidence_json),
    )

    expect(db.prepare('SELECT COUNT(*) AS count FROM vendor_item_prices WHERE sku_id = ?').get(skuId)?.count).toBe(2)
    expect(evidence.vendorCost.unitCost).toBe(0.02)
    expect(evidence.vendorCost.price).toBe(40)
  })
})
