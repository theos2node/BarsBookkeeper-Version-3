import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { openDatabase, toNumber } from '../db/database.js'
import { migrateDatabase } from '../db/migrations.js'
import { ensureBackboneEnvironment, getLatestBackboneRun, runBackboneModel } from '../backbone/index.js'
import {
  backboneSimulationScenarios,
  runBackboneAccuracySimulation,
  type BackboneSimulationScenario,
} from '../backbone/simulation.js'
import { runOpenClawBrain } from '../brain/openclaw.js'
import { pullToast } from '../ingest/toast.js'
import { withBackendDb } from './backend.js'
import type { CommandContext } from './types.js'

type ParsedOptions = {
  env?: string
  asOf?: string
  horizonDays?: number
  usageWindowDays?: number
  trainingDays?: number
  cycles?: number
  intervalMs?: number
  toastFile?: string
  toastStart?: string
  toastEnd?: string
  skipToast?: boolean
  skipOpenClaw?: boolean
  simulateOpenClawFailure?: boolean
  scenario?: BackboneSimulationScenario
  maxAgeMinutes?: number
  cursorLookbackMinutes?: number
}

type AuditCheck = {
  check: string
  status: 'pass' | 'warn' | 'fail'
  detail: string
}

type ToastWindow = {
  start?: string
  end?: string
  explicit: boolean
}

type OpenClawCycleResult = {
  ok: boolean
  reviewItems: number
  summary: string
  error?: string
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
    renderListenerHealth(db, context)
  })
}

export const backboneActions = async (_args: string[], context: CommandContext): Promise<void> => {
  context.terminal.title('Backbone actions')
  await withBackendDb(context.config, async (db: any) => {
    const result = getLatestBackboneRun(db)
    if (!result) {
      context.terminal.warn('No Backbone runs yet.')
      context.terminal.subtitle('Run `bbk backbone run` or `bbk backbone listen --once`.')
      return
    }

    context.terminal.dump({
      runId: result.runId,
      asOf: result.asOf,
      predictions: result.predictionCount,
      lowStock: result.lowStockCount,
      costOptions: result.costCuttingOptions,
    })

    const orderRows = result.predictions
      .filter((prediction) => prediction.lowStockRisk !== 'ok')
      .slice(0, 12)
      .map((prediction) => ({
        sku: prediction.skuName,
        risk: prediction.lowStockRisk,
        predicted: `${prediction.predictedOnHand} ${prediction.unit}`,
        days: prediction.predictedDaysRemaining ?? '',
        order: prediction.recommendedOrderQty > 0 ? `${prediction.recommendedOrderQty} ${prediction.unit}` : 'review',
        confidence: prediction.confidence,
      }))
    context.terminal.section('Order now')
    context.terminal.table(orderRows)

    const costRows = result.predictions
      .filter((prediction) => prediction.costSignal !== 'none')
      .slice(0, 12)
      .map((prediction) => ({
        sku: prediction.skuName,
        signal: prediction.costSignal,
        confidence: prediction.confidence,
        learned: prediction.calibrationSamples,
      }))
    context.terminal.section('Cost cuts')
    context.terminal.table(costRows)
  })
}

export const backboneEnvs = async (_args: string[], context: CommandContext): Promise<void> => {
  context.terminal.title('Backbone environments')
  await withBackendDb(context.config, async (db: any) => {
    const rows = db
      .prepare(
        `SELECT id, name, db_path, description, created_at, last_run_at
         FROM backbone_environments
         ORDER BY COALESCE(last_run_at, created_at) DESC, id DESC`,
      )
      .all()

    if (rows.length === 0) {
      context.terminal.warn('No isolated Backbone environments yet.')
      context.terminal.subtitle('Run `bbk backbone simulate --env <name>` or `bbk backbone matrix --env <prefix>`.')
      return
    }

    context.terminal.table(
      rows.map((row: any) => ({
        env: row.name,
        status: existsSync(String(row.db_path)) ? 'ready' : 'missing-db',
        latestRun: environmentLatestRun(String(row.db_path)),
        lastSeen: row.last_run_at ?? row.created_at,
        path: row.db_path,
      })),
    )
  })
}

