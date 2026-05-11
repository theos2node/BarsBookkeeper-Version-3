import { runOpenClawBrain } from '../brain/openclaw.js'
import { generateForecasts } from '../forecast/index.js'
import { ingestCounts, ingestInvoices, ingestToastSales, type CountRow, type InvoiceRow, type ToastSalesRow } from '../ingest/index.js'
import { generateVendorGroupedOrderRecommendations } from '../orders/index.js'
import { ensureMenuItem, ensureSku, ensureVendor, ensureVendorItem, upsertRecipeItem } from './repositories.js'
import { seedDemoData } from './seed.js'
import type { Db } from './database.js'

const dayMs = 24 * 60 * 60 * 1000

const isoDaysAgo = (asOf: Date, days: number, hour = 12): string => {
  const date = new Date(asOf.getTime() - days * dayMs)
  date.setHours(hour, 0, 0, 0)
  return date.toISOString()
}

export const seedFieldDemoRun = async (db: Db, asOf = new Date().toISOString()) => {
  const now = new Date(asOf)
  seedDemoData(db, isoDaysAgo(now, 7, 9))
  seedFieldReferenceData(db)

  const invoiceResult = ingestInvoices(db, generatedInvoices(now), 'Generated field invoices')
  const toastResult = ingestToastSales(db, generatedToastSales(now), 'Generated Toast field sales')
  const countResult = ingestCounts(db, generatedCounts(now), 'Generated manager count')
  const brain = await runOpenClawBrain(db)
  const forecasts = generateForecasts(db, { asOf: now.toISOString(), horizonDays: 7, usageWindowDays: 7 })
  const orders = generateVendorGroupedOrderRecommendations(db, { asOf: now.toISOString(), horizonDays: 7, usageWindowDays: 7 })

  return {
    invoices: invoiceResult,
    toast: toastResult,
    counts: countResult,
    brain,
    forecasts: forecasts.length,
    orderGroups: orders.length,
    orderItems: orders.reduce((total, group) => total + group.items.length, 0),
  }
}

const seedFieldReferenceData = (db: Db): void => {
  const southern = ensureVendor(db, 'Southern Glazer')
  const local = ensureVendor(db, 'Local Produce Co')
  const craft = ensureVendor(db, 'Craft Beverage Supply')

  const tequila = ensureSku(db, { name: 'Blanco Tequila 1L', unit: 'ml', category: 'liquor', parLevel: 5000 })
  const tripleSec = ensureSku(db, { name: 'Triple Sec 1L', unit: 'ml', category: 'liquor', parLevel: 2500 })
  const bourbon = ensureSku(db, { name: 'House Bourbon 1L', unit: 'ml', category: 'liquor', parLevel: 4000 })
  const syrup = ensureSku(db, { name: 'Simple Syrup', unit: 'ml', category: 'prep', parLevel: 3000, shelfLifeDays: 10 })
  const ipa = ensureSku(db, { name: 'Hazy IPA Keg', unit: 'oz', category: 'beer', parLevel: 3968 })
  const redWine = ensureSku(db, { name: 'House Red Wine', unit: 'oz', category: 'wine', parLevel: 304 })

  ensureVendorItem(db, { vendorId: southern, skuId: tequila, packSize: 1000, packUnit: 'bottle', price: 24, leadTimeDays: 3, minOrderQty: 1000 })
  ensureVendorItem(db, { vendorId: southern, skuId: tripleSec, packSize: 1000, packUnit: 'bottle', price: 14, leadTimeDays: 3, minOrderQty: 1000 })
  ensureVendorItem(db, { vendorId: southern, skuId: bourbon, packSize: 1000, packUnit: 'bottle', price: 22, leadTimeDays: 3, minOrderQty: 1000 })
  ensureVendorItem(db, { vendorId: local, skuId: syrup, packSize: 1000, packUnit: 'batch', price: 4, leadTimeDays: 1, minOrderQty: 1000 })
  ensureVendorItem(db, { vendorId: craft, skuId: ipa, packSize: 1984, packUnit: 'half-barrel', price: 145, leadTimeDays: 4, minOrderQty: 1984 })
  ensureVendorItem(db, { vendorId: southern, skuId: redWine, packSize: 152, packUnit: 'case', price: 72, leadTimeDays: 3, minOrderQty: 152 })

  const margarita = ensureMenuItem(db, 'House Margarita', 'toast-margarita', 'cocktails')
  const oldFashioned = ensureMenuItem(db, 'Old Fashioned', 'toast-old-fashioned', 'cocktails')
  const draftIpa = ensureMenuItem(db, 'Draft Hazy IPA', 'toast-hazy-ipa', 'beer')
  const wine = ensureMenuItem(db, 'House Red Glass', 'toast-house-red', 'wine')

  upsertRecipeItem(db, { menuItemId: margarita, skuId: tequila, quantity: 60, unit: 'ml' })
  upsertRecipeItem(db, { menuItemId: margarita, skuId: tripleSec, quantity: 20, unit: 'ml' })
  upsertRecipeItem(db, { menuItemId: oldFashioned, skuId: bourbon, quantity: 60, unit: 'ml' })
  upsertRecipeItem(db, { menuItemId: oldFashioned, skuId: syrup, quantity: 8, unit: 'ml' })
  upsertRecipeItem(db, { menuItemId: draftIpa, skuId: ipa, quantity: 16, unit: 'oz' })
  upsertRecipeItem(db, { menuItemId: wine, skuId: redWine, quantity: 5, unit: 'oz' })
}

