import { getInventoryPositions } from '../db/inventory.js'
import { toNumber, type Db } from '../db/database.js'
import { ingestCounts, ingestInvoices, ingestToastSales, type CountRow, type InvoiceRow, type ToastSalesRow } from '../ingest/index.js'
import { ensureMenuItem, ensureSku, ensureVendor, ensureVendorItem, upsertRecipeItem } from '../db/repositories.js'
import { runBackboneModel, type BackbonePrediction, type BackboneRunResult } from './index.js'

export type BackboneSimulationOptions = {
  startAt?: string
  trainingDays?: number
  scenario?: BackboneSimulationScenario
}

export type BackboneSimulationScenario = 'steady' | 'busy' | 'slow'

export const backboneSimulationScenarios: BackboneSimulationScenario[] = ['steady', 'busy', 'slow']

export type BackboneSimulationResult = {
  scenario: BackboneSimulationScenario
  run: BackboneRunResult
  actualAsOf: string
  trainingDays: number
  bottleMae: number
  maxBottleError: number
  lowStockRecall: number
  lowStockPrecision: number
  costCuttingOptions: number
  passed: boolean
  predictions: Array<{
    sku: string
    predictedOnHand: number
    actualOnHand: number
    bottleError: number
    risk: string
    costSignal: string
  }>
}

type ScenarioProfile = {
  name: BackboneSimulationScenario
  vodkaSales: number
  margaritaSales: number
  initial: {
    vodka: number
    tequila: number
    tripleSec: number
  }
}

const dayMs = 24 * 60 * 60 * 1000
const recipe = {
  vodkaSodaVodka: 50,
  margaritaTequila: 60,
  margaritaTripleSec: 20,
}

const profiles: Record<BackboneSimulationScenario, ScenarioProfile> = {
  steady: {
    name: 'steady',
    vodkaSales: 8,
    margaritaSales: 10,
    initial: { vodka: 16000, tequila: 20000, tripleSec: 8000 },
  },
  busy: {
    name: 'busy',
    vodkaSales: 12,
    margaritaSales: 14,
    initial: { vodka: 24000, tequila: 28000, tripleSec: 11000 },
  },
  slow: {
    name: 'slow',
    vodkaSales: 4,
    margaritaSales: 5,
    initial: { vodka: 10000, tequila: 10000, tripleSec: 5000 },
  },
}

const isoDay = (start: Date, day: number, hour: number): string => {
  const date = new Date(start.getTime() + day * dayMs)
  date.setUTCHours(hour, 0, 0, 0)
  return date.toISOString()
}

const round = (value: number, decimals = 3): number => Number(value.toFixed(decimals))

const highRisk = (prediction: BackbonePrediction): boolean =>
  prediction.lowStockRisk !== 'ok'

export const runBackboneAccuracySimulation = (
  db: Db,
  options: BackboneSimulationOptions = {},
): BackboneSimulationResult => {
  const start = new Date(options.startAt ?? '2026-05-01T08:00:00.000Z')
  const trainingDays = options.trainingDays ?? 29
  const profile = profiles[options.scenario ?? 'steady']
  seedBackboneReference(db)
  ingestInvoices(db, simulationInvoices(start, profile), 'Backbone simulation invoices')

  for (let day = 1; day <= trainingDays; day += 1) {
    ingestToastSales(db, simulationSales(start, day, profile), 'Backbone simulated Toast history')
    if (day === 15) ingestCounts(db, countSnapshot(start, day, profile, 'mid'), 'Backbone sparse hand counts')
  }

  const asOf = isoDay(start, trainingDays, 23)
  const run = runBackboneModel(db, {
    asOf,
    horizonDays: 1,
    usageWindowDays: Math.min(28, trainingDays),
    mode: 'evaluation',
  })

  const actualDay = trainingDays + 1
  ingestToastSales(db, simulationSales(start, actualDay, profile), 'Backbone simulated Toast validation')
  ingestCounts(db, countSnapshot(start, actualDay, profile, 'end'), 'Backbone sparse validation counts')

  const actualAsOf = isoDay(start, actualDay, 23)
  const actualBySku = new Map(getInventoryPositions(db, { asOf: actualAsOf, usageWindowDays: 28 }).map((position) => [position.skuId, position]))
  const evaluated = run.predictions
    .filter((prediction) => prediction.skuName.startsWith('Backbone '))
    .map((prediction) => {
      const actual = actualBySku.get(prediction.skuId)
      const actualOnHand = actual?.onHand ?? 0
      const bottleError = Math.abs(prediction.predictedOnHand - actualOnHand) / bottleSize(db, prediction.skuId)
      return {
        sku: prediction.skuName,
        predictedOnHand: round(prediction.predictedOnHand, 2),
        actualOnHand: round(actualOnHand, 2),
        bottleError: round(bottleError, 3),
        risk: prediction.lowStockRisk,
        costSignal: prediction.costSignal,
        predictedLow: highRisk(prediction),
        actualLow: actual ? actual.onHand < (actual.parLevel ?? 0) : false,
      }
    })

  const bottleMae = round(evaluated.reduce((total, row) => total + row.bottleError, 0) / Math.max(1, evaluated.length), 3)
  const maxBottleError = round(Math.max(0, ...evaluated.map((row) => row.bottleError)), 3)
  const truePositives = evaluated.filter((row) => row.predictedLow && row.actualLow).length
  const predictedLow = evaluated.filter((row) => row.predictedLow).length
  const actualLow = evaluated.filter((row) => row.actualLow).length
  const lowStockRecall = round(actualLow === 0 ? 1 : truePositives / actualLow, 3)
  const lowStockPrecision = round(predictedLow === 0 ? 1 : truePositives / predictedLow, 3)
  const costCuttingOptions = evaluated.filter((row) => row.costSignal !== 'none').length
  const passed = bottleMae <= 0.1 && maxBottleError <= 0.25 && lowStockRecall >= 1 && lowStockPrecision >= 0.75 && costCuttingOptions > 0

  return {
    scenario: profile.name,
    run,
    actualAsOf,
    trainingDays,
    bottleMae,
    maxBottleError,
    lowStockRecall,
    lowStockPrecision,
    costCuttingOptions,
    passed,
    predictions: evaluated.map(({ predictedLow: _predictedLow, actualLow: _actualLow, ...row }) => row),
  }
}