export const backboneAudit = async (args: string[], context: CommandContext): Promise<void> => {
  const options = parseOptions(args)
  const maxAgeMinutes = options.maxAgeMinutes ?? 60
  context.terminal.title('Backbone audit')

  await withBackendDb(context.config, async (db: any) => {
    const checks = buildBackboneAudit(db, maxAgeMinutes)
    context.terminal.table(checks)

    const failures = checks.filter((check) => check.status === 'fail')
    const warnings = checks.filter((check) => check.status === 'warn')
    if (failures.length > 0) {
      context.terminal.error(`Backbone audit failed with ${failures.length} failing check${failures.length === 1 ? '' : 's'}.`)
      throw new Error(`backbone_audit_failed:${failures.map((check) => check.check).join(',')}`)
    }

    context.terminal.status(
      warnings.length > 0 ? 'warn' : 'ok',
      warnings.length > 0
        ? `Backbone audit passed with ${warnings.length} warning${warnings.length === 1 ? '' : 's'}.`
        : 'Backbone audit passed.',
    )
  })
}

const environmentLatestRun = (dbPath: string): string => {
  if (!existsSync(dbPath)) return ''
  const db = openDatabase(dbPath)
  try {
    migrateDatabase(db)
    const run = db
      .prepare(
        `SELECT id, status, metrics_json
         FROM backbone_runs
         ORDER BY id DESC
         LIMIT 1`,
      )
      .get()
    if (!run) return 'none'
    return `#${toNumber(run.id)} ${run.status}`
  } finally {
    db.close()
  }
}

export const backboneListen = async (args: string[], context: CommandContext): Promise<void> => {
  const options = parseOptions(args)
  const cycles = options.cycles ?? Number.POSITIVE_INFINITY
  const intervalMs = options.intervalMs ?? 5 * 60 * 1000
  let stopped = false
  let completed = 0

  const stop = () => {
    stopped = true
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)

  context.terminal.title('Backbone listener')
  context.terminal.subtitle(
    Number.isFinite(cycles)
      ? `cycles: ${cycles}; interval: ${intervalMs}ms`
      : `continuous; interval: ${intervalMs}ms`,
  )

  const db = openDatabase(context.config.dbPath)
  try {
    migrateDatabase(db)
    while (!stopped && completed < cycles) {
      completed += 1
      const cycleStarted = new Date().toISOString()
      const cycleId = startListenerCycle(db, cycleStarted)
      const toast = await tryPullToast(db, context, options)
      try {
        const openClaw = await tryRunOpenClaw(db, context, options)
        const backbone = runBackboneModel(db, {
          asOf: options.asOf,
          horizonDays: options.horizonDays,
          usageWindowDays: options.usageWindowDays,
          mode: 'live',
        })
        finishListenerCycle(db, cycleId, {
          status: 'completed',
          toast,
          reviewItems: openClaw.reviewItems,
          backboneRunId: backbone.runId,
          predictionCount: backbone.predictionCount,
          lowStockCount: backbone.lowStockCount,
          feedbackItems: backbone.feedbackItems,
          calibratedSkus: backbone.calibratedSkus,
          costCuttingOptions: backbone.costCuttingOptions,
          errorMessage: openClaw.ok ? undefined : `openclaw:${openClaw.error}`,
        })

        context.terminal.table([
          {
            cycle: completed,
            journal: cycleId,
            started: cycleStarted,
            toast: toast.summary,
            openClaw: openClaw.summary,
            reviewItems: openClaw.reviewItems,
            runId: backbone.runId,
            predictions: backbone.predictionCount,
            lowStock: backbone.lowStockCount,
            feedback: backbone.feedbackItems,
            calibrated: backbone.calibratedSkus,
            costOptions: backbone.costCuttingOptions,
          },
        ])
      } catch (error) {
        finishListenerCycle(db, cycleId, {
          status: 'failed',
          toast,
          errorMessage: error instanceof Error ? error.message : String(error),
        })
        throw error
      }

      if (stopped || completed >= cycles) break
      await sleep(intervalMs)
    }
    context.terminal.success(`Backbone listener stopped after ${completed} cycle${completed === 1 ? '' : 's'}.`)
  } finally {
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
    db.close()
  }
}

