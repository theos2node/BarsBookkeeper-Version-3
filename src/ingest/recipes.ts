import { createDecision, dismissDecision, markDecisionApplied } from '../brain/decisions.js'
import { createEvidenceItem, createInventoryEvent, ensureMenuItem, ensureSku, upsertRecipeItem } from '../db/repositories.js'
import { parseJson, stringifyJson, toNumber, toStringValue, withImmediateTransaction, type Db } from '../db/database.js'

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

export type ToastRecipeSuggestion = {
  menuItemName: string
  occurrences: number
  sales: number
  latest: string
  suggestedSkuName: string
  suggestedQuantity: number
  suggestedUnit: string
  confidence: number
  reason: string
  command: string
}

export const mapToastRecipeAndBackfill = (db: Db, input: ToastRecipeMapInput): ToastRecipeMapResult =>
  withImmediateTransaction(db, () => {
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

export const suggestToastRecipeMappings = (db: Db, limit = 12): ToastRecipeSuggestion[] => {
  const missing = groupedMissingRecipeRows(db, Math.max(limit * 4, limit))
  if (missing.length === 0) return []

  const skus = db
    .prepare('SELECT id, name, unit, category FROM skus ORDER BY name')
    .all()
    .map((row: any) => ({
      id: toNumber(row.id),
      name: toStringValue(row.name),
      unit: toStringValue(row.unit, 'unit'),
      category: row.category === null ? '' : toStringValue(row.category),
      tokens: tokensFor(toStringValue(row.name)),
    }))

  const mappedRecipes = db
    .prepare(
      `SELECT mi.name AS menu_item,
              sku.name AS sku,
              r.quantity,
              r.unit
       FROM recipes r
       JOIN menu_items mi ON mi.id = r.menu_item_id
       JOIN skus sku ON sku.id = r.sku_id
       WHERE r.active = 1`,
    )
    .all()
    .map((row: any) => ({
      menuItem: toStringValue(row.menu_item),
      sku: toStringValue(row.sku),
      quantity: toNumber(row.quantity),
      unit: toStringValue(row.unit, 'unit'),
      tokens: tokensFor(toStringValue(row.menu_item)),
    }))

  const suggestions: ToastRecipeSuggestion[] = []
  for (const row of missing) {
    const menuTokens = tokensFor(row.menuItem)
    const candidates = new Map<string, ToastRecipeSuggestion>()

    for (const sku of skus) {
      const lexical = lexicalSuggestion(row, menuTokens, sku)
      if (lexical) candidates.set(sku.name, lexical)
    }

    for (const mapped of mappedRecipes) {
      const overlap = jaccard(menuTokens, mapped.tokens)
      if (overlap < 0.34) continue
      const sku = skus.find((candidate) => candidate.name === mapped.sku)
      if (!sku) continue
      const confidence = round(Math.min(0.88, 0.68 + overlap * 0.24), 2)
      const suggestion = suggestionRow(row, sku.name, mapped.quantity, mapped.unit, confidence, `similar to mapped recipe "${mapped.menuItem}"`)
      const existing = candidates.get(sku.name)
      if (!existing || existing.confidence < suggestion.confidence) candidates.set(sku.name, suggestion)
    }

    suggestions.push(
      ...Array.from(candidates.values())
        .filter((candidate) => candidate.confidence >= 0.68)
        .sort((left, right) => right.confidence - left.confidence)
        .slice(0, 3),
    )
  }

  return suggestions
    .sort((left, right) => right.occurrences - left.occurrences || right.confidence - left.confidence || right.sales - left.sales)
    .slice(0, limit)
}

type MissingRecipeGroup = {
  menuItem: string
  sales: number
  occurrences: number
  latest: string
}

type SkuCandidate = {
  name: string
  unit: string
  category: string
  tokens: Set<string>
}

const groupedMissingRecipeRows = (db: Db, limit: number): MissingRecipeGroup[] => {
  const rows = db
    .prepare(
      `SELECT e.summary, e.payload_json, e.amount, e.occurred_at
       FROM evidence_items e
       JOIN openclaw_decisions d ON d.id = e.decision_id
       WHERE e.evidence_type = 'toast_missing_recipe'
         AND d.state = 'needs_review'
       ORDER BY e.occurred_at DESC, e.id DESC
       LIMIT ?`,
    )
    .all(limit)
  const grouped = new Map<string, MissingRecipeGroup>()

  for (const row of rows as any[]) {
    const payload = parseJson<Record<string, unknown>>(row.payload_json, {})
    const menuItem = menuItemFromPayload(payload) || String(row.summary)
    const existing = grouped.get(menuItem) ?? {
      menuItem,
      sales: 0,
      occurrences: 0,
      latest: '',
    }
    existing.sales += toNumber(row.amount)
    existing.occurrences += 1
    existing.latest = existing.latest && existing.latest > String(row.occurred_at) ? existing.latest : String(row.occurred_at)
    grouped.set(menuItem, existing)
  }

  return Array.from(grouped.values()).sort((left, right) => right.occurrences - left.occurrences || right.sales - left.sales)
}

const stopWords = new Set(['a', 'an', 'and', 'bar', 'bbq', 'classic', 'draft', 'fresh', 'house', 'large', 'oz', 'premium', 'small', 'test', 'the'])

const tokensFor = (value: string): Set<string> =>
  new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length > 1 && !stopWords.has(token) && !/^\d+$/.test(token)),
  )

