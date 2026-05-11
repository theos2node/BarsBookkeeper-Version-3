import { resolve } from 'node:path'

export type ModelEffort = 'low' | 'medium' | 'high' | 'xhigh'

export type AppConfig = {
  dataDir: string
  dbPath: string
  filesDir: string
  logicModel: string
  logicReasoningEffort: ModelEffort
  fastModel: string
  fastReasoningEffort: ModelEffort
}

const effort = (value: string | undefined, fallback: ModelEffort): ModelEffort => {
  if (value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh') return value
  return fallback
}

export const getConfig = (): AppConfig => {
  const dataDir = resolve(process.env.BBK_DATA_DIR || './data')
  return {
    dataDir,
    dbPath: resolve(dataDir, 'barsbookkeeper.sqlite'),
    filesDir: resolve(dataDir, 'files'),
    logicModel: process.env.OPENCLAW_LOGIC_MODEL || 'gpt-5.4',
    logicReasoningEffort: effort(process.env.OPENCLAW_LOGIC_REASONING_EFFORT, 'low'),
    fastModel: process.env.OPENCLAW_FAST_MODEL || 'gpt-5.4-mini',
    fastReasoningEffort: effort(process.env.OPENCLAW_FAST_REASONING_EFFORT, 'low'),
  }
}
