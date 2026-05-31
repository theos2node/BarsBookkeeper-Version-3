import type { AppConfig } from '../config.js'
import { getInventoryPositions } from '../db/inventory.js'
import { parseJson, stringifyJson, toNumber, toStringValue, type Db } from '../db/database.js'
import { runCodexJson } from '../openclaw/codexProvider.js'
import { createDecision } from './decisions.js'

export type BrainRunResult = {
  createdDecisions: number
  reviewedSignals: number
  reviewItems: number
  codexUsed: boolean
  summary: string
  actions: Array<{ type: string; title: string; confidence: number }>
}

const activeStates = ['proposed', 'needs_review', 'auto_applied']

const duplicateDecisionExists = (db: Db, title: string, payload: Record<string, unknown>): boolean => {
  const existing = db
    .prepare(
      `SELECT id FROM openclaw_decisions
       WHERE title = ?
         AND state IN (${activeStates.map(() => '?').join(', ')})
         AND payload_json = ?
       LIMIT 1`,
    )
    .get(title, ...activeStates, stringifyJson(payload))
  return Boolean(existing)
}

const updateExistingInventoryRiskDecision = (
  db: Db,
  input: {
    title: string
    payload: Record<string, unknown>
    confidence: number
    riskLevel: 'low' | 'medium' | 'high' | 'critical'
    evidence?: unknown[]
  },
): boolean => {
  if (input.payload.kind !== 'inventory_risk_review') return false
  const skuId = toNumber(input.payload.skuId)
  if (!skuId) return false

  const existing = db
    .prepare(
      `SELECT id
       FROM openclaw_decisions
       WHERE state IN (${activeStates.map(() => '?').join(', ')})
         AND payload_json LIKE ?
         AND payload_json LIKE ?
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .get(...activeStates, '%"kind":"inventory_risk_review"%', `%"skuId":${skuId}%`)
  if (!existing) return false

  db.prepare(
    `UPDATE openclaw_decisions
     SET title = ?, risk_level = ?, payload_json = ?, confidence = ?, evidence_json = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  ).run(input.title, input.riskLevel, stringifyJson(input.payload), input.confidence, stringifyJson(input.evidence ?? []), toNumber(existing.id))
  return true
}

const proposeOnce = (
  db: Db,
  input: {
    title: string
    payload: Record<string, unknown>
    confidence: number
    riskLevel: 'low' | 'medium' | 'high' | 'critical'
    evidence?: unknown[]
  },
): boolean => {
  if (updateExistingInventoryRiskDecision(db, input)) return false
  if (duplicateDecisionExists(db, input.title, input.payload)) return false
  createDecision(db, {
    ...input,
    state: 'needs_review',
    policy: {
      openclaw: 'v3.local',
      rule: input.payload.kind,
      note: 'Prototype run keeps non-ledger recommendations in review for human approval.',
    },
  })
  return true
}

const buildMissingRecipeTasks = (db: Db) => {
  const rows = db
    .prepare(
      `SELECT e.id AS evidence_id,
              e.source_document_id,
              e.summary,
              e.amount,
              e.occurred_at,
              e.payload_json,
              m.id AS menu_item_id,
              m.name AS menu_item_name
       FROM evidence_items e
       JOIN menu_items m ON m.id = e.entity_id
       WHERE e.evidence_type = 'toast_missing_recipe'
       ORDER BY e.created_at DESC`,
    )
    .all()

  return rows.filter((row) => !hasOpenMissingRecipeDecision(db, toNumber(row.source_document_id), toNumber(row.menu_item_id))).map((row) => {
    const payload = parseJson<Record<string, unknown>>(row.payload_json, {})
    return {
      title: `Review recipe mapping: ${toStringValue(row.menu_item_name)}`,
      payload: {
        kind: 'missing_recipe_review',
        menuItemId: toNumber(row.menu_item_id),
        menuItemName: toStringValue(row.menu_item_name),
        sourceDocumentId: toNumber(row.source_document_id),
        evidenceId: toNumber(row.evidence_id),
      },
      confidence: 0.64,
      riskLevel: 'medium' as const,
      evidence: [
        {
          kind: 'toast',
          evidenceId: toNumber(row.evidence_id),
          summary: toStringValue(row.summary),
          amount: toNumber(row.amount),
          occurredAt: row.occurred_at,
          raw: payload,
        },
      ],
    }
  })
}

