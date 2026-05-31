import { createHash } from 'node:crypto'
import { createDecision, markDecisionApplied } from '../brain/decisions.js'
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
  parentMenuItemName?: string
  selectionRole?: string
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

const fieldValue = (row: Record<string, unknown>, ...keys: string[]): string => value(...keys.map((key) => row[key]))

const fieldNumber = (row: Record<string, unknown>, keys: string[], fallback = 0): number => {
  for (const key of keys) {
    const candidate = row[key]
    if (candidate !== null && candidate !== undefined && candidate !== '') return toNumber(candidate, fallback)
  }
  return fallback
}

const hasSourceDocument = (db: Db, sourceId: number, externalId: string, documentType: string): boolean =>
  Boolean(
    db
      .prepare('SELECT id FROM source_documents WHERE source_id = ? AND external_id = ? AND document_type = ? LIMIT 1')
      .get(sourceId, externalId, documentType),
  )

export const ingestInvoices = (db: Db, input: string | InvoiceRow[], sourceName = 'Invoices'): IngestResult => {
  const rows = parseJsonOrCsv<InvoiceRow>(input)
  const sourceId = ensureSource(db, sourceName, 'invoice')
  const runId = beginIngestRun(db, sourceId)
  let imported = 0
  let errors = 0

  try {
    withTransaction(db, () => {
      rows.forEach((row, index) => {
        const sourceRow = row as Record<string, unknown>
        const vendorName = fieldValue(sourceRow, 'vendor', 'vendorName', 'vendorname', 'vendor_name')
        const skuName = fieldValue(sourceRow, 'sku', 'skuName', 'skuname', 'sku_name')
        const quantity = fieldNumber(sourceRow, ['quantity'])
        const unit = fieldValue(sourceRow, 'unit') || 'unit'
        const occurredAt = fieldValue(sourceRow, 'invoiceDate', 'invoicedate', 'invoice_date') || new Date().toISOString()
        if (!vendorName || !skuName || quantity <= 0) {
          errors += 1
          return
        }

        const totalCost = fieldNumber(sourceRow, ['totalCost', 'totalcost', 'total_cost'])
        const unitCost = fieldNumber(sourceRow, ['unitCost', 'unitcost', 'unit_cost'], totalCost > 0 ? totalCost / quantity : 0)
        const externalId = fieldValue(sourceRow, 'invoiceNumber', 'invoicenumber', 'invoice_number') || `${sourceName}-${index + 1}-${digest(row).slice(0, 10)}`
        if (hasSourceDocument(db, sourceId, externalId, 'invoice')) return

        const vendorId = ensureVendor(db, vendorName)
        const skuId = ensureSku(db, { name: skuName, unit, category: value(row.category) || null })
        const vendorItemId = ensureVendorItem(db, {
          vendorId,
          skuId,
          packSize: quantity,
          packUnit: unit,
          price: unitCost > 0 ? unitCost * quantity : null,
        })

        const documentId = createSourceDocument(db, {
          sourceId,
          externalId,
          documentType: 'invoice',
          documentDate: occurredAt,
          rawText: rowText(row),
          rawJson: row,
          contentHash: digest(row),
        })
        if (unitCost > 0) {
          db.prepare(
            `INSERT OR IGNORE INTO vendor_item_prices
             (vendor_item_id, vendor_id, sku_id, observed_at, pack_size, pack_unit, price, unit_cost, source_document_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(vendorItemId, vendorId, skuId, occurredAt, quantity, unit, unitCost * quantity, unitCost, documentId)
        }
        const decisionId = createDecision(db, {
          title: `Apply invoice line ${externalId}: ${skuName}`,
          payload: {
            kind: 'invoice_purchase',
            eventType: 'purchase',
            skuName,
            vendorName,
            quantity,
            unit,
            occurredAt,
            sourceDocumentId: documentId,
          },
          confidence: 0.94,
          riskLevel: 'low',
          state: 'auto_applied',
          evidence: [{ kind: 'invoice', sourceDocumentId: documentId, externalId }],
        })
        const eventId = createInventoryEvent(db, {
          skuId,
          eventType: 'purchase',
          quantity,
          unit,
          unitCost: unitCost || null,
          sourceDocumentId: documentId,
          decisionId,
          occurredAt,
          note: `Invoice ${externalId} from ${vendorName}`,
        })
        const evidenceId = createEvidenceItem(db, {
          sourceDocumentId: documentId,
          evidenceType: 'invoice_line',
          entityType: 'inventory_event',
          entityId: eventId,
          inventoryEventId: eventId,
          decisionId,
          occurredAt,
          summary: `${vendorName} invoice added ${quantity} ${unit} ${skuName}`,
          amount: quantity,
          unit,
          payload: row,
        })
        db.prepare('UPDATE inventory_events SET evidence_item_id = ? WHERE id = ?').run(evidenceId, eventId)
        markDecisionApplied(db, decisionId, eventId)
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
        const sourceRow = row as Record<string, unknown>
        const skuName = fieldValue(sourceRow, 'sku', 'skuName', 'skuname', 'sku_name')
        const quantity = fieldNumber(sourceRow, ['quantity'])
        const countedQuantity = fieldNumber(sourceRow, ['countedQuantity', 'countedquantity', 'counted_quantity'], quantity)
        const unit = fieldValue(sourceRow, 'unit') || 'unit'
        const occurredAt = fieldValue(sourceRow, 'countedAt', 'countedat', 'counted_at', 'occurredAt', 'occurredat', 'occurred_at') || new Date().toISOString()
        if (!skuName) {
          errors += 1
          return
        }

        const skuId = ensureSku(db, { name: skuName, unit })
        const before = getOnHand(db, skuId, occurredAt)
        const delta = countedQuantity - before
        const externalId = fieldValue(sourceRow, 'countId', 'countid', 'count_id') || `${sourceName}-${index + 1}-${digest(row).slice(0, 10)}`
        if (hasSourceDocument(db, sourceId, externalId, 'count')) return

        const documentId = createSourceDocument(db, {
          sourceId,
          externalId,
          documentType: 'count',
          documentDate: occurredAt,
          rawText: rowText(row),
          rawJson: row,
          contentHash: digest(row),
        })
        const decisionId = createDecision(db, {
          title: `Apply inventory count ${externalId}: ${skuName}`,
          payload: {
            kind: 'inventory_count_adjustment',
            eventType: 'adjustment',
            skuName,
            quantity: delta,
            countedQuantity,
            before,
            unit,
            occurredAt,
            sourceDocumentId: documentId,
          },
          confidence: 0.9,
          riskLevel: Math.abs(delta) > Math.max(100, Math.abs(before) * 0.5) ? 'medium' : 'low',
          state: 'auto_applied',
          evidence: [{ kind: 'count', sourceDocumentId: documentId, externalId }],
        })
        const eventId = createInventoryEvent(db, {
          skuId,
          eventType: 'adjustment',
          quantity: delta,
          unit,
          sourceDocumentId: documentId,
          decisionId,
          occurredAt,
          note: `Count adjusted ${skuName} from ${before} to ${countedQuantity}`,
        })
        const evidenceId = createEvidenceItem(db, {
          sourceDocumentId: documentId,
          evidenceType: 'inventory_count',
          entityType: 'inventory_event',
          entityId: eventId,
          inventoryEventId: eventId,
          decisionId,
          occurredAt,
          summary: `Counted ${countedQuantity} ${unit} ${skuName}`,
          amount: countedQuantity,
          unit,
          payload: { ...row, before, delta },
        })
        db.prepare('UPDATE inventory_events SET evidence_item_id = ? WHERE id = ?').run(evidenceId, eventId)
        markDecisionApplied(db, decisionId, eventId)
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
        const sourceRow = row as Record<string, unknown>
        const menuItemName = fieldValue(sourceRow, 'menuItem', 'menuitem', 'menu_item', 'menuItemName', 'menuitemname', 'menu_item_name')
        const quantity = fieldNumber(sourceRow, ['quantity'])
        const quantitySold = fieldNumber(sourceRow, ['quantitySold', 'quantitysold', 'quantity_sold'], quantity)
        const occurredAt = fieldValue(sourceRow, 'occurredAt', 'occurredat', 'occurred_at', 'businessDate', 'businessdate', 'business_date') || new Date().toISOString()
        if (!menuItemName || quantitySold <= 0) {
          errors += 1
          return
        }

        const externalId = fieldValue(sourceRow, 'externalId', 'externalid', 'external_id') || `${sourceName}-${index + 1}-${digest(row).slice(0, 10)}`
        if (hasSourceDocument(db, sourceId, externalId, 'toast_sale')) return

        const documentId = createSourceDocument(db, {
          sourceId,
          externalId,
          documentType: 'toast_sale',
          documentDate: occurredAt,
          rawText: rowText(row),
          rawJson: row,
          contentHash: digest(row),
        })
        const menuItemId = ensureMenuItem(db, menuItemName, externalId)
        const recipes = db.prepare('SELECT sku_id, quantity, unit, yield_quantity FROM recipes WHERE menu_item_id = ? AND active = 1').all(menuItemId)
        if (recipes.length === 0) {
          const decisionId = createDecision(db, {
            title: `Map Toast item recipe: ${menuItemName}`,
            payload: {
              kind: 'missing_recipe',
              menuItemId,
              menuItemName,
              quantitySold,
              occurredAt,
              sourceDocumentId: documentId,
            },
            confidence: 0.62,
            riskLevel: 'medium',
            state: 'needs_review',
            evidence: [{ kind: 'toast', sourceDocumentId: documentId, externalId }],
          })
          createEvidenceItem(db, {
            sourceDocumentId: documentId,
            evidenceType: 'toast_missing_recipe',
            entityType: 'menu_item',
            entityId: menuItemId,
            decisionId,
            occurredAt,
            summary: `${menuItemName} sold ${quantitySold} time(s), but no recipe is mapped`,
            amount: quantitySold,
            unit: 'sale',
            confidence: 0.62,
            payload: row,
          })
          errors += 1
          return
        }

        recipes.forEach((recipe) => {
          const consumed = (toNumber(recipe.quantity) / Math.max(1, toNumber(recipe.yield_quantity, 1))) * quantitySold
          const unit = value(recipe.unit) || 'unit'
          const sku = db.prepare('SELECT name FROM skus WHERE id = ?').get(toNumber(recipe.sku_id))
          const skuName = value(sku?.name) || `SKU ${toNumber(recipe.sku_id)}`
          const decisionId = createDecision(db, {
            title: `Apply Toast sale ${externalId}: ${menuItemName}`,
            payload: {
              kind: 'toast_sale_consumption',
              eventType: 'sale',
              menuItemName,
              skuName,
              quantity: -consumed,
              consumed,
              unit,
              occurredAt,
              sourceDocumentId: documentId,
            },
            confidence: 0.88,
            riskLevel: 'low',
            state: 'auto_applied',
            evidence: [{ kind: 'toast', sourceDocumentId: documentId, externalId }],
          })
          const eventId = createInventoryEvent(db, {
            skuId: toNumber(recipe.sku_id),
            eventType: 'sale',
            quantity: -consumed,
            unit,
            sourceDocumentId: documentId,
            decisionId,
            occurredAt,
            note: `Toast sale ${menuItemName} x ${quantitySold}`,
          })
          const evidenceId = createEvidenceItem(db, {
            sourceDocumentId: documentId,
            evidenceType: 'toast_sale',
            entityType: 'inventory_event',
            entityId: eventId,
            inventoryEventId: eventId,
            decisionId,
            occurredAt,
            summary: `${menuItemName} consumed ${consumed} ${unit}`,
            amount: consumed,
            unit,
            payload: row,
          })
          db.prepare('UPDATE inventory_events SET evidence_item_id = ? WHERE id = ?').run(evidenceId, eventId)
          markDecisionApplied(db, decisionId, eventId)
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
