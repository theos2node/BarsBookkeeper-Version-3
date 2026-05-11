import { createHash } from 'node:crypto'
import { toNumber, withTransaction, type Db } from '../db/database.js'
import {
  beginIngestRun,
  createEvidenceItem,
  createInventoryEvent,
  createSourceDocument,
  ensureMenuItem,
  ensureSku,
  ensureSource,
  ensureVendor,
  ensureVendorItem,
  finishIngestRun,
  getOnHand,
} from '../db/repositories.js'
import { parseJsonOrCsv } from './csv.js'

export type IngestResult = {
  runId: number
  sourceId: number
  recordsSeen: number
  recordsImported: number
  errors: number
}

export type InvoiceRow = {
  vendor?: string
  vendorName?: string
  invoiceNumber?: string
  invoiceDate?: string
  sku?: string
  skuName?: string
  quantity?: string | number
  unit?: string
  unitCost?: string | number
  totalCost?: string | number
  category?: string
}

export type CountRow = {
  countId?: string
  countedAt?: string
  occurredAt?: string
  sku?: string
  skuName?: string
  countedQuantity?: string | number
  quantity?: string | number
  unit?: string
}

export type ToastSalesRow = {
  externalId?: string
  businessDate?: string
  occurredAt?: string
  menuItem?: string
  menuItemName?: string
  quantitySold?: string | number
  quantity?: string | number
}

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')

const rowText = (row: unknown): string => JSON.stringify(row)

const value = (...candidates: unknown[]): string => {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return String(candidate)
  }
  return ''
}

export const ingestInvoices = (db: Db, input: string | InvoiceRow[], sourceName = 'Invoices'): IngestResult => {
  const rows = parseJsonOrCsv<InvoiceRow>(input)
  const sourceId = ensureSource(db, sourceName, 'invoice')
  const runId = beginIngestRun(db, sourceId)
  let imported = 0
  let errors = 0

  try {
    withTransaction(db, () => {
      rows.forEach((row, index) => {
        const vendorName = value(row.vendor, row.vendorName)
        const skuName = value(row.sku, row.skuName)
        const quantity = toNumber(row.quantity)
        const unit = value(row.unit) || 'unit'
        const occurredAt = value(row.invoiceDate) || new Date().toISOString()
        if (!vendorName || !skuName || quantity <= 0) {
          errors += 1
          return
        }

        const unitCost = toNumber(row.unitCost, row.totalCost ? toNumber(row.totalCost) / quantity : 0)
        const vendorId = ensureVendor(db, vendorName)
        const skuId = ensureSku(db, { name: skuName, unit, category: value(row.category) || null })
        ensureVendorItem(db, {
          vendorId,
          skuId,
          packSize: quantity,
          packUnit: unit,
          price: unitCost > 0 ? unitCost * quantity : null,
        })

        const externalId = value(row.invoiceNumber) || `${sourceName}-${index + 1}-${digest(row).slice(0, 10)}`
        const documentId = createSourceDocument(db, {
          sourceId,
          externalId,
          documentType: 'invoice',
          documentDate: occurredAt,
          rawText: rowText(row),
          rawJson: row,
          contentHash: digest(row),
        })
        const eventId = createInventoryEvent(db, {
          skuId,
          eventType: 'purchase',
          quantity,
          unit,
          unitCost: unitCost || null,
          sourceDocumentId: documentId,
          occurredAt,
          note: `Invoice ${externalId} from ${vendorName}`,
        })
        const evidenceId = createEvidenceItem(db, {
          sourceDocumentId: documentId,
          evidenceType: 'invoice_line',
          entityType: 'inventory_event',
          entityId: eventId,
          inventoryEventId: eventId,
          occurredAt,
          summary: `${vendorName} invoice added ${quantity} ${unit} ${skuName}`,
          amount: quantity,
          unit,
          payload: row,
        })
        db.prepare('UPDATE inventory_events SET evidence_item_id = ? WHERE id = ?').run(evidenceId, eventId)
        imported += 1
      })
    })
    finishIngestRun(db, runId, 'completed', rows.length, imported, errors)
  } catch (error) {
    finishIngestRun(db, runId, 'failed', rows.length, imported, errors + 1, error instanceof Error ? error.message : String(error))
    throw error
  }

  return { runId, sourceId, recordsSeen: rows.length, recordsImported: imported, errors }
}

