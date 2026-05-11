import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runOpenClawBrain } from '../src/brain/openclaw.js'
import { openDatabase, type Db } from '../src/db/database.js'
import { migrateDatabase } from '../src/db/migrations.js'
import { seedDemoData } from '../src/db/seed.js'
import { ingestToastSales } from '../src/ingest/index.js'
import { flattenToastOrders } from '../src/ingest/toast.js'

describe('OpenClaw and Toast prototype integration', () => {
  let db: Db

  beforeEach(() => {
    db = openDatabase(':memory:')
    migrateDatabase(db)
  })

  afterEach(() => {
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
        quantitySold: 2,
      },
    ])
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
  })
})
