import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

export type ModelRate = {
  inputUsdPerMillion: number
  outputUsdPerMillion: number
}

export type UsageRecord = {
  at: string
  model: string
  inputTokens: number
  outputTokens: number
  estimatedUsd: number
  source: 'codex'
}

export type UsageLedger = {
  version: 1
  records: UsageRecord[]
}

export type UsageSummary = {
  calls: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  estimatedUsd: number
  blendedUsdPer1kTokens: number
  rates: Record<string, ModelRate>
  note: string
}

export const defaultModelRates: Record<string, ModelRate> = {
  'gpt-5.4': { inputUsdPerMillion: 2.5, outputUsdPerMillion: 15 },
  'gpt-5.4-mini': { inputUsdPerMillion: 0.75, outputUsdPerMillion: 4.5 },
}

const ledgerPath = (): string => resolve(process.env.BBK_DATA_DIR || './data', 'openclaw-usage.json')
const maximumLedgerBytes = 8 * 1024 * 1024
const maximumLedgerRecords = 10_000

export const estimateTokens = (text: string): number => Math.max(1, Math.ceil(text.length / 4))

export const rateForModel = (model: string): ModelRate => {
  const envPrefix = model.toUpperCase().replace(/[^A-Z0-9]+/g, '_')
  const input = Number(process.env[`OPENCLAW_RATE_${envPrefix}_INPUT_PER_1M`])
  const output = Number(process.env[`OPENCLAW_RATE_${envPrefix}_OUTPUT_PER_1M`])
  if (Number.isFinite(input) && input > 0 && Number.isFinite(output) && output > 0) {
    return { inputUsdPerMillion: input, outputUsdPerMillion: output }
  }
  return defaultModelRates[model] ?? defaultModelRates['gpt-5.4-mini']
}

export const estimateUsd = (model: string, inputTokens: number, outputTokens: number): number => {
  const rate = rateForModel(model)
  return (inputTokens / 1_000_000) * rate.inputUsdPerMillion + (outputTokens / 1_000_000) * rate.outputUsdPerMillion
}

export const recordOpenClawUsage = (input: {
  model: string
  prompt: string
  output: string
  source?: 'codex'
}): UsageRecord => {
  const inputTokens = estimateTokens(input.prompt)
  const outputTokens = estimateTokens(input.output)
  const record: UsageRecord = {
    at: new Date().toISOString(),
    model: input.model,
    inputTokens,
    outputTokens,
    estimatedUsd: Number(estimateUsd(input.model, inputTokens, outputTokens).toFixed(8)),
    source: input.source ?? 'codex',
  }
  const ledger = readUsageLedger()
  ledger.records.push(record)
  writeUsageLedger(ledger)
  return record
}

export const readUsageLedger = (): UsageLedger => {
  try {
    const path = ledgerPath()
    if (statSync(path).size > maximumLedgerBytes) return { version: 1, records: [] }
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<UsageLedger>
    return {
      version: 1,
      records: Array.isArray(parsed.records)
        ? parsed.records.filter(isUsageRecord).slice(-maximumLedgerRecords)
        : [],
    }
  } catch {
    return { version: 1, records: [] }
  }
}

export const readUsageSummary = (): UsageSummary => {
  const records = readUsageLedger().records
  const inputTokens = records.reduce((total, record) => total + record.inputTokens, 0)
  const outputTokens = records.reduce((total, record) => total + record.outputTokens, 0)
  const estimatedUsd = records.reduce((total, record) => total + record.estimatedUsd, 0)
  const totalTokens = inputTokens + outputTokens
  return {
    calls: records.length,
    inputTokens,
    outputTokens,
    totalTokens,
    estimatedUsd: Number(estimatedUsd.toFixed(6)),
    blendedUsdPer1kTokens: totalTokens > 0 ? Number(((estimatedUsd / totalTokens) * 1000).toFixed(6)) : 0,
    rates: defaultModelRates,
    note: 'Estimated from local prompt/output character counts; Codex ChatGPT login does not expose exact billing here.',
  }
}

const writeUsageLedger = (ledger: UsageLedger): void => {
  const path = ledgerPath()
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') chmodSync(directory, 0o700)
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`
  const boundedLedger: UsageLedger = {
    version: 1,
    records: ledger.records.filter(isUsageRecord).slice(-maximumLedgerRecords),
  }
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(boundedLedger, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
    renameSync(temporaryPath, path)
    chmodSync(path, 0o600)
  } finally {
    try {
      unlinkSync(temporaryPath)
    } catch {
      // The atomic rename already consumed the temporary file.
    }
  }
}

const isUsageRecord = (value: unknown): value is UsageRecord => {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<UsageRecord>
  return (
    typeof record.at === 'string' &&
    typeof record.model === 'string' &&
    record.source === 'codex' &&
    Number.isFinite(record.inputTokens) &&
    Number.isFinite(record.outputTokens) &&
    Number.isFinite(record.estimatedUsd)
  )
}
