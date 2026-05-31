import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type Db } from '../src/db/database.js'
import { migrateDatabase } from '../src/db/migrations.js'
import { getLatestBackboneRun, runBackboneModel } from '../src/backbone/index.js'
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
})