export const ingestCounts = (db: Db, input: string | CountRow[], sourceName = 'Inventory counts'): IngestResult => {
  const rows = parseJsonOrCsv<CountRow>(input)
  const sourceId = ensureSource(db, sourceName, 'count')
  const runId = beginIngestRun(db, sourceId)
  let imported = 0
  let errors = 0

  try {
    withTransaction(db, () => {
      rows.forEach((row, index) => {
        const skuName = value(row.sku, row.skuName)
        const countedQuantity = toNumber(row.countedQuantity, toNumber(row.quantity))
        const unit = value(row.unit) || 'unit'
        const occurredAt = value(row.countedAt, row.occurredAt) || new Date().toISOString()
        if (!skuName) {
          errors += 1
          return
        }

        const skuId = ensureSku(db, { name: skuName, unit })
        const before = getOnHand(db, skuId, occurredAt)
        const delta = countedQuantity - before
        const externalId = value(row.countId) || `${sourceName}-${index + 1}-${digest(row).slice(0, 10)}`
        const documentId = createSourceDocument(db, {
          sourceId,
          externalId,
          documentType: 'count',
          documentDate: occurredAt,
          rawText: rowText(row),
          rawJson: row,
          contentHash: digest(row),
        })
        const eventId = createInventoryEvent(db, {
          skuId,
          eventType: 'adjustment',
          quantity: delta,
          unit,
          sourceDocumentId: documentId,
          occurredAt,
          note: `Count adjusted ${skuName} from ${before} to ${countedQuantity}`,
        })
        const evidenceId = createEvidenceItem(db, {
          sourceDocumentId: documentId,
          evidenceType: 'inventory_count',
          entityType: 'inventory_event',
          entityId: eventId,
          inventoryEventId: eventId,
          occurredAt,
          summary: `Counted ${countedQuantity} ${unit} ${skuName}`,
          amount: countedQuantity,
          unit,
          payload: { ...row, before, delta },
        })
        db.prepare('UPDATE inventory_events SET evidence_item_id = ? WHERE id = ?').run(evidenceId, eventId)
        imported += 1
      })
    })
    finishIngestRun(db, runId, 'completed', rows.length, imported, errors)
  } catch (error) {
    finishIngestRun(db, runId, 'failed', rows.length, imported, errors + 1, error instanceof Error ? error.message : String(error))
    throw error
  }

  return { runId, sourceId, recordsSeen: rows.length, recordsImported: imported, errors }
}

export const ingestToastSales = (db: Db, input: string | ToastSalesRow[], sourceName = 'Toast sales'): IngestResult => {
  const rows = parseJsonOrCsv<ToastSalesRow>(input)
  const sourceId = ensureSource(db, sourceName, 'toast')
  const runId = beginIngestRun(db, sourceId)
  let imported = 0
  let errors = 0

  try {
    withTransaction(db, () => {
      rows.forEach((row, index) => {
        const menuItemName = value(row.menuItem, row.menuItemName)
        const quantitySold = toNumber(row.quantitySold, toNumber(row.quantity))
        const occurredAt = value(row.occurredAt, row.businessDate) || new Date().toISOString()
        if (!menuItemName || quantitySold <= 0) {
          errors += 1
          return
        }

        const menuItemId = ensureMenuItem(db, menuItemName, row.externalId ?? null)
        const recipes = db.prepare('SELECT sku_id, quantity, unit, yield_quantity FROM recipes WHERE menu_item_id = ? AND active = 1').all(menuItemId)
        if (recipes.length === 0) {
          errors += 1
          return
        }

        const externalId = value(row.externalId) || `${sourceName}-${index + 1}-${digest(row).slice(0, 10)}`
        const documentId = createSourceDocument(db, {
          sourceId,
          externalId,
          documentType: 'toast_sale',
          documentDate: occurredAt,
          rawText: rowText(row),
          rawJson: row,
          contentHash: digest(row),
        })

        recipes.forEach((recipe) => {
          const consumed = (toNumber(recipe.quantity) / Math.max(1, toNumber(recipe.yield_quantity, 1))) * quantitySold
          const unit = value(recipe.unit) || 'unit'
          const eventId = createInventoryEvent(db, {
            skuId: toNumber(recipe.sku_id),
            eventType: 'sale',
            quantity: -consumed,
            unit,
            sourceDocumentId: documentId,
            occurredAt,
            note: `Toast sale ${menuItemName} x ${quantitySold}`,
          })
          const evidenceId = createEvidenceItem(db, {
            sourceDocumentId: documentId,
            evidenceType: 'toast_sale',
            entityType: 'inventory_event',
            entityId: eventId,
            inventoryEventId: eventId,
            occurredAt,
            summary: `${menuItemName} consumed ${consumed} ${unit}`,
            amount: consumed,
            unit,
            payload: row,
          })
          db.prepare('UPDATE inventory_events SET evidence_item_id = ? WHERE id = ?').run(evidenceId, eventId)
        })
        imported += 1
      })
    })
    finishIngestRun(db, runId, 'completed', rows.length, imported, errors)
  } catch (error) {
    finishIngestRun(db, runId, 'failed', rows.length, imported, errors + 1, error instanceof Error ? error.message : String(error))
    throw error
  }

  return { runId, sourceId, recordsSeen: rows.length, recordsImported: imported, errors }
}
