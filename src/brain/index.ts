import type { AppConfig } from '../config.js'
import { openDatabase, parseJson, type Db } from '../db/database.js'
import { migrateDatabase } from '../db/migrations.js'
import { runBackboneModel } from '../backbone/index.js'
import { applyExistingDecision, dismissDecision, getReviewQueue, isInventoryMutationPayload, reverseDecision } from './decisions.js'
import { runOpenClawBrain } from './openclaw.js'

const resolveDb = (input?: Db | AppConfig): { db: Db; close: boolean } => {
  if (input && typeof (input as Db).prepare === 'function') {
    return { db: input as Db, close: false }
  }
  const config = input as AppConfig | undefined
  const db = openDatabase(config?.dbPath)
  migrateDatabase(db)
  return { db, close: true }
}

export const runBrain = async (input?: Db | AppConfig) => {
  const { db, close } = resolveDb(input)
  try {
    const config = input && typeof (input as Db).prepare !== 'function' ? (input as AppConfig) : undefined
    const openClaw = await runOpenClawBrain(db, config)
    const backbone = runBackboneModel(db)
    return { openClaw, backbone }
  } finally {
    if (close) db.close()
  }
}

export { runOpenClawBrain }

export const listReviewItems = (input?: Db | AppConfig) => {
  const { db, close } = resolveDb(input)
  try {
    return getReviewQueue(db)
  } finally {
    if (close) db.close()
  }
}

export const reviewDecisions = listReviewItems

export const applyReviewDecision = (input: Db | AppConfig, decisionId: number) => {
  const { db, close } = resolveDb(input)
  try {
    const decision = db.prepare('SELECT payload_json FROM openclaw_decisions WHERE id = ?').get(decisionId)
    if (!decision) throw new Error(`decision_not_found:${decisionId}`)

    const payload = parseJson<Record<string, unknown>>(decision.payload_json, {})
    if (!isInventoryMutationPayload(payload)) {
      return {
        decisionId,
        applied: false,
        state: 'needs_review',
        next: `This is an advisory review. Resolve the issue, then run bbk review dismiss ${decisionId} "<reason>".`,
      }
    }

    return { decisionId, applied: true, eventId: applyExistingDecision(db, decisionId), state: 'auto_applied' }
  } finally {
    if (close) db.close()
  }
}

export const dismissReviewDecision = (input: Db | AppConfig, decisionId: number, reason?: string) => {
  const { db, close } = resolveDb(input)
  try {
    return { decisionId: dismissDecision(db, decisionId, reason), state: 'suppressed' }
  } finally {
    if (close) db.close()
  }
}

export const reverseAppliedDecision = (input: Db | AppConfig, decisionId: number) => {
  const { db, close } = resolveDb(input)
  try {
    return { decisionId, reversalEventId: reverseDecision(db, decisionId), state: 'reversed' }
  } finally {
    if (close) db.close()
  }
}