type IngredientHint = {
  terms: string[]
  quantity: number
  unit: string
  reason: string
  confidence: number
}

const ingredientHints: Record<string, IngredientHint[]> = {
  martini: [
    { terms: ['vodka'], quantity: 75, unit: 'ml', reason: 'martini commonly maps to a vodka pour', confidence: 0.74 },
    { terms: ['gin'], quantity: 75, unit: 'ml', reason: 'martini commonly maps to a gin pour', confidence: 0.72 },
  ],
  mule: [
    { terms: ['vodka'], quantity: 50, unit: 'ml', reason: 'mule commonly maps to vodka', confidence: 0.78 },
    { terms: ['lime'], quantity: 20, unit: 'ml', reason: 'mule commonly includes lime', confidence: 0.7 },
  ],
  margarita: [
    { terms: ['tequila'], quantity: 60, unit: 'ml', reason: 'margarita commonly maps to tequila', confidence: 0.82 },
    { terms: ['triple', 'sec', 'cointreau'], quantity: 20, unit: 'ml', reason: 'margarita commonly includes orange liqueur', confidence: 0.74 },
    { terms: ['lime'], quantity: 30, unit: 'ml', reason: 'margarita commonly includes lime', confidence: 0.7 },
  ],
  daiquiri: [
    { terms: ['rum'], quantity: 60, unit: 'ml', reason: 'daiquiri commonly maps to rum', confidence: 0.78 },
    { terms: ['lime'], quantity: 25, unit: 'ml', reason: 'daiquiri commonly includes lime', confidence: 0.68 },
  ],
  mojito: [
    { terms: ['rum'], quantity: 50, unit: 'ml', reason: 'mojito commonly maps to rum', confidence: 0.78 },
    { terms: ['lime'], quantity: 25, unit: 'ml', reason: 'mojito commonly includes lime', confidence: 0.68 },
  ],
  negroni: [
    { terms: ['gin'], quantity: 30, unit: 'ml', reason: 'negroni commonly maps to gin', confidence: 0.76 },
    { terms: ['campari'], quantity: 30, unit: 'ml', reason: 'negroni commonly includes Campari', confidence: 0.76 },
    { terms: ['vermouth'], quantity: 30, unit: 'ml', reason: 'negroni commonly includes vermouth', confidence: 0.72 },
  ],
  old: [
    { terms: ['whiskey', 'bourbon', 'rye'], quantity: 60, unit: 'ml', reason: 'old fashioned commonly maps to whiskey', confidence: 0.74 },
  ],
  fashioned: [
    { terms: ['whiskey', 'bourbon', 'rye'], quantity: 60, unit: 'ml', reason: 'old fashioned commonly maps to whiskey', confidence: 0.74 },
  ],
}

const lexicalSuggestion = (row: MissingRecipeGroup, menuTokens: Set<string>, sku: SkuCandidate): ToastRecipeSuggestion | null => {
  const directMatches = Array.from(menuTokens).filter((token) => sku.tokens.has(token))
  if (directMatches.length > 0) {
    const quantity = defaultQuantityForSku(sku)
    return suggestionRow(row, sku.name, quantity, sku.unit, Math.min(0.92, 0.8 + directMatches.length * 0.04), `name match: ${directMatches.join(', ')}`)
  }

  for (const token of menuTokens) {
    for (const hint of ingredientHints[token] ?? []) {
      if (!hint.terms.some((term) => sku.tokens.has(term))) continue
      return suggestionRow(row, sku.name, hint.quantity, hint.unit || sku.unit, hint.confidence, hint.reason)
    }
  }

  return null
}

const defaultQuantityForSku = (sku: SkuCandidate): number => {
  if (sku.unit === 'each') return 1
  if (sku.tokens.has('juice')) return 30
  if (sku.category === 'liquor' || sku.tokens.has('vodka') || sku.tokens.has('gin') || sku.tokens.has('rum') || sku.tokens.has('tequila')) return 50
  return 1
}

const suggestionRow = (
  row: MissingRecipeGroup,
  suggestedSkuName: string,
  quantity: number,
  unit: string,
  confidence: number,
  reason: string,
): ToastRecipeSuggestion => {
  const suggestedQuantity = round(quantity, 3)
  const suggestedUnit = unit || 'unit'
  return {
    menuItemName: row.menuItem,
    occurrences: row.occurrences,
    sales: round(row.sales, 2),
    latest: row.latest,
    suggestedSkuName,
    suggestedQuantity,
    suggestedUnit,
    confidence: round(confidence, 2),
    reason,
    command: `bbk toast map-recipe "${row.menuItem}" "${suggestedSkuName}" ${suggestedQuantity} ${suggestedUnit}`,
  }
}

const jaccard = (left: Set<string>, right: Set<string>): number => {
  if (left.size === 0 || right.size === 0) return 0
  const intersection = Array.from(left).filter((token) => right.has(token)).length
  const union = new Set([...left, ...right]).size
  return union === 0 ? 0 : intersection / union
}

const round = (value: number, decimals = 3): number => Number(value.toFixed(decimals))
