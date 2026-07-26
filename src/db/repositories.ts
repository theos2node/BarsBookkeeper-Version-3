import type { InventoryEventType } from '../domain/types.js'
import { lastInsertId, nowIso, stringifyJson, toNumber, toStringValue, withTransaction, type Db } from './database.js'

export type EnsureSkuInput = {
  name: string
  unit: string
  category?: string | null
  parLevel?: number | null
  shelfLifeDays?: number | null
}

export type InventoryEventInput = {
  skuId: number
  eventType: InventoryEventType
  quantity: number
  unit: string
  unitCost?: number | null
  sourceDocumentId?: number | null
  evidenceItemId?: number | null
  decisionId?: number | null
  occurredAt: string
  note?: string | null
  reversedEventId?: number | null
}

export const ensureSource = (db: Db, name: string, kind: 'invoice' | 'count' | 'toast' | 'manual' | 'seed'): number => {
  const existing = db.prepare('SELECT id FROM sources WHERE name = ?').get(name)
  if (existing) return toNumber(existing.id)

  const result = db.prepare('INSERT INTO sources (name, kind) VALUES (?, ?)').run(name, kind)
  return lastInsertId(result.lastInsertRowid)
}

export const createSourceDocument = (
  db: Db,
  input: {
    sourceId: number
    externalId: string
    documentType: string
    documentDate?: string | null
    rawText?: string | null
    rawJson?: unknown
    contentHash?: string | null
  },
): number => {
  const existing = db
    .prepare('SELECT id FROM source_documents WHERE source_id = ? AND external_id = ? AND document_type = ?')
    .get(input.sourceId, input.externalId, input.documentType)
  if (existing) return toNumber(existing.id)

  const result = db
    .prepare(
      `INSERT INTO source_documents
       (source_id, external_id, document_type, document_date, raw_text, raw_json, content_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.sourceId,
      input.externalId,
      input.documentType,
      input.documentDate ?? null,
      input.rawText ?? null,
      stringifyJson(input.rawJson ?? {}),
      input.contentHash ?? null,
    )
  return lastInsertId(result.lastInsertRowid)
}

export const beginIngestRun = (db: Db, sourceId: number): number => {
  const result = db
    .prepare('INSERT INTO ingest_runs (source_id, status, started_at) VALUES (?, ?, ?)')
    .run(sourceId, 'running', nowIso())
  return lastInsertId(result.lastInsertRowid)
}

export const finishIngestRun = (
  db: Db,
  runId: number,
  status: 'completed' | 'failed',
  recordsSeen: number,
  recordsImported: number,
  errors: number,
  errorMessage?: string,
): void => {
  db.prepare(
    `UPDATE ingest_runs
     SET completed_at = ?, status = ?, records_seen = ?, records_imported = ?, errors = ?, error_message = ?
     WHERE id = ?`,
  ).run(nowIso(), status, recordsSeen, recordsImported, errors, errorMessage ?? null, runId)
}

export const ensureVendor = (db: Db, name: string): number => {
  const cleanName = name.trim()
  if (!cleanName) throw new Error('Vendor name is required')

  const existing = db.prepare('SELECT id FROM vendors WHERE name = ?').get(cleanName)
  if (existing) return toNumber(existing.id)

  const result = db.prepare('INSERT INTO vendors (name) VALUES (?)').run(cleanName)
  return lastInsertId(result.lastInsertRowid)
}

export const ensureSku = (db: Db, input: EnsureSkuInput): number => {
  const name = input.name.trim()
  const unit = input.unit.trim() || 'unit'
  if (!name) throw new Error('SKU name is required')

  const existing = db.prepare('SELECT id, unit, category, par_level FROM skus WHERE name = ?').get(name)
  if (existing) {
    db.prepare(
      `UPDATE skus
       SET unit = COALESCE(NULLIF(?, ''), unit),
           category = COALESCE(?, category),
           par_level = COALESCE(?, par_level),
           shelf_life_days = COALESCE(?, shelf_life_days)
       WHERE id = ?`,
    ).run(unit, input.category ?? null, input.parLevel ?? null, input.shelfLifeDays ?? null, toNumber(existing.id))
    return toNumber(existing.id)
  }

  const result = db
    .prepare('INSERT INTO skus (name, unit, category, par_level, shelf_life_days) VALUES (?, ?, ?, ?, ?)')
    .run(name, unit, input.category ?? null, input.parLevel ?? null, input.shelfLifeDays ?? null)
  return lastInsertId(result.lastInsertRowid)
}

export const ensureVendorItem = (
  db: Db,
  input: {
    vendorId: number
    skuId: number
    vendorSku?: string | null
    packSize?: number | null
    packUnit?: string | null
    price?: number | null
    leadTimeDays?: number | null
    minOrderQty?: number | null
  },
): number => {
  const existing = db.prepare('SELECT id FROM vendor_items WHERE vendor_id = ? AND sku_id = ?').get(input.vendorId, input.skuId)
  const packSize = input.packSize && input.packSize > 0 ? input.packSize : null
  const packUnit = input.packUnit?.trim() || null

  if (existing) {
    db.prepare(
      `UPDATE vendor_items
       SET vendor_sku = COALESCE(?, vendor_sku),
           pack_size = COALESCE(?, pack_size),
           pack_unit = COALESCE(?, pack_unit),
           price = COALESCE(?, price),
           lead_time_days = COALESCE(?, lead_time_days),
           min_order_qty = COALESCE(?, min_order_qty),
           active = 1
       WHERE id = ?`,
    ).run(
      input.vendorSku ?? null,
      packSize,
      packUnit,
      input.price ?? null,
      input.leadTimeDays ?? null,
      input.minOrderQty ?? null,
      toNumber(existing.id),
    )
    return toNumber(existing.id)
  }

  const result = db
    .prepare(
      `INSERT INTO vendor_items
       (vendor_id, sku_id, vendor_sku, pack_size, pack_unit, price, lead_time_days, min_order_qty)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.vendorId,
      input.skuId,
      input.vendorSku ?? null,
      packSize ?? 1,
      packUnit ?? 'unit',
      input.price ?? null,
      input.leadTimeDays ?? 2,
      input.minOrderQty ?? 0,
    )
  return lastInsertId(result.lastInsertRowid)
}

