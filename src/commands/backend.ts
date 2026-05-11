type BackendModule = Record<string, unknown>

export type BackendCall = {
  module: string
  exportName: string
  result: unknown
}

export type BackendMissing = {
  moduleCandidates: string[]
  exportCandidates: string[]
}

export class BackendUnavailableError extends Error {
  constructor(readonly missing: BackendMissing) {
    super(
      `No backend service export found. Tried ${missing.exportCandidates.join(', ')} in ${missing.moduleCandidates.join(', ')}.`,
    )
  }
}

export const callBackend = async (
  moduleCandidates: string[],
  exportCandidates: string[],
  args: unknown[],
): Promise<BackendCall> => {
  const loaded: Array<{ modulePath: string; module: BackendModule }> = []

  for (const modulePath of moduleCandidates) {
    const module = await importOptional(modulePath)
    if (module) loaded.push({ modulePath, module })
  }

  for (const { modulePath, module } of loaded) {
    for (const exportName of exportCandidates) {
      const candidate = module[exportName]
      if (typeof candidate === 'function') {
        return {
          module: modulePath,
          exportName,
          result: await candidate(...args),
        }
      }
    }
  }

  throw new BackendUnavailableError({ moduleCandidates, exportCandidates })
}

export const withBackendDb = async <T>(
  config: { dbPath: string },
  work: (db: unknown) => T | Promise<T>,
): Promise<T> => {
  const database = await importOptional('../db/database.js')
  const client = database ? null : await importOptional('../db/client.js')

  let db: unknown
  let close: (() => void) | undefined

  if (typeof database?.openDatabase === 'function') {
    db = database.openDatabase(config.dbPath)
    close = () => {
      if (typeof db === 'object' && db !== null && 'close' in db && typeof db.close === 'function') {
        db.close()
      }
    }
  } else if (typeof client?.getDb === 'function') {
    db = client.getDb()
    const closeDb = client.closeDb
    close = typeof closeDb === 'function' ? () => closeDb() : undefined
  }

  if (!db) {
    throw new BackendUnavailableError({
      moduleCandidates: ['../db/database.js', '../db/client.js'],
      exportCandidates: ['openDatabase', 'getDb'],
    })
  }

  const migrations = await importOptional('../db/migrations.js')
  if (typeof migrations?.migrateDatabase === 'function') {
    migrations.migrateDatabase(db)
  }

  try {
    return await work(db)
  } finally {
    close?.()
  }
}

const importOptional = async (modulePath: string): Promise<BackendModule | null> => {
  try {
    const url = new URL(modulePath, import.meta.url)
    return (await import(url.href)) as BackendModule
  } catch (error) {
    if (isModuleNotFound(error)) return null
    throw error
  }
}

const isModuleNotFound = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) return false
  const code = 'code' in error ? String(error.code) : ''
  const message = 'message' in error ? String(error.message) : ''
  return (
    code === 'ERR_MODULE_NOT_FOUND' ||
    code === 'MODULE_NOT_FOUND' ||
    message.includes('Cannot find module') ||
    message.includes('Cannot resolve module')
  )
}