export const backboneSimulate = async (args: string[], context: CommandContext): Promise<void> => {
  const options = parseOptions(args)
  const envName = options.env ?? `sim-${options.scenario ?? 'steady'}-${new Date().toISOString().replace(/[:.]/g, '-')}`
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
      scenario: options.scenario,
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
      feedbackItems: result.feedbackItems,
      calibratedSkus: result.calibratedSkus,
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

export const backboneMatrix = async (args: string[], context: CommandContext): Promise<void> => {
  const options = parseOptions(args)
  const scenarios = options.scenario ? [options.scenario] : backboneSimulationScenarios
  const prefix = options.env ?? `matrix-${new Date().toISOString().replace(/[:.]/g, '-')}`

  context.terminal.title('Backbone scenario matrix')
  context.terminal.subtitle(`scenarios: ${scenarios.join(', ')}`)

  const results = await Promise.all(
    scenarios.map(async (scenario) => {
      const envName = cleanEnvName(`${prefix}-${scenario}`)
      const envDir = resolve(context.config.dataDir, 'environments', envName)
      const envDbPath = resolve(envDir, 'barsbookkeeper.sqlite')
      await mkdir(envDir, { recursive: true })

      await withBackendDb(context.config, async (controlDb: any) => {
        ensureBackboneEnvironment(controlDb, {
          name: envName,
          dbPath: envDbPath,
          description: `Backbone ${scenario} scenario matrix sandbox`,
        })
      })

      const db = openDatabase(envDbPath)
      try {
        migrateDatabase(db)
        const result = runBackboneAccuracySimulation(db, {
          startAt: options.asOf,
          trainingDays: options.trainingDays,
          scenario,
        })
        return { envName, envDbPath, result }
      } finally {
        db.close()
      }
    }),
  )

  context.terminal.table(
    results.map(({ envName, result }) => ({
      env: envName,
      scenario: result.scenario,
      passed: result.passed,
      bottleMae: result.bottleMae,
      maxBottleError: result.maxBottleError,
      lowStockRecall: result.lowStockRecall,
      lowStockPrecision: result.lowStockPrecision,
      costOptions: result.costCuttingOptions,
      feedback: result.feedbackItems,
      calibrated: result.calibratedSkus,
    })),
  )

  const failed = results.filter(({ result }) => !result.passed)
  if (failed.length > 0) throw new Error(`backbone_matrix_failed:${failed.map(({ result }) => result.scenario).join(',')}`)
  context.terminal.success(`Backbone scenario matrix passed ${results.length}/${results.length} scenarios.`)
}

const buildBackboneAudit = (db: any, maxAgeMinutes: number): AuditCheck[] => {
  const latestRun = db
    .prepare(
      `SELECT id, as_of, metrics_json
       FROM backbone_runs
       WHERE status = 'completed'
       ORDER BY id DESC
       LIMIT 1`,
    )
    .get()
  const latestCycle = db
    .prepare(
      `SELECT *
       FROM backbone_listener_cycles
       ORDER BY id DESC
       LIMIT 1`,
    )
    .get()
  const cursor = db.prepare('SELECT last_start, last_end, last_source, updated_at FROM backbone_toast_cursor WHERE id = 1').get()
  const failedCycles = toNumber(
    db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM backbone_listener_cycles
         WHERE status = 'failed'
           AND id >= COALESCE((SELECT MAX(id) - 9 FROM backbone_listener_cycles), 0)`,
      )
      .get()?.count,
  )
  const predictionCount = toNumber(db.prepare('SELECT COUNT(*) AS count FROM backbone_predictions').get()?.count)
  const feedbackCount = toNumber(db.prepare('SELECT COUNT(*) AS count FROM backbone_feedback').get()?.count)
  const calibrationCount = toNumber(db.prepare('SELECT COUNT(*) AS count FROM backbone_calibrations').get()?.count)
  const costSignals = toNumber(
    db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM backbone_predictions
         WHERE cost_signal != 'none'`,
      )
      .get()?.count,
  )
  const openLowStock = latestRun
    ? toNumber(
        db
          .prepare(
            `SELECT COUNT(*) AS count
             FROM backbone_predictions
             WHERE run_id = ?
               AND low_stock_risk != 'ok'`,
          )
          .get(toNumber(latestRun.id))?.count,
      )
    : 0

  const checks: AuditCheck[] = []
  checks.push({
    check: 'latest run',
    status: latestRun ? 'pass' : 'fail',
    detail: latestRun ? `run ${toNumber(latestRun.id)} at ${latestRun.as_of}` : 'no completed Backbone run',
  })
  checks.push({
    check: 'prediction coverage',
    status: predictionCount > 0 ? 'pass' : 'fail',
    detail: `${predictionCount} stored prediction${predictionCount === 1 ? '' : 's'}`,
  })

  if (!latestCycle) {
    checks.push({ check: 'listener heartbeat', status: 'fail', detail: 'no listener cycle journaled' })
  } else {
    const ageMinutes = Math.max(0, (Date.now() - new Date(latestCycle.started_at).getTime()) / 60_000)
    checks.push({
      check: 'listener heartbeat',
      status: ageMinutes <= maxAgeMinutes ? 'pass' : 'fail',
      detail: `cycle ${latestCycle.id} ${Number(ageMinutes.toFixed(1))}m old`,
    })
    checks.push({
      check: 'listener status',
      status: latestCycle.status === 'completed' ? 'pass' : 'fail',
      detail: `${latestCycle.status}${latestCycle.error_message ? `: ${latestCycle.error_message}` : ''}`,
    })
    checks.push({
      check: 'toast intake',
      status: latestCycle.toast_ok ? 'pass' : 'warn',
      detail: latestCycle.toast_ok ? latestCycle.toast_summary : latestCycle.toast_error ?? latestCycle.toast_summary,
    })
  }

  checks.push({
    check: 'recent failures',
    status: failedCycles === 0 ? 'pass' : 'fail',
    detail: `${failedCycles} failed listener cycle${failedCycles === 1 ? '' : 's'} in last 10`,
  })
  checks.push({
    check: 'low-stock signal',
    status: openLowStock > 0 ? 'pass' : 'warn',
    detail: `${openLowStock} non-ok risk prediction${openLowStock === 1 ? '' : 's'} in latest run`,
  })
  checks.push({
    check: 'cost signal',
    status: costSignals > 0 ? 'pass' : 'warn',
    detail: `${costSignals} stored cost signal${costSignals === 1 ? '' : 's'}`,
  })
  checks.push({
    check: 'feedback learning',
    status: feedbackCount > 0 && calibrationCount > 0 ? 'pass' : 'warn',
    detail: `${feedbackCount} feedback item${feedbackCount === 1 ? '' : 's'}, ${calibrationCount} calibrated SKU${calibrationCount === 1 ? '' : 's'}`,
  })
  checks.push({
    check: 'toast cursor',
    status: cursor?.last_end ? 'pass' : 'warn',
    detail: cursor?.last_end ? `${cursor.last_start ?? '?'} -> ${cursor.last_end} (${cursor.last_source ?? 'unknown'})` : 'no successful cursor yet',
  })

  return checks
}