export const ensureMenuItem = (db: Db, name: string, externalId?: string | null, category?: string | null): number => {
  const cleanName = name.trim()
  if (!cleanName) throw new Error('Menu item name is required')

  const existing = db
    .prepare('SELECT id FROM menu_items WHERE name = ? OR (external_id IS NOT NULL AND external_id = ?)')
    .get(cleanName, externalId ?? null)
  if (existing) return toNumber(existing.id)

  const result = db
    .prepare('INSERT INTO menu_items (external_id, name, category) VALUES (?, ?, ?)')
    .run(externalId ?? null, cleanName, category ?? null)
  return lastInsertId(result.lastInsertRowid)
}

export const upsertRecipeItem = (
  db: Db,
  input: { menuItemId: number; skuId: number; quantity: number; unit: string; yieldQuantity?: number },
): number => {
  const existing = db.prepare('SELECT id FROM recipes WHERE menu_item_id = ? AND sku_id = ?').get(input.menuItemId, input.skuId)
  if (existing) {
    db.prepare('UPDATE recipes SET quantity = ?, unit = ?, yield_quantity = ?, active = 1 WHERE id = ?').run(
      input.quantity,
      input.unit,
      input.yieldQuantity ?? 1,
      toNumber(existing.id),
    )
    return toNumber(existing.id)
  }

  const result = db
    .prepare('INSERT INTO recipes (menu_item_id, sku_id, quantity, unit, yield_quantity) VALUES (?, ?, ?, ?, ?)')
    .run(input.menuItemId, input.skuId, input.quantity, input.unit, input.yieldQuantity ?? 1)
  return lastInsertId(result.lastInsertRowid)
}

