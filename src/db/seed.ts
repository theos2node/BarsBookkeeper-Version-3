import { createDecision, markDecisionApplied } from '../brain/decisions.js'
import { withTransaction, type Db } from './database.js'
import {
  ensureMenuItem,
  ensureSku,
  ensureSource,
  ensureVendor,
  ensureVendorItem,
  seedInventoryEventWithEvidence,
  upsertRecipeItem,
} from './repositories.js'

export const seedDemoData = (db: Db, asOf = new Date().toISOString()): void => {
  withTransaction(db, () => {
    ensureSource(db, 'Demo seed', 'seed')

    const southern = ensureVendor(db, 'Southern Glazer')
    const local = ensureVendor(db, 'Local Produce Co')
    const bakery = ensureVendor(db, 'Downtown Bakery')

    const vodka = ensureSku(db, { name: 'House Vodka 1L', unit: 'ml', category: 'liquor', parLevel: 6000 })
    const lime = ensureSku(db, { name: 'Lime Juice', unit: 'ml', category: 'produce', parLevel: 2500, shelfLifeDays: 5 })
    const burgerBun = ensureSku(db, { name: 'Burger Bun', unit: 'each', category: 'bread', parLevel: 48, shelfLifeDays: 4 })
    const beef = ensureSku(db, { name: 'Burger Patty', unit: 'each', category: 'protein', parLevel: 40, shelfLifeDays: 4 })

    ensureVendorItem(db, { vendorId: southern, skuId: vodka, packSize: 1000, packUnit: 'bottle', price: 18.5, leadTimeDays: 3, minOrderQty: 1000 })
    ensureVendorItem(db, { vendorId: local, skuId: lime, packSize: 1000, packUnit: 'case', price: 8, leadTimeDays: 1, minOrderQty: 1000 })
    ensureVendorItem(db, { vendorId: bakery, skuId: burgerBun, packSize: 24, packUnit: 'case', price: 12, leadTimeDays: 1, minOrderQty: 24 })
    ensureVendorItem(db, { vendorId: local, skuId: beef, packSize: 20, packUnit: 'case', price: 45, leadTimeDays: 2, minOrderQty: 20 })

    const mule = ensureMenuItem(db, 'House Mule', 'toast-mule', 'cocktails')
    const burger = ensureMenuItem(db, 'Classic Burger', 'toast-burger', 'food')

    upsertRecipeItem(db, { menuItemId: mule, skuId: vodka, quantity: 50, unit: 'ml' })
    upsertRecipeItem(db, { menuItemId: mule, skuId: lime, quantity: 20, unit: 'ml' })
    upsertRecipeItem(db, { menuItemId: burger, skuId: burgerBun, quantity: 1, unit: 'each' })
    upsertRecipeItem(db, { menuItemId: burger, skuId: beef, quantity: 1, unit: 'each' })

    seedStock(db, {
      skuId: vodka,
      skuName: 'House Vodka 1L',
      quantity: 5000,
      unit: 'ml',
      unitCost: 0.0185,
      occurredAt: asOf,
      summary: 'Demo opening stock for House Vodka 1L',
    })
    seedStock(db, {
      skuId: lime,
      skuName: 'Lime Juice',
      quantity: 2000,
      unit: 'ml',
      unitCost: 0.008,
      occurredAt: asOf,
      summary: 'Demo opening stock for Lime Juice',
    })
    seedStock(db, {
      skuId: burgerBun,
      skuName: 'Burger Bun',
      quantity: 36,
      unit: 'each',
      unitCost: 0.5,
      occurredAt: asOf,
      summary: 'Demo opening stock for Burger Bun',
    })
    seedStock(db, {
      skuId: beef,
      skuName: 'Burger Patty',
      quantity: 30,
      unit: 'each',
      unitCost: 2.25,
      occurredAt: asOf,
      summary: 'Demo opening stock for Burger Patty',
    })
  })
}

const seedStock = (
  db: Db,
  input: {
    skuId: number
    skuName: string
    quantity: number
    unit: string
    unitCost: number
    occurredAt: string
    summary: string
  },
) => {
  const existing = db
    .prepare(
      `SELECT id FROM inventory_events
       WHERE sku_id = ? AND event_type = 'purchase' AND quantity = ? AND occurred_at = ? AND note = ?`,
    )
    .get(input.skuId, input.quantity, input.occurredAt, input.summary)
  if (existing) return

  const decisionId = createDecision(db, {
    title: `Apply demo opening stock: ${input.skuName}`,
    payload: {
      kind: 'demo_opening_stock',
      eventType: 'purchase',
      skuName: input.skuName,
      quantity: input.quantity,
      unit: input.unit,
      occurredAt: input.occurredAt,
    },
    confidence: 1,
    riskLevel: 'low',
    state: 'auto_applied',
    evidence: [{ kind: 'seed', summary: input.summary }],
  })
  const eventId = seedInventoryEventWithEvidence(db, {
    skuId: input.skuId,
    eventType: 'purchase',
    quantity: input.quantity,
    unit: input.unit,
    unitCost: input.unitCost,
    decisionId,
    occurredAt: input.occurredAt,
    evidenceType: 'seed',
    summary: input.summary,
  })
  markDecisionApplied(db, decisionId, eventId)
}
