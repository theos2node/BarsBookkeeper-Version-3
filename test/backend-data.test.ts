import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyDecision, applyExistingDecision, dismissDecision, reverseDecision } from '../src/brain/decisions.js'
import { applyReviewDecision } from '../src/brain/index.js'
import { runOpenClawBrain } from '../src/brain/openclaw.js'
import { openDatabase, type Db } from '../src/db/database.js'
import { getInventoryPosition, getInventoryPositions } from '../src/db/inventory.js'
import { migrateDatabase } from '../src/db/migrations.js'
import { ensureSku } from '../src/db/repositories.js'
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

    const skuId = ensureSku(db, { name: 'House Vodka 1L', unit: 'ml' })
    const position = getInventoryPosition(db, skuId, { asOf: '2026-05-11T16:00:00.000Z' })
    expect(position?.onHand).toBe(5200)
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
      suggestion.command.includes('toast map-recipe'),
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