const seedBackboneReference = (db: Db): void => {
  const premium = ensureVendor(db, 'Premium Bottle House')
  const value = ensureVendor(db, 'Value Spirits Co')

  const vodka = ensureSku(db, { name: 'Backbone Vodka 1L', unit: 'ml', category: 'liquor', parLevel: 5000 })
  const tequila = ensureSku(db, { name: 'Backbone Tequila 1L', unit: 'ml', category: 'liquor', parLevel: 5000 })
  const tripleSec = ensureSku(db, { name: 'Backbone Triple Sec 1L', unit: 'ml', category: 'liquor', parLevel: 2500 })

  ensureVendorItem(db, { vendorId: premium, skuId: vodka, packSize: 1000, packUnit: 'bottle', price: 50, leadTimeDays: 3, minOrderQty: 1000 })
  ensureVendorItem(db, { vendorId: value, skuId: vodka, packSize: 1000, packUnit: 'bottle', price: 28, leadTimeDays: 3, minOrderQty: 1000 })
  ensureVendorItem(db, { vendorId: value, skuId: tequila, packSize: 1000, packUnit: 'bottle', price: 32, leadTimeDays: 3, minOrderQty: 1000 })
  ensureVendorItem(db, { vendorId: value, skuId: tripleSec, packSize: 1000, packUnit: 'bottle', price: 16, leadTimeDays: 3, minOrderQty: 1000 })

  const vodkaSoda = ensureMenuItem(db, 'Backbone Vodka Soda', 'backbone-vodka-soda', 'cocktails')
  const margarita = ensureMenuItem(db, 'Backbone Margarita', 'backbone-margarita', 'cocktails')
  upsertRecipeItem(db, { menuItemId: vodkaSoda, skuId: vodka, quantity: 50, unit: 'ml' })
  upsertRecipeItem(db, { menuItemId: margarita, skuId: tequila, quantity: 60, unit: 'ml' })
  upsertRecipeItem(db, { menuItemId: margarita, skuId: tripleSec, quantity: 20, unit: 'ml' })
}

const simulationInvoices = (start: Date, profile: ScenarioProfile): InvoiceRow[] => [
  { vendor: 'Premium Bottle House', invoiceNumber: `BB-SIM-${profile.name}-VODKA`, invoiceDate: isoDay(start, 0, 9), sku: 'Backbone Vodka 1L', quantity: profile.initial.vodka, unit: 'ml', unitCost: 0.05, category: 'liquor' },
  { vendor: 'Value Spirits Co', invoiceNumber: `BB-SIM-${profile.name}-TEQUILA`, invoiceDate: isoDay(start, 0, 9), sku: 'Backbone Tequila 1L', quantity: profile.initial.tequila, unit: 'ml', unitCost: 0.032, category: 'liquor' },
  { vendor: 'Value Spirits Co', invoiceNumber: `BB-SIM-${profile.name}-TRIPLE`, invoiceDate: isoDay(start, 0, 9), sku: 'Backbone Triple Sec 1L', quantity: profile.initial.tripleSec, unit: 'ml', unitCost: 0.016, category: 'liquor' },
]

const simulationSales = (start: Date, day: number, profile: ScenarioProfile): ToastSalesRow[] => [
  { externalId: `BB-SIM-${profile.name}-VODKA-${day}`, occurredAt: isoDay(start, day, 21), menuItem: 'Backbone Vodka Soda', quantitySold: profile.vodkaSales },
  { externalId: `BB-SIM-${profile.name}-MARG-${day}`, occurredAt: isoDay(start, day, 21), menuItem: 'Backbone Margarita', quantitySold: profile.margaritaSales },
]

const countSnapshot = (start: Date, day: number, profile: ScenarioProfile, label: 'mid' | 'end'): CountRow[] => [
  { countId: `BB-SIM-${profile.name}-${label}-VODKA`, occurredAt: isoDay(start, day, 23), sku: 'Backbone Vodka 1L', countedQuantity: profile.initial.vodka - profile.vodkaSales * recipe.vodkaSodaVodka * day, unit: 'ml' },
  { countId: `BB-SIM-${profile.name}-${label}-TEQUILA`, occurredAt: isoDay(start, day, 23), sku: 'Backbone Tequila 1L', countedQuantity: profile.initial.tequila - profile.margaritaSales * recipe.margaritaTequila * day, unit: 'ml' },
  { countId: `BB-SIM-${profile.name}-${label}-TRIPLE`, occurredAt: isoDay(start, day, 23), sku: 'Backbone Triple Sec 1L', countedQuantity: profile.initial.tripleSec - profile.margaritaSales * recipe.margaritaTripleSec * day, unit: 'ml' },
]

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