const hasOpenMissingRecipeDecision = (db: Db, sourceDocumentId: number, menuItemId: number): boolean =>
  Boolean(
    db
      .prepare(
        `SELECT id
         FROM openclaw_decisions
         WHERE state IN ('proposed', 'needs_review', 'auto_applied')
           AND payload_json LIKE ?
           AND payload_json LIKE ?
           AND payload_json LIKE ?
         LIMIT 1`,
      )
      .get('%"kind":"missing_recipe"%', `%"sourceDocumentId":${sourceDocumentId}%`, `%"menuItemId":${menuItemId}%`),
  )

const buildInventoryRiskTasks = (db: Db) => {
  const positions = getInventoryPositions(db)
  return positions
    .filter((position) => position.warningState !== 'ok')
    .map((position) => {
      const riskLevel = position.warningState === 'critical' ? 'high' : position.warningState === 'low' ? 'medium' : 'low'
      return {
        title: `Review ${position.warningState} inventory: ${position.name}`,
        payload: {
          kind: 'inventory_risk_review',
          skuId: position.skuId,
          skuName: position.name,
          unit: position.unit,
          onHand: position.onHand,
          parLevel: position.parLevel,
          avgDailyUsage: position.avgDailyUsage,
          daysRemaining: position.daysRemaining,
          warningState: position.warningState,
        },
        confidence: Math.max(0.55, Math.min(0.9, position.confidence)),
        riskLevel: riskLevel as 'medium' | 'high',
        evidence: [{ kind: 'ledger', position }],
      }
    })
}

const buildSourceFreshnessTasks = (db: Db) => {
  const rows = db
    .prepare(
      `SELECT s.id,
              s.name,
              s.kind,
              MAX(COALESCE(r.completed_at, r.started_at)) AS last_run
       FROM sources s
       LEFT JOIN ingest_runs r ON r.source_id = s.id AND r.status = 'completed'
       WHERE s.is_active = 1
         AND s.kind != 'seed'
       GROUP BY s.id
       ORDER BY s.name`,
    )
    .all()

  const cutoff = Date.now() - 36 * 60 * 60 * 1000
  return rows
    .filter((row) => {
      const lastRun = toStringValue(row.last_run)
      return !lastRun || new Date(lastRun).getTime() < cutoff
    })
    .map((row) => ({
      title: `Refresh ${toStringValue(row.kind)} source: ${toStringValue(row.name)}`,
      payload: {
        kind: 'source_freshness_review',
        sourceId: toNumber(row.id),
        sourceName: toStringValue(row.name),
        sourceKind: toStringValue(row.kind),
        lastRun: toStringValue(row.last_run, 'never'),
      },
      confidence: 0.7,
      riskLevel: 'low' as const,
      evidence: [{ kind: 'source', sourceId: toNumber(row.id), lastRun: toStringValue(row.last_run, 'never') }],
    }))
}

const maybeCodexSummary = async (
  config: AppConfig | undefined,
  actions: Array<{ type: string; title: string; confidence: number }>,
): Promise<{ used: boolean; summary: string }> => {
  if (!config || process.env.OPENCLAW_USE_CODEX !== '1' || actions.length === 0) {
    return { used: false, summary: 'OpenClaw local policy pass completed.' }
  }

  const fallback = { summary: 'OpenClaw policy pass completed; Codex summary fallback used.' }
  const result = await runCodexJson<{ summary: string }>({
    model: config.logicModel,
    reasoningEffort: config.logicReasoningEffort,
    system: 'You summarize bar inventory reconciliation actions for a manager. Be concrete and concise.',
    task: `Summarize these review actions as JSON {"summary":"..."}:\n${JSON.stringify(actions.slice(0, 12))}`,
    fallback,
  })
  return { used: true, summary: result.summary || fallback.summary }
}

export const runOpenClawBrain = async (db: Db, config?: AppConfig): Promise<BrainRunResult> => {
  const candidates = [...buildMissingRecipeTasks(db), ...buildInventoryRiskTasks(db), ...buildSourceFreshnessTasks(db)]
  const actions: Array<{ type: string; title: string; confidence: number }> = []
  let createdDecisions = 0

  for (const candidate of candidates) {
    if (proposeOnce(db, candidate)) {
      createdDecisions += 1
      actions.push({
        type: toStringValue(candidate.payload.kind),
        title: candidate.title,
        confidence: candidate.confidence,
      })
    }
  }

  const reviewItems = toNumber(db.prepare("SELECT COUNT(*) AS count FROM openclaw_decisions WHERE state = 'needs_review'").get()?.count)
  const summary = await maybeCodexSummary(config, actions)

  return {
    createdDecisions,
    reviewedSignals: candidates.length,
    reviewItems,
    codexUsed: summary.used,
    summary: summary.summary,
    actions,
  }
}