const generatedInvoices = (asOf: Date): InvoiceRow[] => [
  { vendor: 'Southern Glazer', invoiceNumber: 'FIELD-SG-1001', invoiceDate: isoDaysAgo(asOf, 6, 10), sku: 'Blanco Tequila 1L', quantity: 3000, unit: 'ml', unitCost: 0.024, category: 'liquor' },
  { vendor: 'Southern Glazer', invoiceNumber: 'FIELD-SG-1002', invoiceDate: isoDaysAgo(asOf, 6, 10), sku: 'Triple Sec 1L', quantity: 2000, unit: 'ml', unitCost: 0.014, category: 'liquor' },
  { vendor: 'Southern Glazer', invoiceNumber: 'FIELD-SG-1003', invoiceDate: isoDaysAgo(asOf, 6, 10), sku: 'House Bourbon 1L', quantity: 3000, unit: 'ml', unitCost: 0.022, category: 'liquor' },
  { vendor: 'Local Produce Co', invoiceNumber: 'FIELD-LP-2044', invoiceDate: isoDaysAgo(asOf, 5, 8), sku: 'Simple Syrup', quantity: 2200, unit: 'ml', unitCost: 0.004, category: 'prep' },
  { vendor: 'Craft Beverage Supply', invoiceNumber: 'FIELD-CB-7781', invoiceDate: isoDaysAgo(asOf, 4, 11), sku: 'Hazy IPA Keg', quantity: 1984, unit: 'oz', unitCost: 0.073, category: 'beer' },
  { vendor: 'Southern Glazer', invoiceNumber: 'FIELD-WN-3307', invoiceDate: isoDaysAgo(asOf, 4, 12), sku: 'House Red Wine', quantity: 304, unit: 'oz', unitCost: 0.47, category: 'wine' },
]

const generatedToastSales = (asOf: Date): ToastSalesRow[] => {
  const menu: Array<[string, string, number[]]> = [
    ['toast-margarita', 'House Margarita', [18, 22, 16, 24]],
    ['toast-old-fashioned', 'Old Fashioned', [10, 14, 9, 16]],
    ['toast-hazy-ipa', 'Draft Hazy IPA', [36, 42, 30, 48]],
    ['toast-house-red', 'House Red Glass', [12, 18, 14, 20]],
    ['toast-mule', 'House Mule', [14, 18, 12, 21]],
    ['toast-burger', 'Classic Burger', [20, 26, 18, 30]],
  ]
  const rows: ToastSalesRow[] = []
  for (let day = 4; day >= 1; day -= 1) {
    for (const [externalId, name, counts] of menu) {
      rows.push({
        externalId: `FIELD-${externalId}-${day}`,
        occurredAt: isoDaysAgo(asOf, day, 21),
        menuItem: name,
        quantitySold: counts[4 - day],
      })
    }
  }
  rows.push({
    externalId: 'FIELD-toast-special-1',
    occurredAt: isoDaysAgo(asOf, 1, 22),
    menuItem: 'Bartender Feature Cocktail',
    quantitySold: 9,
  })
  return rows
}

const generatedCounts = (asOf: Date): CountRow[] => [
  { countId: 'FIELD-COUNT-VODKA', occurredAt: isoDaysAgo(asOf, 0, 8), sku: 'House Vodka 1L', countedQuantity: 3900, unit: 'ml' },
  { countId: 'FIELD-COUNT-TEQUILA', occurredAt: isoDaysAgo(asOf, 0, 8), sku: 'Blanco Tequila 1L', countedQuantity: 930, unit: 'ml' },
  { countId: 'FIELD-COUNT-BOURBON', occurredAt: isoDaysAgo(asOf, 0, 8), sku: 'House Bourbon 1L', countedQuantity: 840, unit: 'ml' },
  { countId: 'FIELD-COUNT-IPA', occurredAt: isoDaysAgo(asOf, 0, 8), sku: 'Hazy IPA Keg', countedQuantity: 640, unit: 'oz' },
  { countId: 'FIELD-COUNT-BUN', occurredAt: isoDaysAgo(asOf, 0, 8), sku: 'Burger Bun', countedQuantity: 16, unit: 'each' },
]
