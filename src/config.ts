import { existsSync } from 'node:fs'
import { isAbsolute, parse, resolve } from 'node:path'
import { loadEnvFile } from 'node:process'

export type ModelEffort = 'low' | 'medium' | 'high' | 'xhigh'

export type AppConfig = {
  dataDir: string
  dbPath: string
  filesDir: string
  logicModel: string
  logicReasoningEffort: ModelEffort
  fastModel: string
  fastReasoningEffort: ModelEffort
  envFiles?: string[]
}

const effort = (value: string | undefined, fallback: ModelEffort): ModelEffort => {
  if (!value) return fallback
  if (value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh') return value
  throw new Error(`invalid_model_reasoning_effort:${value}`)
}

const loadEnvironment = (cwd = process.cwd()): string[] => {
  const explicit = process.env.BBK_ENV_FILE
  const candidates = explicit
    ? [isAbsolute(explicit) ? explicit : resolve(cwd, explicit)]
    : [resolve(cwd, '.env.local'), resolve(cwd, '.env')]
  const loaded: string[] = []

  for (const path of candidates) {
    if (!existsSync(path)) {
      if (explicit) throw new Error(`environment_file_not_found:${path}`)
      continue
    }
    loadEnvFile(path)
    loaded.push(path)
  }
  return loaded
}

const safeDataDir = (value: string): string => {
  const path = resolve(value)
  if (path === parse(path).root) throw new Error(`unsafe_data_directory:${path}`)
  return path
}

export const getConfig = (): AppConfig => {
  const envFiles = loadEnvironment()
  const dataDir = safeDataDir(process.env.BBK_DATA_DIR || './data')
  return {
    dataDir,
    dbPath: resolve(dataDir, 'barsbookkeeper.sqlite'),
    filesDir: resolve(dataDir, 'files'),
    logicModel: process.env.OPENCLAW_LOGIC_MODEL || 'gpt-5.4',
    logicReasoningEffort: effort(process.env.OPENCLAW_LOGIC_REASONING_EFFORT, 'low'),
    fastModel: process.env.OPENCLAW_FAST_MODEL || 'gpt-5.4-mini',
    fastReasoningEffort: effort(process.env.OPENCLAW_FAST_REASONING_EFFORT, 'low'),
    envFiles,
  }
}
