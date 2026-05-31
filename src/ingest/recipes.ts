import { createDecision, dismissDecision, markDecisionApplied } from '../brain/decisions.js'
import { createEvidenceItem, createInventoryEvent, ensureMenuItem, ensureSku, upsertRecipeItem } from '../db/repositories.js'
import { parseJson, stringifyJson, toNumber, toStringValue, withTransaction, type Db } from '../db/database.js'

export type ToastRecipeMapInput = {
  menuItemName: string
  skuName: string
  quantity: number
  unit: string
  yieldQuantity?: number
  category?: string | null
}

export type ToastRecipeMapResult = {
  menuItemName: string
  skuName: string
  quantity: number
  unit: string
  yieldQuantity: number
  recipeId: number
  backfilledEvents: number
  skippedExistingEvents: number
  suppressedReviews: number
}

export const mapToastRecipeAndBackfill = (db: Db, input: ToastRecipeMapInput): ToastRecipeMapResult =>
  withTransaction(db, () => {
    const menuItemName = input.menuItemName.trim()
    const skuName = input.skuName.trim()
    const unit = input.unit.trim() || 'unit'
    const quantity = input.quantity
    const yieldQuantity = input.yieldQuantity && input.yieldQuantity > 0 ? input.yieldQuantity : 1

    if (!menuItemName) throw new Error('menu_item_name_required')
    if (!skuName) throw new Error('sku_name_required')
    if (!Number.isFinite(quantity) || quantity <= 0) throw new Error('recipe_quantity_must_be_positive')

    const menuItemId = ensureMenuItem(db, menuItemName, null, input.category ?? null)
    const skuId = ensureSku(db, { name: skuName, unit })
    const recipeId = upsertRecipeItem(db, { menuItemId, skuId, quantity, unit, yieldQuantity })
    let backfilledEvents = 0
    let skippedExistingEvents = 0

    const toastDocs = db
      .prepare(
        `SELECT sd.id, sd.external_id, sd.document_date, sd.raw_json
         FROM source_documents sd
         JOIN sources s ON s.id = sd.source_id
         WHERE s.kind = 'toast'
           AND sd.document_type = 'toast_sale'
         ORDER BY sd.document_date, sd.id`,
      )
      .all()

    for (const doc of toastDocs as any[]) {
      const payload = parseJson<Record<string, unknown>>(doc.raw_json, {})
      const docMenuItem = menuItemFromPayload(payload)
      if (docMenuItem !== menuItemName) continue

      const existing = db
        .prepare(
          `SELECT id
           FROM inventory_events
           WHERE source_document_id = ?
             AND sku_id = ?
             AND event_type = 'sale'
           LIMIT 1`,
        )
        .get(toNumber(doc.id), skuId)
      if (existing) {
        skippedExistingEvents += 1
        continue
      }

      const quantitySold = toNumber(payload.quantitySold, toNumber(payload.quantity))
      if (quantitySold <= 0) continue
      const consumed = (quantity / yieldQuantity) * quantitySold
      const occurredAt = toStringValue(payload.occurredAt, toStringValue(payload.businessDate, toStringValue(doc.document_date)))
      const externalId = toStringValue(payload.externalId, toStringValue(doc.external_id, `toast-doc-${doc.id}`))
      const decisionId = createDecision(db, {
        title: `Backfill Toast recipe ${externalId}: ${menuItemName}`,
        payload: {
          kind: 'toast_recipe_backfill',
          eventType: 'sale',
          menuItemName,
          skuName,
          quantity: -consumed,
          consumed,
          unit,
          occurredAt,
          sourceDocumentId: toNumber(doc.id),
          recipeId,
        },
        confidence: 0.92,
        riskLevel: 'low',
        state: 'auto_applied',
        evidence: [{ kind: 'toast_recipe_map', sourceDocumentId: toNumber(doc.id), externalId }],
      })
      const eventId = createInventoryEvent(db, {
        skuId,
        eventType: 'sale',
        quantity: -consumed,
        unit,
        sourceDocumentId: toNumber(doc.id),
        decisionId,
        occurredAt,
        note: `Toast recipe map backfill ${menuItemName} x ${quantitySold}`,
      })
      const evidenceId = createEvidenceItem(db, {
        sourceDocumentId: toNumber(doc.id),
        evidenceType: 'toast_sale',
        entityType: 'inventory_event',
        entityId: eventId,
        inventoryEventId: eventId,
        decisionId,
        occurredAt,
        summary: `${menuItemName} consumed ${consumed} ${unit}`,
        amount: consumed,
        unit,
        payload: { ...payload, recipeBackfill: true, recipeId },
      })
      db.prepare('UPDATE inventory_events SET evidence_item_id = ? WHERE id = ?').run(evidenceId, eventId)
      markDecisionApplied(db, decisionId, eventId)
      backfilledEvents += 1
    }

    let suppressedReviews = 0
    const reviews = db
      .prepare(
        `SELECT DISTINCT d.id, e.payload_json
         FROM evidence_items e
         JOIN openclaw_decisions d ON d.id = e.decision_id
         WHERE e.evidence_type = 'toast_missing_recipe'
           AND d.state = 'needs_review'`,
      )
      .all()
    for (const review of reviews as any[]) {
      const payload = parseJson<Record<string, unknown>>(review.payload_json, {})
      if (menuItemFromPayload(payload) !== menuItemName) continue
      dismissDecision(db, toNumber(review.id), `Resolved by recipe map: ${menuItemName} -> ${skuName}`)
      suppressedReviews += 1
    }

    db.prepare(
      `INSERT INTO audit_log (actor, action, entity_type, entity_id, after_json)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      'user',
      'map_toast_recipe',
      'menu_items',
      menuItemId,
      stringifyJson({
        menuItemName,
        skuName,
        quantity,
        unit,
        yieldQuantity,
        recipeId,
        backfilledEvents,
        suppressedReviews,
      }),
    )

    return {
      menuItemName,
      skuName,
      quantity,
      unit,
      yieldQuantity,
      recipeId,
      backfilledEvents,
      skippedExistingEvents,
      suppressedReviews,
    }
  })

const menuItemFromPayload = (payload: Record<string, unknown>): string =>
  toStringValue(payload.menuItem, toStringValue(payload.menuItemName, toStringValue(payload.displayName, toStringValue(payload.name)))).trim()
