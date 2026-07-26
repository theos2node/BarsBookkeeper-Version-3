import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyDecision, applyExistingDecision, dismissDecision, reverseDecision } from '../src/brain/decisions.js'
import { applyReviewDecision } from '../src/brain/index.js'
import { runOpenClawBrain } from '../src/brain/openclaw.js'
import { openDatabase, type Db } from '../src/db/database.js'
import { getInventoryPosition, getInventoryPositions } from '../src/db/inventory.js'
import { migrateDatabase } from '../src/db/migrations.js'
import { ensureMenuItem, ensureSku, ensureVendor, ensureVendorItem, upsertRecipeItem } from '../src/db/repositories.js'
import { seedDemoData } from '../src/db/seed.js'
import { generateForecasts } from '../src/forecast/index.js'
import { ingestCounts, ingestInvoices, ingestToastSales } from '../src/ingest/index.js'
import { ingestInventoryNotes, parseInventoryNotes } from '../src/ingest/notes.js'
import { mapToastRecipeAndBackfill, suggestToastRecipeMappings } from '../src/ingest/recipes.js'
import { generateVendorGroupedOrderRecommendations } from '../src/orders/index.js'

describe('backend data slice', () => {
  let db: Db
  const asOf = '2026-05-11T12:00:00.000Z'

  beforeEach(() => {
    db = openDatabase(':memory:')
    migrateDatabase(db)
  })

  afterEach(() => {
    db.close()
  })

  it('creates the requested schema through migrations', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name)

    expect(tables).toEqual(
      expect.arrayContaining([
        'sources',
        'source_documents',
        'ingest_runs',
        'evidence_items',
        'vendors',
        'skus',
        'vendor_items',
        'vendor_item_prices',
        'menu_items',
        'recipes',
        'inventory_events',
        'openclaw_decisions',
        'forecasts',
        'order_recommendations',
        'audit_log',
        'backbone_maintenance_runs',
      ]),
    )
  })

  it('detects mutation of an already-applied database migration', () => {
    db.prepare("UPDATE schema_migrations SET checksum = 'tampered' WHERE id = 1").run()
    expect(() => migrateDatabase(db)).toThrow('migration_checksum_mismatch:1')
  })

  it('seeds demo operating data', () => {
    seedDemoData(db, asOf)

    expect(db.prepare('SELECT COUNT(*) AS count FROM vendors').get()?.count).toBe(3)
    expect(db.prepare('SELECT COUNT(*) AS count FROM recipes').get()?.count).toBe(4)
    expect(getInventoryPositions(db, { asOf }).length).toBeGreaterThan(0)
  })

  it('ingests invoices, counts, and Toast sales into evidence-backed inventory events', () => {
    seedDemoData(db, asOf)

    const invoice = ingestInvoices(
      db,
      `vendor,invoiceNumber,invoiceDate,sku,quantity,unit,unitCost
Southern Glazer,INV-1,2026-05-11T13:00:00.000Z,House Vodka 1L,1000,ml,0.02`,
    )
    const toast = ingestToastSales(db, [
      {
        externalId: 'check-1',
        occurredAt: '2026-05-11T14:00:00.000Z',
        menuItem: 'House Mule',
        quantitySold: 10,
      },
    ])
    const count = ingestCounts(db, [
      {
        countId: 'count-1',
        occurredAt: '2026-05-11T15:00:00.000Z',
        sku: 'House Vodka 1L',
        countedQuantity: 5200,
        unit: 'ml',
      },
    ])

    expect(invoice.recordsImported).toBe(1)
    expect(toast.recordsImported).toBe(1)
    expect(count.recordsImported).toBe(1)
    expect(db.prepare('SELECT COUNT(*) AS count FROM evidence_items').get()?.count).toBeGreaterThanOrEqual(8)
    expect(db.prepare('SELECT COUNT(*) AS count FROM vendor_item_prices').get()?.count).toBeGreaterThanOrEqual(1)

    const skuId = ensureSku(db, { name: 'House Vodka 1L', unit: 'ml' })
    const position = getInventoryPosition(db, skuId, { asOf: '2026-05-11T16:00:00.000Z' })
    expect(position?.onHand).toBe(5200)
  })

  it('derives replay-stable IDs when source rows have no external ID', () => {
    ensureSku(db, { name: 'Stable Vodka 1L', unit: 'ml' })
    ensureSku(db, { name: 'Stable Gin 1L', unit: 'ml' })
    const rows = [
      {
        occurredAt: '2026-05-11T15:00:00.000Z',
        sku: 'Stable Vodka 1L',
        countedQuantity: 900,
        unit: 'ml',
      },
      {
        occurredAt: '2026-05-11T15:00:00.000Z',
        sku: 'Stable Gin 1L',
        countedQuantity: 800,
        unit: 'ml',
      },
    ]

    const first = ingestCounts(db, rows)
    const replay = ingestCounts(db, [...rows].reverse())

    expect(first.recordsImported).toBe(2)
    expect(replay.recordsImported).toBe(0)
    expect(db.prepare("SELECT COUNT(*) AS count FROM source_documents WHERE document_type = 'count'").get()?.count).toBe(2)
  })

  it('rejects malformed count values and timestamps without mutating inventory', () => {
    const skuId = ensureSku(db, { name: 'Validated Vodka 1L', unit: 'ml' })
    const result = ingestCounts(db, [
      {
        occurredAt: 'not-a-date',
        sku: 'Validated Vodka 1L',
        countedQuantity: 'not-a-number',
        unit: 'ml',
      },
    ])

    expect(result.recordsImported).toBe(0)
    expect(result.errors).toBe(1)
    expect(getInventoryPosition(db, skuId, { asOf })?.onHand).toBe(0)
  })

  it('parses rough manager notes into sparse count evidence', () => {
    seedDemoData(db, asOf)

    const parsed = parseInventoryNotes(db, 'House Vodka 1L 4.5 bottles; Lime Juice 1250 ml; mystery shelf maybe', {
      occurredAt: '2026-05-11T15:30:00.000Z',
    })

    expect(parsed.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sku: 'House Vodka 1L',
          countedQuantity: 4500,
          unit: 'ml',
          occurredAt: '2026-05-11T15:30:00.000Z',
        }),
        expect.objectContaining({
          sku: 'Lime Juice',
          countedQuantity: 1250,
          unit: 'ml',
          occurredAt: '2026-05-11T15:30:00.000Z',
        }),
      ]),
    )
    expect(parsed.skipped).toEqual([{ text: 'mystery shelf maybe', reason: 'could not parse quantity/unit' }])

    const imported = ingestInventoryNotes(db, 'House Vodka 1L 4.5 bottles', {
      occurredAt: '2026-05-11T16:00:00.000Z',
    })
    expect(imported.ingest?.recordsImported).toBe(1)
    expect(imported.ingest?.errors).toBe(0)

    const skuId = ensureSku(db, { name: 'House Vodka 1L', unit: 'ml' })
    expect(getInventoryPosition(db, skuId, { asOf: '2026-05-11T16:30:00.000Z' })?.onHand).toBe(4500)
    expect(db.prepare("SELECT COUNT(*) AS count FROM source_documents WHERE document_type = 'count' AND external_id LIKE 'NOTE-%'").get()?.count).toBe(1)
    expect(db.prepare("SELECT COUNT(*) AS count FROM evidence_items WHERE evidence_type = 'inventory_count'").get()?.count).toBe(1)
  })

  it('applies and reverses OpenClaw decisions as auditable inventory events', () => {
    const eventId = applyDecision(db, {
      title: 'Add missed bottle delivery',
      payload: {
        eventType: 'purchase',
        skuName: 'House Gin 1L',
        vendorName: 'Southern Glazer',
        quantity: 1000,
        unit: 'ml',
        occurredAt: asOf,
        reason: 'Invoice line was omitted',
      },
      confidence: 0.82,
    })
    const skuId = ensureSku(db, { name: 'House Gin 1L', unit: 'ml' })

    expect(eventId).toBeGreaterThan(0)
    expect(getInventoryPosition(db, skuId, { asOf })?.onHand).toBe(1000)

    const decisionId = Number(db.prepare('SELECT id FROM openclaw_decisions LIMIT 1').get()?.id)
    const reversalId = reverseDecision(db, decisionId)
    expect(reversalId).toBeGreaterThan(eventId)
    expect(getInventoryPosition(db, skuId)?.onHand).toBe(0)
    expect(db.prepare('SELECT COUNT(*) AS count FROM audit_log').get()?.count).toBe(3)
    expect(() => reverseDecision(db, decisionId)).toThrow('decision_not_reversible')
    expect(() => dismissDecision(db, decisionId, 'Wrong queue')).toThrow('decision_not_dismissible')
    expect(getInventoryPosition(db, skuId)?.onHand).toBe(0)
  })

  it('can dismiss or apply manager-reviewed OpenClaw decisions', () => {
    const reviewDecisionId = applyDecision(db, {
      title: 'Review missed gin delivery',
      payload: {
        eventType: 'purchase',
        skuName: 'House Gin 1L',
        quantity: 1000,
        unit: 'ml',
        occurredAt: asOf,
        reason: 'Low-confidence invoice match',
      },
      confidence: 0.4,
      riskLevel: 'medium',
    })
    expect(db.prepare('SELECT state FROM openclaw_decisions WHERE id = ?').get(reviewDecisionId)?.state).toBe('needs_review')

    const eventId = applyExistingDecision(db, reviewDecisionId)
    const skuId = ensureSku(db, { name: 'House Gin 1L', unit: 'ml' })
    expect(eventId).toBeGreaterThan(0)
    expect(getInventoryPosition(db, skuId, { asOf })?.onHand).toBe(1000)

    const dismissId = applyDecision(db, {
      title: 'Review unlikely count',
      payload: {
        eventType: 'adjustment',
        skuName: 'House Gin 1L',
        quantity: -5000,
        unit: 'ml',
        occurredAt: asOf,
      },
      confidence: 0.2,
      riskLevel: 'high',
    })
    dismissDecision(db, dismissId, 'Bad source row')
    expect(db.prepare('SELECT state FROM openclaw_decisions WHERE id = ?').get(dismissId)?.state).toBe('suppressed')
  })

  it('keeps advisory review tasks out of the inventory mutation apply path', async () => {
    seedDemoData(db, asOf)
    await runOpenClawBrain(db)
    const advisoryId = Number(
      db
        .prepare("SELECT id FROM openclaw_decisions WHERE state = 'needs_review' AND payload_json LIKE '%inventory_risk_review%' ORDER BY id LIMIT 1")
        .get()?.id,
    )
    const advisory = applyReviewDecision(
      db,
      advisoryId,
    )
    expect(advisory.applied).toBe(false)
    expect(advisory.next).toContain('advisory review')
    expect(db.prepare('SELECT state FROM openclaw_decisions WHERE id = ?').get(advisoryId)?.state).toBe('needs_review')
  })

  it('maps missing Toast recipes and backfills unresolved consumption idempotently', () => {
    seedDemoData(db, asOf)
    ingestToastSales(db, [
      {
        externalId: 'toast-smoke-martini',
        occurredAt: '2026-05-11T14:00:00.000Z',
        menuItem: 'Smoke Test Martini',
        quantitySold: 2,
      },
    ])

    expect(db.prepare("SELECT COUNT(*) AS count FROM evidence_items WHERE evidence_type = 'toast_missing_recipe'").get()?.count).toBe(1)
    expect(db.prepare("SELECT COUNT(*) AS count FROM openclaw_decisions WHERE state = 'needs_review'").get()?.count).toBe(1)

    const mapped = mapToastRecipeAndBackfill(db, {
      menuItemName: 'Smoke Test Martini',
      skuName: 'House Vodka 1L',
      quantity: 75,
      unit: 'ml',
    })

    expect(mapped.backfilledEvents).toBe(1)
    expect(mapped.suppressedReviews).toBe(1)
    expect(db.prepare("SELECT COUNT(*) AS count FROM evidence_items WHERE evidence_type = 'toast_sale'").get()?.count).toBe(1)
    expect(db.prepare("SELECT COUNT(*) AS count FROM openclaw_decisions WHERE state = 'needs_review'").get()?.count).toBe(0)

    const skuId = ensureSku(db, { name: 'House Vodka 1L', unit: 'ml' })
    expect(getInventoryPosition(db, skuId, { asOf: '2026-05-11T15:00:00.000Z' })?.onHand).toBe(4850)

    const repeated = mapToastRecipeAndBackfill(db, {
      menuItemName: 'Smoke Test Martini',
      skuName: 'House Vodka 1L',
      quantity: 75,
      unit: 'ml',
    })
    expect(repeated.backfilledEvents).toBe(0)
    expect(repeated.skippedExistingEvents).toBe(1)
    expect(db.prepare("SELECT COUNT(*) AS count FROM inventory_events WHERE event_type = 'sale'").get()?.count).toBe(1)
  })

  it('suggests conservative mappings for unresolved Toast recipes without mutating inventory', () => {
    seedDemoData(db, asOf)
    ingestToastSales(db, [
      {
        externalId: 'toast-suggestion-martini',
        occurredAt: '2026-05-11T14:00:00.000Z',
        menuItem: 'Smoke Test Martini',
        quantitySold: 3,
      },
    ])

    const suggestions = suggestToastRecipeMappings(db)
    expect(suggestions.some((suggestion) =>
      suggestion.menuItemName === 'Smoke Test Martini' &&
      suggestion.suggestedSkuName === 'House Vodka 1L' &&
      suggestion.suggestedQuantity === 75 &&
      suggestion.suggestedUnit === 'ml' &&
      suggestion.command.includes('bbk toast map-recipe'),
    )).toBe(true)
    expect(db.prepare("SELECT COUNT(*) AS count FROM inventory_events WHERE event_type = 'sale'").get()?.count).toBe(0)
    expect(db.prepare("SELECT COUNT(*) AS count FROM openclaw_decisions WHERE state = 'needs_review'").get()?.count).toBe(1)
  })

  it('generates forecasts and vendor-grouped order recommendations', () => {
    seedDemoData(db, asOf)
    ingestToastSales(db, [
      { externalId: 'check-1', occurredAt: '2026-05-10T12:00:00.000Z', menuItem: 'Classic Burger', quantitySold: 18 },
      { externalId: 'check-2', occurredAt: '2026-05-11T12:00:00.000Z', menuItem: 'Classic Burger', quantitySold: 18 },
    ])

    const forecasts = generateForecasts(db, { asOf, horizonDays: 7, usageWindowDays: 7 })
    const orders = generateVendorGroupedOrderRecommendations(db, { asOf, horizonDays: 7, usageWindowDays: 7 })

    expect(forecasts.length).toBeGreaterThan(0)
    expect(orders.length).toBeGreaterThan(0)
    expect(orders.flatMap((group) => group.items).some((item) => item.skuName === 'Burger Bun')).toBe(true)
    expect(db.prepare('SELECT COUNT(*) AS count FROM order_recommendations').get()?.count).toBeGreaterThan(0)
  })

  it('chooses order vendors by unit cost instead of absolute pack price', () => {
    const skuId = ensureSku(db, { name: 'Well Rum 1L', unit: 'ml', category: 'liquor', parLevel: 4000 })
    const smallPackVendor = ensureVendor(db, 'Small Pack Vendor')
    const bulkVendor = ensureVendor(db, 'Bulk Value Vendor')
    ensureVendorItem(db, {
      vendorId: smallPackVendor,
      skuId,
      packSize: 100,
      packUnit: 'split',
      price: 30,
      leadTimeDays: 1,
      minOrderQty: 100,
    })
    ensureVendorItem(db, {
      vendorId: bulkVendor,
      skuId,
      packSize: 1000,
      packUnit: 'bottle',
      price: 200,
      leadTimeDays: 2,
      minOrderQty: 1000,
    })
    const menuItemId = ensureMenuItem(db, 'Well Rum Coke', 'well-rum-coke', 'cocktails')
    upsertRecipeItem(db, { menuItemId, skuId, quantity: 100, unit: 'ml' })
    ingestInvoices(db, [
      {
        vendor: 'Small Pack Vendor',
        invoiceNumber: 'RUM-OPEN',
        invoiceDate: '2026-05-01T09:00:00.000Z',
        sku: 'Well Rum 1L',
        quantity: 1000,
        unit: 'ml',
        unitCost: 0.3,
        category: 'liquor',
      },
    ])
    ingestToastSales(db, [
      { externalId: 'RUM-SALE-1', occurredAt: '2026-05-10T21:00:00.000Z', menuItem: 'Well Rum Coke', quantitySold: 6 },
      { externalId: 'RUM-SALE-2', occurredAt: '2026-05-11T21:00:00.000Z', menuItem: 'Well Rum Coke', quantitySold: 6 },
    ])

    const orders = generateVendorGroupedOrderRecommendations(db, {
      asOf: '2026-05-12T00:00:00.000Z',
      horizonDays: 7,
      usageWindowDays: 7,
    })
    const item = orders.flatMap((group) => group.items).find((row) => row.skuName === 'Well Rum 1L')

    expect(item?.vendorName).toBe('Bulk Value Vendor')
    expect(item?.estimatedCost).toBeGreaterThan(0)
  })

  it('chooses order vendors from invoice-observed prices as of the order time', () => {
    const skuId = ensureSku(db, { name: 'Timeline Gin 1L', unit: 'ml', category: 'liquor', parLevel: 4000 })
    const steadyVendor = ensureVendor(db, 'Steady Gin Vendor')
    const futureDiscountVendor = ensureVendor(db, 'Future Discount Gin Vendor')
    ensureVendorItem(db, {
      vendorId: steadyVendor,
      skuId,
      packSize: 1000,
      packUnit: 'bottle',
      price: 20,
      leadTimeDays: 2,
      minOrderQty: 1000,
    })
    ensureVendorItem(db, {
      vendorId: futureDiscountVendor,
      skuId,
      packSize: 1000,
      packUnit: 'bottle',
      price: 50,
      leadTimeDays: 2,
      minOrderQty: 1000,
    })
    const menuItemId = ensureMenuItem(db, 'Timeline Gin Fizz', 'timeline-gin-fizz', 'cocktails')
    upsertRecipeItem(db, { menuItemId, skuId, quantity: 100, unit: 'ml' })
    ingestInvoices(db, [
      {
        vendor: 'Steady Gin Vendor',
        invoiceNumber: 'TIMELINE-GIN-STEADY-OLD',
        invoiceDate: '2026-05-01T09:00:00.000Z',
        sku: 'Timeline Gin 1L',
        quantity: 1000,
        unit: 'ml',
        unitCost: 0.02,
        category: 'liquor',
      },
      {
        vendor: 'Future Discount Gin Vendor',
        invoiceNumber: 'TIMELINE-GIN-DISCOUNT-OLD',
        invoiceDate: '2026-05-01T09:00:00.000Z',
        sku: 'Timeline Gin 1L',
        quantity: 1000,
        unit: 'ml',
        unitCost: 0.05,
        category: 'liquor',
      },
      {
        vendor: 'Future Discount Gin Vendor',
        invoiceNumber: 'TIMELINE-GIN-DISCOUNT-FUTURE',
        invoiceDate: '2026-05-20T09:00:00.000Z',
        sku: 'Timeline Gin 1L',
        quantity: 1000,
        unit: 'ml',
        unitCost: 0.01,
        category: 'liquor',
      },
    ])
    ingestToastSales(db, [
      { externalId: 'TIMELINE-GIN-SALE-1', occurredAt: '2026-05-09T21:00:00.000Z', menuItem: 'Timeline Gin Fizz', quantitySold: 6 },
      { externalId: 'TIMELINE-GIN-SALE-2', occurredAt: '2026-05-10T21:00:00.000Z', menuItem: 'Timeline Gin Fizz', quantitySold: 6 },
    ])

    const beforeFutureInvoice = generateVendorGroupedOrderRecommendations(db, {
      asOf: '2026-05-12T00:00:00.000Z',
      horizonDays: 7,
      usageWindowDays: 30,
    }).flatMap((group) => group.items).find((row) => row.skuName === 'Timeline Gin 1L')
    const afterFutureInvoice = generateVendorGroupedOrderRecommendations(db, {
      asOf: '2026-05-21T00:00:00.000Z',
      horizonDays: 7,
      usageWindowDays: 30,
    }).flatMap((group) => group.items).find((row) => row.skuName === 'Timeline Gin 1L')

    expect(beforeFutureInvoice?.vendorName).toBe('Steady Gin Vendor')
    expect(beforeFutureInvoice?.estimatedCost).toBeGreaterThan(0)
    expect(afterFutureInvoice?.vendorName).toBe('Future Discount Gin Vendor')
    expect(afterFutureInvoice?.estimatedCost).toBeLessThan(beforeFutureInvoice?.estimatedCost ?? 0)
  })

  it('regenerates orders idempotently for the same forecast window', () => {
    seedDemoData(db, asOf)

    const first = generateVendorGroupedOrderRecommendations(db, { asOf, horizonDays: 7, usageWindowDays: 7 })
    const firstCount = db.prepare("SELECT COUNT(*) AS count FROM order_recommendations WHERE status = 'open'").get()?.count
    const second = generateVendorGroupedOrderRecommendations(db, { asOf, horizonDays: 7, usageWindowDays: 7 })
    const secondCount = db.prepare("SELECT COUNT(*) AS count FROM order_recommendations WHERE status = 'open'").get()?.count

    expect(first.flatMap((group) => group.items).length).toBeGreaterThan(0)
    expect(second.flatMap((group) => group.items).map((item) => item.recommendationId)).toEqual(
      first.flatMap((group) => group.items).map((item) => item.recommendationId),
    )
    expect(secondCount).toBe(firstCount)
  })

  it('dismisses stale open order recommendations when inventory is replenished', () => {
    seedDemoData(db, asOf)
    generateVendorGroupedOrderRecommendations(db, { asOf, horizonDays: 7, usageWindowDays: 7 })

    ingestInvoices(db, [
      {
        vendor: 'Downtown Bakery',
        invoiceNumber: 'RESTOCK-BUNS',
        invoiceDate: '2026-05-11T13:00:00.000Z',
        sku: 'Burger Bun',
        quantity: 1000,
        unit: 'each',
        unitCost: 0.5,
      },
    ])
    generateVendorGroupedOrderRecommendations(db, {
      asOf: '2026-05-11T14:00:00.000Z',
      horizonDays: 7,
      usageWindowDays: 7,
    })

    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM order_recommendations o
           JOIN skus s ON s.id = o.sku_id
           WHERE s.name = 'Burger Bun' AND o.status = 'open'`,
        )
        .get()?.count,
    ).toBe(0)
  })
})
