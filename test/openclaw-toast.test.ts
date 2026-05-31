import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runOpenClawBrain } from '../src/brain/openclaw.js'
import { openDatabase, type Db } from '../src/db/database.js'
import { migrateDatabase } from '../src/db/migrations.js'
import { ensureMenuItem, ensureSku, upsertRecipeItem } from '../src/db/repositories.js'
import { seedDemoData } from '../src/db/seed.js'
import { ingestCounts, ingestToastSales } from '../src/ingest/index.js'
import { mapToastRecipeAndBackfill } from '../src/ingest/recipes.js'
import { flattenToastOrders, pullToast } from '../src/ingest/toast.js'

describe('OpenClaw and Toast prototype integration', () => {
  let db: Db

  beforeEach(() => {
    db = openDatabase(':memory:')
    migrateDatabase(db)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    db.close()
  })

  it('flattens Toast checks and selections into sale rows', () => {
    const rows = flattenToastOrders(
      {
        orders: [
          {
            guid: 'order-1',
            closedDate: '2026-05-11T18:00:00.000Z',
            checks: [
              {
                guid: 'check-1',
                selections: [
                  { guid: 'sel-1', displayName: 'House Mule', quantity: 2 },
                  { guid: 'sel-2', displayName: 'Voided Drink', quantity: 1, voided: true },
                ],
              },
            ],
          },
        ],
      },
      'restaurant-1',
    )

    expect(rows).toEqual([
      {
        externalId: 'restaurant-1:order-1:check-1:sel-1',
        businessDate: '2026-05-11T18:00:00.000Z',
        occurredAt: '2026-05-11T18:00:00.000Z',
        menuItem: 'House Mule',
        menuItemName: 'House Mule',
        selectionRole: 'selection',
        quantitySold: 2,
      },
    ])
  })

  it('flattens Toast modifier selections into separate sale evidence rows', () => {
    const rows = flattenToastOrders(
      {
        orders: [
          {
            guid: 'order-mod',
            closedDate: '2026-05-11T18:00:00.000Z',
            checks: [
              {
                guid: 'check-mod',
                selections: [
                  {
                    guid: 'sel-mule',
                    displayName: 'House Mule',
                    quantity: 2,
                    modifiers: [
                      { guid: 'mod-lime', displayName: 'Extra Lime', quantity: 1 },
                      { guid: 'mod-void', displayName: 'No Charge Splash', quantity: 1, voided: true },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
      'restaurant-1',
    )

    expect(rows).toEqual([
      expect.objectContaining({
        externalId: 'restaurant-1:order-mod:check-mod:sel-mule',
        menuItem: 'House Mule',
        selectionRole: 'selection',
        quantitySold: 2,
      }),
      expect.objectContaining({
        externalId: 'restaurant-1:order-mod:check-mod:sel-mule:mod-lime',
        menuItem: 'Extra Lime',
        parentMenuItemName: 'House Mule',
        selectionRole: 'modifier',
        quantitySold: 2,
      }),
    ])
  })

  it('ingests Toast modifiers as inventory consumption when mapped', () => {
    seedDemoData(db, '2026-05-11T12:00:00.000Z')
    const limeSkuId = ensureSku(db, { name: 'Lime Juice', unit: 'ml', category: 'produce' })
    const extraLimeId = ensureMenuItem(db, 'Extra Lime', 'toast-extra-lime', 'modifier')
    upsertRecipeItem(db, { menuItemId: extraLimeId, skuId: limeSkuId, quantity: 10, unit: 'ml' })

    const rows = flattenToastOrders({
      orders: [
        {
          guid: 'order-mod-consume',
          closedDate: '2026-05-11T18:00:00.000Z',
          checks: [
            {
              guid: 'check-mod-consume',
              selections: [
                {
                  guid: 'sel-mule-consume',
                  displayName: 'House Mule',
                  quantity: 2,
                  modifiers: [{ guid: 'mod-lime-consume', displayName: 'Extra Lime', quantity: 1 }],
                },
              ],
            },
          ],
        },
      ],
    })

    const result = ingestToastSales(db, rows)
    const limeSold = db
      .prepare("SELECT ABS(SUM(quantity)) AS quantity FROM inventory_events WHERE sku_id = ? AND event_type = 'sale'")
      .get(limeSkuId)

    expect(result.recordsImported).toBe(2)
    expect(limeSold?.quantity).toBe(60)
    expect(db.prepare("SELECT COUNT(*) AS count FROM source_documents WHERE external_id LIKE '%mod-lime-consume'").get()?.count).toBe(1)
  })

  it('accepts nested Toast data wrappers and flat item payloads', () => {
    const rows = flattenToastOrders({
      data: {
        items: [
          {
            guid: 'flat-1',
            selections: [{ guid: 'sel-flat', name: 'House Mule', qty: 1 }],
          },
        ],
      },
    })

    expect(rows).toHaveLength(1)
    expect(rows[0]?.menuItem).toBe('House Mule')
    expect(rows[0]?.quantitySold).toBe(1)
  })

  it('imports already-normalized Toast JSON rows from file', async () => {
    seedDemoData(db, '2026-05-11T12:00:00.000Z')
    const dataDir = await mkdtemp(join(tmpdir(), 'bbk-flat-toast-'))
    const filePath = join(dataDir, 'toast-sales.json')
    try {
      await writeFile(
        filePath,
        JSON.stringify([
          {
            externalId: 'flat-toast-row',
            occurredAt: '2026-05-11T14:00:00.000Z',
            menuItem: 'Flat File Martini',
            quantitySold: 2,
          },
        ]),
        'utf8',
      )

      const result = await pullToast(
        db,
        {
          dataDir,
          dbPath: join(dataDir, 'barsbookkeeper.sqlite'),
          filesDir: join(dataDir, 'files'),
          logicModel: 'test',
          logicReasoningEffort: 'low',
          fastModel: 'test',
          fastReasoningEffort: 'low',
        },
        ['--file', filePath],
      )

      expect(result.rowsPulled).toBe(1)
      expect(result.ingest.recordsImported).toBe(0)
      expect(result.ingest.errors).toBe(1)
      expect(db.prepare("SELECT COUNT(*) AS count FROM evidence_items WHERE evidence_type = 'toast_missing_recipe'").get()?.count).toBe(1)
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it('retries transient Toast API failures and keeps partial restaurant data', async () => {
    seedDemoData(db, '2026-05-11T12:00:00.000Z')
    const dataDir = await mkdtemp(join(tmpdir(), 'bbk-toast-partial-'))
    const attempts = new Map<string, number>()
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined
      const restaurantId = headers?.['Toast-Restaurant-External-ID'] ?? 'unknown'
      const nextAttempt = (attempts.get(restaurantId) ?? 0) + 1
      attempts.set(restaurantId, nextAttempt)

      if (restaurantId === 'retry-ok' && nextAttempt === 1) {
        return { ok: false, status: 500, json: async () => ({}) }
      }
      if (restaurantId === 'retry-ok') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            orders: [
              {
                guid: 'retry-order',
                closedDate: '2026-05-11T18:00:00.000Z',
                checks: [{ guid: 'retry-check', selections: [{ guid: 'retry-selection', displayName: 'House Mule', quantity: 1 }] }],
              },
            ],
          }),
        }
      }
      return { ok: false, status: 503, json: async () => ({}) }
    })
    vi.stubGlobal('fetch', fetchMock)

    try {
      const result = await pullToast(
        db,
        {
          dataDir,
          dbPath: join(dataDir, 'barsbookkeeper.sqlite'),
          filesDir: join(dataDir, 'files'),
          logicModel: 'test',
          logicReasoningEffort: 'low',
          fastModel: 'test',
          fastReasoningEffort: 'low',
        },
        [
          '--host',
          'https://toast.example.test',
          '--restaurants',
          'retry-ok,still-down',
          '--api-key',
          'test-token',
          '--start',
          '2026-05-11T00:00:00.000Z',
          '--end',
          '2026-05-12T00:00:00.000Z',
          '--max-retries',
          '1',
          '--retry-delay-ms',
          '0',
        ],
      )

      expect(result.restaurants).toBe(2)
      expect(result.failedRestaurants).toBe(1)
      expect(result.failures).toEqual([{ restaurantExternalId: 'still-down', error: 'toast_pull_failed:still-down:503' }])
      expect(result.rowsPulled).toBe(1)
      expect(result.ingest.recordsImported).toBe(1)
      expect(attempts.get('retry-ok')).toBe(2)
      expect(attempts.get('still-down')).toBe(2)
      expect(db.prepare("SELECT COUNT(*) AS count FROM source_documents WHERE document_type = 'toast_sale'").get()?.count).toBe(1)
      expect(db.prepare("SELECT COUNT(*) AS count FROM inventory_events WHERE event_type = 'sale'").get()?.count).toBe(2)
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it('creates review tasks from missing Toast recipes and at-risk inventory', async () => {
    seedDemoData(db, '2026-05-11T12:00:00.000Z')
    ingestToastSales(db, [
      {
        externalId: 'toast-unmapped',
        occurredAt: '2026-05-11T14:00:00.000Z',
        menuItem: 'Off Menu Martini',
        quantitySold: 3,
      },
    ])

    const result = await runOpenClawBrain(db)
    const reviewTitles = db
      .prepare("SELECT title FROM openclaw_decisions WHERE state = 'needs_review' ORDER BY title")
      .all()
      .map((row) => String(row.title))

    expect(result.createdDecisions).toBeGreaterThan(0)
    expect(reviewTitles.some((title) => title.includes('Off Menu Martini'))).toBe(true)
    expect(reviewTitles.some((title) => title.includes('inventory'))).toBe(true)
    expect(reviewTitles.some((title) => title.includes('seed source'))).toBe(false)
  })

  it('does not recreate a missing-recipe task after recipe mapping backfills the Toast document', async () => {
    seedDemoData(db, '2026-05-11T12:00:00.000Z')
    ingestToastSales(db, [
      {
        externalId: 'toast-mapped-later',
        occurredAt: '2026-05-11T14:00:00.000Z',
        menuItem: 'Off Menu Martini',
        quantitySold: 3,
      },
    ])
    mapToastRecipeAndBackfill(db, {
      menuItemName: 'Off Menu Martini',
      skuName: 'House Vodka 1L',
      quantity: 75,
      unit: 'ml',
    })

    await runOpenClawBrain(db)

    const recipeReviews = db
      .prepare("SELECT title FROM openclaw_decisions WHERE state = 'needs_review' AND title LIKE '%Off Menu Martini%'")
      .all()
    expect(recipeReviews).toHaveLength(0)
  })

  it('refreshes existing inventory risk tasks instead of duplicating them', async () => {
    seedDemoData(db, '2026-05-11T12:00:00.000Z')
    await runOpenClawBrain(db)

    ingestCounts(db, [
      {
        countId: 'risk-refresh-buns',
        occurredAt: '2026-05-11T13:00:00.000Z',
        sku: 'Burger Bun',
        countedQuantity: 0,
        unit: 'each',
      },
    ])
    await runOpenClawBrain(db)

    const rows = db
      .prepare("SELECT title FROM openclaw_decisions WHERE state = 'needs_review' AND payload_json LIKE '%\"skuName\":\"Burger Bun\"%'")
      .all()
      .map((row) => String(row.title))

    expect(rows).toEqual(['Review critical inventory: Burger Bun'])
  })
})
