import type { AppConfig } from '../config.js'
import { openDatabase, type Db } from '../db/database.js'
import { migrateDatabase } from '../db/migrations.js'
import { getReviewQueue, runBrain as runBrainStatus } from './decisions.js'

const resolveDb = (input?: Db | AppConfig): { db: Db; close: boolean } => {
  if (input && typeof (input as Db).prepare === 'function') {
    return { db: input as Db, close: false }
  }
  const config = input as AppConfig | undefined
  const db = openDatabase(config?.dbPath)
  migrateDatabase(db)
  return { db, close: true }
}

export const runBrain = (input?: Db | AppConfig) => {
  const { db, close } = resolveDb(input)
  try {
    const review = getReviewQueue(db)
    return {
      ...runBrainStatus(),
      reviewItems: review.length,
    }
  } finally {
    if (close) db.close()
  }
}

export const listReviewItems = (input?: Db | AppConfig) => {
  const { db, close } = resolveDb(input)
  try {
    return getReviewQueue(db)
  } finally {
    if (close) db.close()
  }
}

export const reviewDecisions = listReviewItems