const tryPullToast = async (
  db: any,
  context: CommandContext,
  options: ParsedOptions,
): Promise<{ ok: boolean; summary: string; error?: string }> => {
  if (options.skipToast) return { ok: true, summary: 'skipped' }

  const toastArgs: string[] = []
  if (options.toastFile) toastArgs.push('--file', options.toastFile)
  const toastWindow = resolveToastWindow(db, options)
  if (toastWindow.start) toastArgs.push('--start', toastWindow.start)
  if (toastWindow.end) toastArgs.push('--end', toastWindow.end)

  try {
    const result = await pullToast(db, context.config, toastArgs)
    if (toastWindow.start && toastWindow.end) {
      updateToastCursor(db, {
        start: toastWindow.start,
        end: toastWindow.end,
        source: result.source,
      })
    }
    return {
      ok: true,
      summary: `${result.source}:${result.rowsPulled}/${result.ingest.recordsImported}${toastWindow.start && toastWindow.end ? ` ${toastWindow.start}->${toastWindow.end}` : ''}`,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    context.terminal.warn(`Toast pull skipped this cycle: ${message}`)
    return { ok: false, summary: `error:${message}`, error: message }
  }
}

const tryRunOpenClaw = async (
  db: any,
  context: CommandContext,
  options: ParsedOptions,
): Promise<OpenClawCycleResult> => {
  if (options.skipOpenClaw) {
    return { ok: true, reviewItems: 0, summary: 'skipped' }
  }

  try {
    if (options.simulateOpenClawFailure) throw new Error('simulated_openclaw_failure')
    const result = await runOpenClawBrain(db, context.config)
    return { ok: true, reviewItems: result.reviewItems, summary: 'ok' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    context.terminal.warn(`OpenClaw skipped this cycle: ${message}`)
    return { ok: false, reviewItems: 0, summary: `warn:${message}`, error: message }
  }
}

const resolveToastWindow = (db: any, options: ParsedOptions): ToastWindow => {
  if (options.toastStart || options.toastEnd) {
    return {
      start: options.toastStart,
      end: options.toastEnd,
      explicit: true,
    }
  }
  if (options.toastFile) return { explicit: false }

  const now = new Date()
  const cursor = db.prepare('SELECT last_end FROM backbone_toast_cursor WHERE id = 1').get()
  const lookbackMinutes = options.cursorLookbackMinutes ?? 48 * 60
  const start = cursor?.last_end
    ? String(cursor.last_end)
    : new Date(now.getTime() - lookbackMinutes * 60_000).toISOString()
  return {
    start,
    end: now.toISOString(),
    explicit: false,
  }
}

const updateToastCursor = (
  db: any,
  input: { start: string; end: string; source: string },
): void => {
  db.prepare(
    `INSERT INTO backbone_toast_cursor (id, last_start, last_end, last_source, updated_at)
     VALUES (1, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(id) DO UPDATE SET
       last_start = excluded.last_start,
       last_end = excluded.last_end,
       last_source = excluded.last_source,
       updated_at = CURRENT_TIMESTAMP`,
  ).run(input.start, input.end, input.source)
}

const startListenerCycle = (db: any, startedAt: string): number =>
  toNumber(
    db
      .prepare(
        `INSERT INTO backbone_listener_cycles (started_at, status)
         VALUES (?, 'running')`,
      )
      .run(startedAt).lastInsertRowid,
  )

const finishListenerCycle = (
  db: any,
  cycleId: number,
  input: {
    status: 'completed' | 'failed'
    toast: { ok: boolean; summary: string; error?: string }
    reviewItems?: number
    backboneRunId?: number
    predictionCount?: number
    lowStockCount?: number
    feedbackItems?: number
    calibratedSkus?: number
    costCuttingOptions?: number
    errorMessage?: string
  },
): void => {
  db.prepare(
    `UPDATE backbone_listener_cycles
     SET completed_at = CURRENT_TIMESTAMP,
         status = ?,
         toast_ok = ?,
         toast_summary = ?,
         toast_error = ?,
         review_items = ?,
         backbone_run_id = ?,
         prediction_count = ?,
         low_stock_count = ?,
         feedback_items = ?,
         calibrated_skus = ?,
         cost_cutting_options = ?,
         error_message = ?
     WHERE id = ?`,
  ).run(
    input.status,
    input.toast.ok ? 1 : 0,
    input.toast.summary,
    input.toast.error ?? null,
    input.reviewItems ?? 0,
    input.backboneRunId ?? null,
    input.predictionCount ?? 0,
    input.lowStockCount ?? 0,
    input.feedbackItems ?? 0,
    input.calibratedSkus ?? 0,
    input.costCuttingOptions ?? 0,
    input.errorMessage ?? null,
    cycleId,
  )
}

const renderListenerHealth = (db: any, context: CommandContext): void => {
  const rows = db
    .prepare(
      `SELECT id,
              started_at,
              status,
              toast_ok,
              toast_summary,
              review_items,
              backbone_run_id,
              prediction_count,
              low_stock_count,
              feedback_items,
              calibrated_skus,
              cost_cutting_options,
              error_message
       FROM backbone_listener_cycles
       ORDER BY id DESC
       LIMIT 5`,
    )
    .all()
  if (rows.length === 0) return

  context.terminal.section('Listener health')
  context.terminal.table(
    rows.map((row: any) => ({
      id: row.id,
      status: row.status,
      started: row.started_at,
      toast: row.toast_ok ? row.toast_summary : `warn:${row.toast_summary}`,
      run: row.backbone_run_id ?? '',
      predictions: row.prediction_count,
      lowStock: row.low_stock_count,
      feedback: row.feedback_items,
      calibrated: row.calibrated_skus,
      error: row.error_message ?? '',
    })),
  )
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
    feedbackItems: number
    calibratedSkus: number
    predictions: Array<{
      skuName: string
      predictedOnHand: number
      unit: string
      predictedDaysRemaining: number | null
      lowStockRisk: string
      confidence: number
      recommendedOrderQty: number
      costSignal: string
      calibrationSamples: number
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
    feedbackItems: result.feedbackItems,
    calibratedSkus: result.calibratedSkus,
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
      learned: prediction.calibrationSamples,
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
    } else if (arg === '--cycles' && next) {
      parsed.cycles = positiveNumber(next, '--cycles')
      index += 1
    } else if (arg === '--once') {
      parsed.cycles = 1
    } else if (arg === '--interval-ms' && next) {
      parsed.intervalMs = nonNegativeNumber(next, '--interval-ms')
      index += 1
    } else if (arg === '--toast-file' && next) {
      parsed.toastFile = resolve(next)
      index += 1
    } else if (arg === '--start' && next) {
      parsed.toastStart = next
      index += 1
    } else if (arg === '--end' && next) {
      parsed.toastEnd = next
      index += 1
    } else if (arg === '--skip-toast' || arg === '--no-toast') {
      parsed.skipToast = true
    } else if (arg === '--skip-openclaw' || arg === '--no-openclaw') {
      parsed.skipOpenClaw = true
    } else if (arg === '--simulate-openclaw-failure') {
      parsed.simulateOpenClawFailure = true
    } else if (arg === '--scenario' && next) {
      parsed.scenario = parseScenario(next)
      index += 1
    } else if (arg === '--max-age-minutes' && next) {
      parsed.maxAgeMinutes = nonNegativeNumber(next, '--max-age-minutes')
      index += 1
    } else if (arg === '--cursor-lookback-minutes' && next) {
      parsed.cursorLookbackMinutes = positiveNumber(next, '--cursor-lookback-minutes')
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

const nonNegativeNumber = (value: string, flag: string): number => {
  const number = toNumber(value)
  if (number < 0) throw new Error(`${flag}_must_be_non_negative`)
  return Math.round(number)
}

const cleanEnvName = (value: string): string => {
  const clean = value.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 80)
  if (!clean) throw new Error('environment_name_required')
  return clean
}

const parseScenario = (value: string): BackboneSimulationScenario => {
  if (backboneSimulationScenarios.includes(value as BackboneSimulationScenario)) {
    return value as BackboneSimulationScenario
  }
  throw new Error(`unknown_backbone_scenario:${value}`)
}

const sleep = (ms: number): Promise<void> => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