export const createEvidenceItem = (
  db: Db,
  input: {
    sourceDocumentId?: number | null
    evidenceType: string
    entityType?: string | null
    entityId?: number | null
    inventoryEventId?: number | null
    decisionId?: number | null
    occurredAt?: string | null
    summary: string
    amount?: number | null
    unit?: string | null
    confidence?: number | null
    payload?: unknown
  },
): number => {
  const result = db
    .prepare(
      `INSERT INTO evidence_items
       (source_document_id, evidence_type, entity_type, entity_id, inventory_event_id, decision_id,
        occurred_at, summary, amount, unit, confidence, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.sourceDocumentId ?? null,
      input.evidenceType,
      input.entityType ?? null,
      input.entityId ?? null,
      input.inventoryEventId ?? null,
      input.decisionId ?? null,
      input.occurredAt ?? null,
      input.summary,
      input.amount ?? null,
      input.unit ?? null,
      input.confidence ?? 1,
      stringifyJson(input.payload ?? {}),
    )
  return lastInsertId(result.lastInsertRowid)
}

export const createInventoryEvent = (db: Db, input: InventoryEventInput): number => {
  const result = db
    .prepare(
      `INSERT INTO inventory_events
       (sku_id, event_type, quantity, unit, unit_cost, source_document_id, evidence_item_id,
        decision_id, occurred_at, note, reversed_event_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.skuId,
      input.eventType,
      input.quantity,
      input.unit,
      input.unitCost ?? null,
      input.sourceDocumentId ?? null,
      input.evidenceItemId ?? null,
      input.decisionId ?? null,
      input.occurredAt,
      input.note ?? null,
      input.reversedEventId ?? null,
    )
  return lastInsertId(result.lastInsertRowid)
}

export const logAudit = (
  db: Db,
  input: { actor: string; action: string; entityType: string; entityId?: number | null; before?: unknown; after?: unknown },
): void => {
  db.prepare(
    `INSERT INTO audit_log (actor, action, entity_type, entity_id, before_json, after_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    input.actor,
    input.action,
    input.entityType,
    input.entityId ?? null,
    stringifyJson(input.before ?? {}),
    stringifyJson(input.after ?? {}),
  )
}

export const getSkuByName = (db: Db, name: string): { id: number; name: string; unit: string } | null => {
  const row = db.prepare('SELECT id, name, unit FROM skus WHERE name = ?').get(name.trim())
  if (!row) return null
  return { id: toNumber(row.id), name: toStringValue(row.name), unit: toStringValue(row.unit) }
}

export const getOnHand = (db: Db, skuId: number, at?: string): number => {
  const row = at
    ? db.prepare('SELECT COALESCE(SUM(quantity), 0) AS on_hand FROM inventory_events WHERE sku_id = ? AND occurred_at <= ?').get(skuId, at)
    : db.prepare('SELECT COALESCE(SUM(quantity), 0) AS on_hand FROM inventory_events WHERE sku_id = ?').get(skuId)
  return toNumber(row?.on_hand)
}

export const seedInventoryEventWithEvidence = (
  db: Db,
  input: InventoryEventInput & { summary: string; evidenceType: string; sourceDocumentId?: number | null; payload?: unknown },
): number =>
  withTransaction(db, () => {
    const eventId = createInventoryEvent(db, input)
    const evidenceId = createEvidenceItem(db, {
      sourceDocumentId: input.sourceDocumentId ?? null,
      evidenceType: input.evidenceType,
      entityType: 'inventory_event',
      entityId: eventId,
      inventoryEventId: eventId,
      occurredAt: input.occurredAt,
      summary: input.summary,
      amount: input.quantity,
      unit: input.unit,
      payload: input.payload ?? {},
    })
    db.prepare('UPDATE inventory_events SET evidence_item_id = ? WHERE id = ?').run(evidenceId, eventId)
    return eventId
  })
