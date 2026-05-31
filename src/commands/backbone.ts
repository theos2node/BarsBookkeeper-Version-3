import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { openDatabase, toNumber } from '../db/database.js'
import { migrateDatabase } from '../db/migrations.js'
import { ensureBackboneEnvironment, getLatestBackboneRun, runBackboneModel } from '../backbone/index.js'
import { runBackboneAccuracySimulation } from '../backbone/simulation.js'
import { withBackendDb } from './backend.js'
import type { CommandContext } from './types.js'

type ParsedOptions = {
  env?: string
  asOf?: string
  horizonDays?: number
  usageWindowDays?: number
  trainingDays?: number
}

export const backboneRun = async (args: string[], context: CommandContext): Promise<void> => {
  const options = parseOptions(args)
  context.terminal.title('Backbone model run')
  await withBackendDb(context.config, async (db: any) => {
    const result = runBackboneModel(db, {
      asOf: options.asOf,
      horizonDays: options.horizonDays,
      usageWindowDays: options.usageWindowDays,
      mode: 'live',
    })
    context.terminal.success(`Backbone run ${result.runId} completed.`)
    renderRun(result, context)
  })
}

export const backboneStatus = async (_args: string[], context: CommandContext): Promise<void> => {
  context.terminal.title('Backbone status')
  await withBackendDb(context.config, async (db: any) => {
    const result = getLatestBackboneRun(db)
    if (!result) {
      context.terminal.warn('No Backbone runs yet.')
      context.terminal.subtitle('Run `bbk backbone run` or `bbk backbone simulate`.')
      return
    }
    renderRun(result, context)
  })
}

export const backboneSimulate = async (args: string[], context: CommandContext): Promise<void> => {
  const options = parseOptions(args)
  const envName = options.env ?? `sim-${new Date().toISOString().replace(/[:.]/g, '-')}`
  const envDir = resolve(context.config.dataDir, 'environments', envName)
  const envDbPath = resolve(envDir, 'barsbookkeeper.sqlite')

  context.terminal.title('Backbone isolated simulation')
  await mkdir(envDir, { recursive: true })

  await withBackendDb(context.config, async (controlDb: any) => {
    ensureBackboneEnvironment(controlDb, {
      name: envName,
      dbPath: envDbPath,
      description: 'Isolated Backbone accuracy sandbox',
    })
  })

  const db = openDatabase(envDbPath)
  try {
    migrateDatabase(db)
    const result = runBackboneAccuracySimulation(db, {
      startAt: options.asOf,
      trainingDays: options.trainingDays,
    })
    context.terminal.status(result.passed ? 'ok' : 'fail', `Simulation ${envName} ${result.passed ? 'passed' : 'failed'}`)
    context.terminal.subtitle(`sandbox db: ${envDbPath}`)
    context.terminal.dump({
      runId: result.run.runId,
      trainingDays: result.trainingDays,
      actualAsOf: result.actualAsOf,
      bottleMae: result.bottleMae,
      maxBottleError: result.maxBottleError,
      lowStockRecall: result.lowStockRecall,
      lowStockPrecision: result.lowStockPrecision,
      costCuttingOptions: result.costCuttingOptions,
    })
    context.terminal.section('Predictions')
    context.terminal.table(result.predictions)
    if (!result.passed) {
      throw new Error('backbone_simulation_failed')
    }
  } finally {
    db.close()
  }
}

const renderRun = (
  result: {
    runId: number
    asOf: string
    horizonDays: number
    usageWindowDays: number
    predictionCount: number
    predictedStockouts: number
    lowStockCount: number
    costCuttingOptions: number
    predictions: Array<{
      skuName: string
      predictedOnHand: number
      unit: string
      predictedDaysRemaining: number | null
      lowStockRisk: string
      confidence: number
      recommendedOrderQty: number
      costSignal: string
    }>
  },
  context: CommandContext,
): void => {
  context.terminal.dump({
    runId: result.runId,
    asOf: result.asOf,
    horizonDays: result.horizonDays,
    usageWindowDays: result.usageWindowDays,
    predictionCount: result.predictionCount,
    predictedStockouts: result.predictedStockouts,
    lowStockCount: result.lowStockCount,
    costCuttingOptions: result.costCuttingOptions,
  })
  context.terminal.section('Top risks')
  context.terminal.table(
    result.predictions.slice(0, 10).map((prediction) => ({
      sku: prediction.skuName,
      predicted: `${prediction.predictedOnHand} ${prediction.unit}`,
      days: prediction.predictedDaysRemaining ?? '',
      risk: prediction.lowStockRisk,
      confidence: prediction.confidence,
      order: prediction.recommendedOrderQty,
      cost: prediction.costSignal,
    })),
  )
}

const parseOptions = (args: string[]): ParsedOptions => {
  const parsed: ParsedOptions = {}
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    const next = args[index + 1]
    if (arg === '--env' && next) {
      parsed.env = cleanEnvName(next)
      index += 1
    } else if (arg === '--as-of' && next) {
      parsed.asOf = next
      index += 1
    } else if (arg === '--horizon-days' && next) {
      parsed.horizonDays = positiveNumber(next, '--horizon-days')
      index += 1
    } else if (arg === '--usage-window-days' && next) {
      parsed.usageWindowDays = positiveNumber(next, '--usage-window-days')
      index += 1
    } else if (arg === '--training-days' && next) {
      parsed.trainingDays = positiveNumber(next, '--training-days')
      index += 1
    } else if (arg === '--days' && next) {
      parsed.trainingDays = positiveNumber(next, '--days') - 1
      index += 1
    }
  }
  return parsed
}

const positiveNumber = (value: string, flag: string): number => {
  const number = toNumber(value)
  if (number <= 0) throw new Error(`${flag}_must_be_positive`)
  return Math.round(number)
}

const cleanEnvName = (value: string): string => {
  const clean = value.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 80)
  if (!clean) throw new Error('environment_name_required')
  return clean
}
