import { resolve } from 'node:path'
import { backboneSimulationScenarios, type BackboneSimulationScenario } from '../../backbone/simulation.js'
import { parseIsoInstant } from '../../core/clock.js'
import { boundedText, finiteNumber } from '../../core/validation.js'

export type ParsedOptions = {
  env?: string
  asOf?: string
  horizonDays?: number
  horizons?: number[]
  usageWindowDays?: number
  trainingDays?: number
  days?: number
  cycles?: number
  once?: boolean
  intervalMs?: number
  toastFile?: string
  toastStart?: string
  toastEnd?: string
  skipToast?: boolean
  skipOpenClaw?: boolean
  simulateOpenClawFailure?: boolean
  scenario?: BackboneSimulationScenario
  maxAgeMinutes?: number
  maxRunAgeMinutes?: number
  maxCountAgeDays?: number
  maxFeedbackAgeDays?: number
  maxFeedbackTargetAgeDays?: number
  maxBottleMae?: number
  maxBiasBottles?: number
  recoverStaleMinutes?: number
  cursorLookbackMinutes?: number
  toastMaxRetries?: number
  toastRetryDelayMs?: number
  runVerify?: boolean
  minSamples?: number
  sku?: string
  olderThanDays?: number
  keep?: number
  force?: boolean
  limit?: number
  countCadenceDays?: number
  warmupDays?: number
  label?: string
  lockTtlMinutes?: number
}

type ValueParser = (value: string, flag: string) => string | number

const positiveInteger = (value: string, flag: string): number => {
  const number = finiteNumber(value, flag, { min: Number.EPSILON })
  if (!Number.isInteger(number)) throw new Error(`${flag}_must_be_an_integer`)
  return number
}

const nonNegativeInteger = (value: string, flag: string): number => {
  const number = finiteNumber(value, flag, { min: 0 })
  if (!Number.isInteger(number)) throw new Error(`${flag}_must_be_an_integer`)
  return number
}

const nonNegativeDecimal = (value: string, flag: string): number =>
  finiteNumber(value, flag, { min: 0 })

const valueParsers: Record<string, { key: keyof ParsedOptions; parse: ValueParser }> = {
  '--as-of': { key: 'asOf', parse: (value, flag) => parseIsoInstant(value, flag) },
  '--count-cadence-days': { key: 'countCadenceDays', parse: positiveInteger },
  '--cycles': { key: 'cycles', parse: positiveInteger },
  '--days': { key: 'days', parse: positiveInteger },
  '--env': { key: 'env', parse: (value) => cleanEnvName(value) },
  '--horizon-days': { key: 'horizonDays', parse: positiveInteger },
  '--interval-ms': { key: 'intervalMs', parse: nonNegativeInteger },
  '--keep': { key: 'keep', parse: nonNegativeInteger },
  '--label': { key: 'label', parse: (value) => cleanEnvName(value) },
  '--limit': { key: 'limit', parse: positiveInteger },
  '--lock-ttl-minutes': { key: 'lockTtlMinutes', parse: positiveInteger },
  '--max-age-minutes': { key: 'maxAgeMinutes', parse: nonNegativeInteger },
  '--max-bias-bottles': { key: 'maxBiasBottles', parse: nonNegativeDecimal },
  '--max-bottle-mae': { key: 'maxBottleMae', parse: nonNegativeDecimal },
  '--max-count-age-days': { key: 'maxCountAgeDays', parse: nonNegativeInteger },
  '--max-feedback-age-days': { key: 'maxFeedbackAgeDays', parse: nonNegativeInteger },
  '--max-feedback-target-age-days': {
    key: 'maxFeedbackTargetAgeDays',
    parse: nonNegativeInteger,
  },
  '--max-retries': { key: 'toastMaxRetries', parse: nonNegativeInteger },
  '--max-run-age-minutes': { key: 'maxRunAgeMinutes', parse: nonNegativeInteger },
  '--min-samples': { key: 'minSamples', parse: nonNegativeInteger },
  '--older-than-days': { key: 'olderThanDays', parse: nonNegativeInteger },
  '--recover-stale-minutes': { key: 'recoverStaleMinutes', parse: nonNegativeInteger },
  '--retry-delay-ms': { key: 'toastRetryDelayMs', parse: nonNegativeInteger },
  '--scenario': { key: 'scenario', parse: (value) => parseScenario(value) },
  '--sku': {
    key: 'sku',
    parse: (value, flag) => boundedText(value, flag, { required: true, maxLength: 240 }),
  },
  '--start': { key: 'toastStart', parse: (value, flag) => parseIsoInstant(value, flag) },
  '--end': { key: 'toastEnd', parse: (value, flag) => parseIsoInstant(value, flag) },
  '--toast-file': { key: 'toastFile', parse: (value) => resolve(value) },
  '--training-days': { key: 'trainingDays', parse: positiveInteger },
  '--usage-window-days': { key: 'usageWindowDays', parse: positiveInteger },
  '--warmup-days': { key: 'warmupDays', parse: positiveInteger },
}

export const parseOptions = (args: string[]): ParsedOptions => {
  const parsed: ParsedOptions = {}

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--once') {
      parsed.once = true
      parsed.cycles = 1
      continue
    }
    if (arg === '--skip-toast' || arg === '--no-toast') {
      parsed.skipToast = true
      continue
    }
    if (arg === '--skip-openclaw' || arg === '--no-openclaw') {
      parsed.skipOpenClaw = true
      continue
    }
    if (arg === '--simulate-openclaw-failure') {
      parsed.simulateOpenClawFailure = true
      continue
    }
    if (arg === '--verify') {
      parsed.runVerify = true
      continue
    }
    if (arg === '--force') {
      parsed.force = true
      continue
    }

    const equalsIndex = arg.indexOf('=')
    const flag = equalsIndex > 0 ? arg.slice(0, equalsIndex) : arg
    const definition = valueParsers[flag]
    if (flag === '--horizons') {
      const raw = equalsIndex > 0 ? arg.slice(equalsIndex + 1) : requireNext(args, ++index, flag)
      parsed.horizons = raw.split(',').map((item) => positiveInteger(item.trim(), flag))
      continue
    }
    if (!definition) throw new Error(`unknown_backbone_option:${arg}`)

    const raw = equalsIndex > 0 ? arg.slice(equalsIndex + 1) : requireNext(args, ++index, flag)
    Object.assign(parsed, { [definition.key]: definition.parse(raw, flag) })
  }

  return parsed
}

const requireNext = (args: string[], index: number, flag: string): string => {
  const value = args[index]
  if (!value || value.startsWith('--')) throw new Error(`${flag}_value_required`)
  return value
}

export const cleanEnvName = (value: string): string => {
  const clean = value.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 80)
  if (!clean) throw new Error('environment_name_required')
  if (clean === '.' || clean === '..') throw new Error(`unsafe_restore_environment_path:${clean}`)
  return clean
}

const parseScenario = (value: string): BackboneSimulationScenario => {
  if (backboneSimulationScenarios.includes(value as BackboneSimulationScenario)) {
    return value as BackboneSimulationScenario
  }
  throw new Error(`unknown_backbone_scenario:${value}`)
}
