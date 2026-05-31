import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type Db } from '../src/db/database.js'
import { migrateDatabase } from '../src/db/migrations.js'
import { getLatestBackboneRun, runBackboneModel } from '../src/backbone/index.js'
import { backboneSimulationScenarios, runBackboneAccuracySimulation } from '../src/backbone/simulation.js'

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
    expect(result.costCuttingOptions).toBeGreaterThan(0)
    expect(result.feedbackItems).toBeGreaterThanOrEqual(3)
    expect(result.calibratedSkus).toBeGreaterThanOrEqual(3)
    expect(result.predictions.some((prediction) => prediction.sku === 'Backbone Vodka 1L' && prediction.costSignal.includes('saves'))).toBe(true)
    expect(getLatestBackboneRun(db)?.predictionCount).toBeGreaterThanOrEqual(3)
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
        expect(result.costCuttingOptions, scenario).toBeGreaterThan(0)
        expect(result.feedbackItems, scenario).toBeGreaterThanOrEqual(3)
      } finally {
        scenarioDb.close()
      }
    }
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
