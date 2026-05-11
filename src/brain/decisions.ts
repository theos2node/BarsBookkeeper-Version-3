import type { InventoryEventType } from '../domain/types.js'
import {
  createEvidenceItem,
  createInventoryEvent,
  ensureSku,
  ensureVendor,
  type InventoryEventInput,
} from '../db/repositories.js'
import { lastInsertId, nowIso, stringifyJson, toNumber, toStringValue, withTransaction, type Db } from '../db/database.js'

export type OpenClawDecisionInput = {
  title: string
  payload: {
    eventType: InventoryEventType
    skuName: string
    vendorName?: string | null
    quantity: number
    unit: string
    occurredAt?: string | null
    reason?: string | null
  }
  confidence: number
  riskLevel?: 'low' | 'medium' | 'high' | 'critical'
  evidence?: unknown[]
}

export type OpenClawGenericDecisionInput = {
  title: string
  payload: Record<string, unknown>
  confidence: number
  riskLevel?: 'low' | 'medium' | 'high' | 'critical'
  state?: 'proposed' | 'auto_applied' | 'needs_review' | 'suppressed'
  evidence?: unknown[]
  policy?: Record<string, unknown>
}

const decisionState = (confidence: number, riskLevel: string) => {
  if (riskLevel === 'high' || riskLevel === 'critical') return 'needs_review'
  if (confidence >= 0.85) return 'auto_applied'
  if (confidence >= 0.65 && riskLevel === 'low') return 'auto_applied'
  return 'needs_review'
}

export const createDecision = (db: Db, input: OpenClawGenericDecisionInput): number => {
  const riskLevel = input.riskLevel ?? 'low'
  const state = input.state ?? decisionState(input.confidence, riskLevel)
  const result = db
    .prepare(
      `INSERT INTO openclaw_decisions
       (state, risk_level, title, payload_json, policy_json, confidence, evidence_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      state,
      riskLevel,
      input.title,
      stringifyJson(input.payload),
      stringifyJson(input.policy ?? { thresholds: { autoApply: 0.85, review: 0.65 } }),
      input.confidence,
      stringifyJson(input.evidence ?? []),
    )
  const decisionId = lastInsertId(result.lastInsertRowid)
  db.prepare(
    `INSERT INTO audit_log (actor, action, entity_type, entity_id, after_json)
     VALUES (?, ?, ?, ?, ?)`,
  ).run('openclaw', 'propose_decision', 'openclaw_decisions', decisionId, stringifyJson(input))
  return decisionId
}

export const markDecisionApplied = (db: Db, decisionId: number, eventId: number): void => {
  db.prepare(
    `UPDATE openclaw_decisions
     SET state = 'auto_applied', applied_inventory_event_id = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  ).run(eventId, decisionId)
  db.prepare(
    `INSERT INTO audit_log (actor, action, entity_type, entity_id, after_json)
     VALUES (?, ?, ?, ?, ?)`,
  ).run('openclaw', 'apply_decision', 'openclaw_decisions', decisionId, stringifyJson({ decisionId, eventId }))
}

export const applyDecision = (db: Db, input: OpenClawDecisionInput): number => {
  return withTransaction(db, () => {
    const riskLevel = input.riskLevel ?? 'low'
    const state = decisionState(input.confidence, riskLevel)
    const decisionId = createDecision(db, {
      ...input,
      payload: input.payload,
      riskLevel,
      state,
    })

    if (state !== 'auto_applied') {
      return decisionId
    }

    if (input.payload.vendorName) ensureVendor(db, input.payload.vendorName)
    const skuId = ensureSku(db, { name: input.payload.skuName, unit: input.payload.unit })
    const eventInput: InventoryEventInput = {
      skuId,
      eventType: input.payload.eventType,
      quantity: input.payload.quantity,
      unit: input.payload.unit,
      decisionId,
      occurredAt: input.payload.occurredAt ?? nowIso(),
      note: input.payload.reason ?? input.title,
    }
    const eventId = createInventoryEvent(db, eventInput)
    const evidenceId = createEvidenceItem(db, {
      evidenceType: 'openclaw_decision',
      entityType: 'inventory_event',
      entityId: eventId,
      inventoryEventId: eventId,
      decisionId,
      occurredAt: eventInput.occurredAt,
      summary: input.title,
      amount: input.payload.quantity,
      unit: input.payload.unit,
      confidence: input.confidence,
      payload: input,
    })
    db.prepare('UPDATE inventory_events SET evidence_item_id = ? WHERE id = ?').run(evidenceId, eventId)
    markDecisionApplied(db, decisionId, eventId)
    return eventId
  })
}

export const reverseDecision = (db: Db, decisionId: number): number => {
  return withTransaction(db, () => {
    const decision = db.prepare('SELECT * FROM openclaw_decisions WHERE id = ?').get(decisionId)
    if (!decision) throw new Error(`decision_not_found:${decisionId}`)
    const eventId = toNumber(decision.applied_inventory_event_id)
    if (!eventId) throw new Error(`decision_not_applied:${decisionId}`)
    const event = db.prepare('SELECT * FROM inventory_events WHERE id = ?').get(eventId)
    if (!event) throw new Error(`decision_event_not_found:${decisionId}`)

    const reversal = createInventoryEvent(db, {
      skuId: toNumber(event.sku_id),
      eventType: 'correction',
      quantity: -toNumber(event.quantity),
      unit: toStringValue(event.unit, 'unit'),
      decisionId,
      occurredAt: toStringValue(event.occurred_at, nowIso()),
      note: `Reverse decision ${decisionId}`,
      reversedEventId: eventId,
    })
    db.prepare(
      `UPDATE openclaw_decisions
       SET state = 'reversed', reversed_at = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    ).run(nowIso(), decisionId)
    db.prepare(
      `INSERT INTO audit_log (actor, action, entity_type, entity_id, before_json, after_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('user', 'reverse_decision', 'openclaw_decisions', decisionId, stringifyJson(decision), stringifyJson({ reversal }))
    return reversal
  })
}

export const getReviewQueue = (db: Db) =>
  db
    .prepare(
      `SELECT id, title, risk_level, confidence, payload_json, evidence_json, created_at
       FROM openclaw_decisions
       WHERE state = 'needs_review'
       ORDER BY risk_level DESC, created_at DESC`,
    )
    .all()

export const runBrain = () => ({
  message: 'OpenClaw decision brain is active. Ingest services create evidence-backed events; explicit decisions can be applied and reversed.',
})
