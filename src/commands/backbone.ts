import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { openDatabase, parseJson, stringifyJson, toNumber, type Db } from '../db/database.js'
import { migrateDatabase } from '../db/migrations.js'
import { ensureBackboneEnvironment, getLatestBackboneRun, runBackboneModel, unscoredCountFeedback } from '../backbone/index.js'
import {
  backboneSimulationScenarios,
  runBackboneAccuracySimulation,
  runBackboneRollingBacktest,
  type BackboneSimulationScenario,
} from '../backbone/simulation.js'
import { runOpenClawBrain } from '../brain/openclaw.js'
import { pullToast } from '../ingest/toast.js'
import { suggestToastRecipeMappings } from '../ingest/recipes.js'
import { withBackendDb } from './backend.js'
import type { CommandContext } from './types.js'

type ParsedOptions = {
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

type AccuracySummary = {
  target: string
  feedbackSamples: number
  calibratedSkus: number
  bottleMae: number
  maxBottleError: number
  meanAbsErrorQty: number
  biasQty: number
  feedbackBandCoverage: number
  outOfBandSamples: number
  latestFeedback: string
}

type LearningDriftSummary = {
  target: string
  feedbackSamples: number
  calibratedSkus: number
  staleCalibrationSkus: number
  bottleMae: number
  biasBottles: number
  recentBottleMae: number
  previousBottleMae: number
  trendDelta: number
  feedbackBandCoverage: number
  outOfBandSamples: number
  latestFeedback: string
  feedbackAgeDays: number | null
  thresholds: {
    minSamples: number
    maxBottleMae: number
    maxBiasBottles: number
    maxFeedbackAgeDays: number
  }
  status: 'pass' | 'warn'
  statusReason: string
}

type RuntimeLockState = {
  present: boolean
  name: string
  owner: string
  acquiredAt: string
  heartbeatAt: string
  expiresAt: string
  state: 'active' | 'stale' | 'absent'
  ageMinutes: number
}

type ToastIntakeSummary = {
  target: string
  toastDocuments: number
  mappedDocuments: number
  missingRecipeDocuments: number
  recipeCoveragePct: number
  importedSaleEvents: number
  consumedQuantity: number
  openMissingRecipeReviews: number
  latestToastDocument: string
  latestSaleEvent: string
}

type BackboneGapSummary = {
  target: string
  totalGaps: number
  critical: number
  high: number
  medium: number
  low: number
  toastRecipeCoveragePct: number
  staleCountSkus: number
  unscoredCountEvents: number
  missingVendorCostSkus: number
  uncalibratedRiskPredictions: number
  latestToastDocument: string
  latestCount: string
  latestInvoice: string
}

type SnapshotManifest = {
  counts: {
    backboneRuns: number
    backbonePredictions: number
    backboneVerifications: number
  } & Record<string, number>
  [key: string]: unknown
}

type SnapshotArtifact = {
  label: string
  snapshotPath: string
  manifestPath: string
  sizeBytes: number
  manifest: SnapshotManifest
}

type SnapshotRestoreArtifact = {
  label: string
  env: string
  snapshotPath: string
  envDbPath: string
  forced: boolean
}

type MaintenanceSummary = {
  snapshot: {
    label: string
    path: string
    manifestPath: string
    sizeBytes: number
    integrity: 'ok'
  }
  audit: {
    checks: number
    failures: number
    warnings: number
  }
  gaps: BackboneGapSummary
  nextActions: Array<Record<string, unknown>>
  verification?: MaintenanceVerificationSummary
}

type MaintenanceVerificationSummary = {
  enabled: boolean
  status: 'passed' | 'failed'
  scenarios: number
  passed: number
  failed: number
  prefix: string
  worstValidationBottleMae: number
  worstRollingBottleMae: number
  minRollingLowStockRecall: number
  minRollingUncertaintyCoverage: number
  minRollingFeedbackBandCoverage: number
}

type HorizonRun = {
  horizonDays: number
  predictions: Array<{
    skuName: string
    unit: string
    predictedOnHand: number
    predictedDaysRemaining: number | null
    lowStockRisk: string
    confidence: number
    costSignal: string
  }>
}

type VerificationScenarioResult = {
  scenario: BackboneSimulationScenario
  validation: { envName: string; envDbPath: string; result: ReturnType<typeof runBackboneAccuracySimulation> }
  rolling: { envName: string; envDbPath: string; result: ReturnType<typeof runBackboneRollingBacktest> }
}

type EnvironmentPruneCandidate = {
  id: number
  env: string
  path: string
  lastSeen: string
  ageDays: number
  action: 'skip-unsafe-path' | 'keep-newest' | 'would-prune' | 'prune' | 'keep-young'
}

type PredictionEvidence = {
  positionWarningState?: string
  countAgeDays?: number | null
  shrinkDaily?: number
  vendorCost?: {
    vendorName?: string
    unitCost?: number | null
    packSize?: number
    price?: number | null
    leadTimeDays?: number
  } | null
  latestCost?: number | null
  highHistoricalCost?: number | null
  calibration?: {
    sampleCount?: number
    usageAdjustmentDaily?: number
    confidenceAdjustment?: number
    meanBottleError?: number
  }
  baselineDailyUsage?: number
  projectionMethod?: string
  trend?: {
    recentDailyUsage?: number
    priorDailyUsage?: number
    multiplier?: number
    recentActiveDays?: number
    priorActiveDays?: number
  }
  projectedUsage?: number
  uncertainty?: number
  targetAsOf?: string
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

export const backbonePlan = async (args: string[], context: CommandContext): Promise<void> => {
  const options = parseOptions(args)
  const horizons = options.horizons ?? [1, 7, 14, 30]
  context.terminal.title('Backbone horizon plan')

  await withBackendDb(context.config, async (db: any) => {
    const runs = horizons.map((horizonDays) =>
      runBackboneModel(db, {
        asOf: options.asOf,
        horizonDays,
        usageWindowDays: options.usageWindowDays,
        mode: 'live',
      }),
    )

    context.terminal.section('Horizon summary')
    context.terminal.table(
      runs.map((run) => ({
        horizon: `${run.horizonDays}d`,
        runId: run.runId,
        predictions: run.predictionCount,
        critical: run.predictedStockouts,
        lowStock: run.lowStockCount,
        costOptions: run.costCuttingOptions,
        feedback: run.feedbackItems,
        calibrated: run.calibratedSkus,
      })),
    )

    context.terminal.section('Escalating risks')
    context.terminal.table(buildHorizonRiskRows(runs))
  })
}

export const backboneStatus = async (_args: string[], context: CommandContext): Promise<void> => {
  context.terminal.title('Backbone status')
  await withBackendDb(context.config, async (db: any) => {
    const result = getLatestBackboneRun(db)
    if (!result) {
      context.terminal.warn('No Backbone runs yet.')
      context.terminal.subtitle('Run `bbk backbone run` or `bbk backbone simulate`.')
      renderListenerRuntimeLock(db, context)
      return
    }
    renderRun(result, context)
    renderListenerHealth(db, context)
    renderListenerRuntimeLock(db, context)
  })
}

export const backboneService = async (args: string[], context: CommandContext): Promise<void> => {
  const options = parseOptions(args)
  const label = options.label ?? 'com.barsbookkeeper.backbone'
  const intervalMs = options.intervalMs ?? 5 * 60 * 1000
  const serviceDir = resolve(context.config.dataDir, 'launchd')
  const logDir = resolve(context.config.dataDir, 'logs')
  const plistPath = resolve(serviceDir, `${label}.plist`)
  const stdoutPath = resolve(logDir, 'backbone-listener.out.log')
  const stderrPath = resolve(logDir, 'backbone-listener.err.log')
  const workingDirectory = resolve(context.cwd)

  context.terminal.title('Backbone launchd service')
  await mkdir(serviceDir, { recursive: true })
  await mkdir(logDir, { recursive: true })

  const plist = renderLaunchdPlist({
    label,
    workingDirectory,
    dataDir: context.config.dataDir,
    intervalMs,
    stdoutPath,
    stderrPath,
  })
  await writeFile(plistPath, plist, 'utf8')

  context.terminal.success(`LaunchAgent plist written: ${plistPath}`)
  context.terminal.dump({
    label,
    intervalMs,
    workingDirectory,
    dataDir: context.config.dataDir,
    stdoutPath,
    stderrPath,
  })
  context.terminal.section('Install commands')
  context.terminal.line(`mkdir -p "$HOME/Library/LaunchAgents"`)
  context.terminal.line(`cp "${plistPath}" "$HOME/Library/LaunchAgents/${label}.plist"`)
  context.terminal.line(`launchctl unload "$HOME/Library/LaunchAgents/${label}.plist" 2>/dev/null || true`)
  context.terminal.line(`launchctl load "$HOME/Library/LaunchAgents/${label}.plist"`)
  context.terminal.line(`launchctl start "${label}"`)
}

export const backboneMaintainService = async (args: string[], context: CommandContext): Promise<void> => {
  const options = parseOptions(args)
  const label = options.label ?? 'com.barsbookkeeper.backbone-maintenance'
  const intervalMs = options.intervalMs ?? 24 * 60 * 60 * 1000
  const serviceDir = resolve(context.config.dataDir, 'launchd')
  const logDir = resolve(context.config.dataDir, 'logs')
  const plistPath = resolve(serviceDir, `${label}.plist`)
  const stdoutPath = resolve(logDir, 'backbone-maintenance.out.log')
  const stderrPath = resolve(logDir, 'backbone-maintenance.err.log')
  const workingDirectory = resolve(context.cwd)
  const maintainArgs = buildScheduledMaintenanceArgs(options)

  context.terminal.title('Backbone maintenance launchd service')
  await mkdir(serviceDir, { recursive: true })
  await mkdir(logDir, { recursive: true })

  const plist = renderMaintenanceLaunchdPlist({
    label,
    workingDirectory,
    dataDir: context.config.dataDir,
    intervalMs,
    stdoutPath,
    stderrPath,
    maintainArgs,
  })
  await writeFile(plistPath, plist, 'utf8')

  context.terminal.success(`LaunchAgent plist written: ${plistPath}`)
  context.terminal.dump({
    label,
    intervalMs,
    startIntervalSeconds: Math.max(60, Math.round(intervalMs / 1000)),
    workingDirectory,
    dataDir: context.config.dataDir,
    stdoutPath,
    stderrPath,
    maintainArgs: maintainArgs.join(' '),
  })
  context.terminal.section('Install commands')
  context.terminal.line(`mkdir -p "$HOME/Library/LaunchAgents"`)
  context.terminal.line(`cp "${plistPath}" "$HOME/Library/LaunchAgents/${label}.plist"`)
  context.terminal.line(`launchctl unload "$HOME/Library/LaunchAgents/${label}.plist" 2>/dev/null || true`)
  context.terminal.line(`launchctl load "$HOME/Library/LaunchAgents/${label}.plist"`)
  context.terminal.line(`launchctl start "${label}"`)
}

export const backboneSnapshot = async (args: string[], context: CommandContext): Promise<void> => {
  const options = parseOptions(args)
  const label = cleanEnvName(options.label ?? `backbone-${new Date().toISOString().replace(/[:.]/g, '-')}`)

  context.terminal.title('Backbone snapshot')
  const snapshot = await createBackboneSnapshotArtifact(context, label)
  context.terminal.success(`Snapshot written: ${snapshot.snapshotPath}`)
  context.terminal.dump({
    label,
    snapshotPath: snapshot.snapshotPath,
    manifestPath: snapshot.manifestPath,
    sizeBytes: snapshot.sizeBytes,
    backboneRuns: snapshot.manifest.counts.backboneRuns,
    predictions: snapshot.manifest.counts.backbonePredictions,
    verifications: snapshot.manifest.counts.backboneVerifications,
  })
}

export const backboneSnapshotVerify = async (args: string[], context: CommandContext): Promise<void> => {
  const options = parseOptions(args)
  if (!options.label) throw new Error('snapshot_label_required')
  const label = cleanEnvName(options.label)
  const backupDir = resolve(context.config.dataDir, 'backups')
  const snapshotPath = resolve(backupDir, `${label}.sqlite`)
  const manifestPath = resolve(backupDir, `${label}.manifest.json`)

  context.terminal.title('Backbone snapshot verification')
  if (!existsSync(snapshotPath)) throw new Error(`backbone_snapshot_missing:${snapshotPath}`)
  if (!existsSync(manifestPath)) throw new Error(`backbone_snapshot_manifest_missing:${manifestPath}`)

  const manifest = parseJson<SnapshotManifest>(await readFile(manifestPath, 'utf8'), { counts: { backboneRuns: 0, backbonePredictions: 0, backboneVerifications: 0 } })
  const snapshotDb = openDatabase(snapshotPath)
  try {
    const integrityRow = snapshotDb.prepare('PRAGMA integrity_check').get()
    const integrity = String(integrityRow?.integrity_check ?? '')
    const counts = {
      backboneRuns: scalarCount(snapshotDb, 'backbone_runs'),
      backbonePredictions: scalarCount(snapshotDb, 'backbone_predictions'),
      backboneVerifications: scalarCount(snapshotDb, 'backbone_verifications'),
      inventoryEvents: scalarCount(snapshotDb, 'inventory_events'),
      listenerCycles: scalarCount(snapshotDb, 'backbone_listener_cycles'),
    }
    const mismatches = [
      countMismatch('backboneRuns', counts.backboneRuns, manifest.counts.backboneRuns),
      countMismatch('backbonePredictions', counts.backbonePredictions, manifest.counts.backbonePredictions),
      countMismatch('backboneVerifications', counts.backboneVerifications, manifest.counts.backboneVerifications),
    ].filter(Boolean)

    context.terminal.dump({
      label,
      snapshotPath,
      manifestPath,
      integrity,
      ...counts,
      manifestCreatedAt: manifest.createdAt ?? '',
    })

    if (integrity !== 'ok') throw new Error(`backbone_snapshot_integrity_failed:${integrity}`)
    if (mismatches.length > 0) throw new Error(`backbone_snapshot_manifest_mismatch:${mismatches.join(',')}`)
    context.terminal.success(`Snapshot ${label} verified.`)
  } finally {
    snapshotDb.close()
  }
}

export const backboneSnapshotRestore = async (args: string[], context: CommandContext): Promise<void> => {
  const options = parseOptions(args)
  if (!options.label) throw new Error('snapshot_label_required')
  if (!options.env) throw new Error('restore_environment_required')
  const label = cleanEnvName(options.label)
  const envName = cleanEnvName(options.env)

  context.terminal.title('Backbone snapshot restore')
  const restored = await restoreBackboneSnapshotArtifact(context, {
    label,
    envName,
    force: Boolean(options.force),
  })
  context.terminal.success(`Snapshot ${label} restored into environment ${envName}.`)
  context.terminal.dump(restored)
}

export const backboneMaintain = async (args: string[], context: CommandContext): Promise<void> => {
  const options = parseOptions(args)
  const startedAt = new Date().toISOString()
  const label = cleanEnvName(options.label ?? `maintenance-${startedAt.replace(/[:.]/g, '-')}`)
  const maxAgeMinutes = options.maxAgeMinutes ?? 60
  const maxRunAgeMinutes = options.maxRunAgeMinutes ?? maxAgeMinutes
  const maxCountAgeDays = options.maxCountAgeDays ?? 45
  const limit = options.limit ?? 12

  context.terminal.title('Backbone maintenance')
  const snapshot = await createBackboneSnapshotArtifact(context, label)
  await assertSnapshotReadable(snapshot.snapshotPath, snapshot.manifestPath)
  context.terminal.section('Snapshot gate')
  context.terminal.table([
    {
      label: snapshot.label,
      integrity: 'ok',
      sizeBytes: snapshot.sizeBytes,
      path: snapshot.snapshotPath,
      manifest: snapshot.manifestPath,
    },
  ])

  const verification = options.runVerify
    ? await runMaintenanceVerificationGate(context, {
        startedAt,
        label,
        options,
      })
    : undefined

  const summary = await withBackendDb(context.config, async (db: any): Promise<MaintenanceSummary> => {
    const auditChecks = buildBackboneAudit(db, { maxAgeMinutes, maxRunAgeMinutes, maxCountAgeDays })
    const auditFailures = auditChecks.filter((check) => check.status === 'fail')
    const auditWarnings = auditChecks.filter((check) => check.status === 'warn')
    const gapRows = buildBackboneGapRows(db, { limit, maxCountAgeDays })
    const gaps = buildBackboneGapSummary(db, 'base', gapRows, maxCountAgeDays)
    const nextActions = buildTrustActionRows(auditChecks, gapRows, limit)
    const maintenanceSummary: MaintenanceSummary = {
      snapshot: {
        label: snapshot.label,
        path: snapshot.snapshotPath,
        manifestPath: snapshot.manifestPath,
        sizeBytes: snapshot.sizeBytes,
        integrity: 'ok',
      },
      audit: {
        checks: auditChecks.length,
        failures: auditFailures.length,
        warnings: auditWarnings.length,
      },
      gaps,
      nextActions,
      verification,
    }

    context.terminal.section('Audit gate')
    context.terminal.table(auditChecks)
    context.terminal.section('Data gap gate')
    context.terminal.dump(gaps)
    if (gapRows.length > 0) context.terminal.table(gapRows)
    context.terminal.section('Command queue')
    context.terminal.table(nextActions)
    renderCommandLines(context, 'Commands', nextActions, 'action')

    persistMaintenanceRun(db, {
      startedAt,
      status: auditFailures.length > 0 || verification?.status === 'failed' ? 'failed' : auditWarnings.length > 0 ? 'warn' : 'passed',
      snapshot,
      auditFailures: auditFailures.length,
      auditWarnings: auditWarnings.length,
      gapCount: gapRows.length,
      summary: maintenanceSummary,
    })

    if (auditFailures.length > 0) {
      throw new Error(`backbone_maintenance_failed:${auditFailures.map((check) => check.check).join(',')}`)
    }
    if (verification?.status === 'failed') {
      throw new Error('backbone_maintenance_verify_failed')
    }
    return maintenanceSummary
  })

  context.terminal.status(
    summary.audit.warnings > 0 || summary.gaps.totalGaps > 0 ? 'warn' : 'ok',
    summary.audit.warnings > 0
      ? `Backbone maintenance passed with ${summary.audit.warnings} warning${summary.audit.warnings === 1 ? '' : 's'}.`
      : 'Backbone maintenance passed.',
    summary.gaps.totalGaps > 0 ? `${summary.gaps.totalGaps} data gap${summary.gaps.totalGaps === 1 ? '' : 's'} recorded` : undefined,
  )
}

export const backboneMaintainHistory = async (args: string[], context: CommandContext): Promise<void> => {
  const options = parseOptions(args)
  const limit = options.limit ?? 10
  context.terminal.title('Backbone maintenance history')

  await withBackendDb(context.config, async (db: any) => {
    const rows = db
      .prepare(
        `SELECT *
         FROM backbone_maintenance_runs
         ORDER BY completed_at DESC, id DESC
         LIMIT ?`,
      )
      .all(limit)

    if (rows.length === 0) {
      context.terminal.warn('No Backbone maintenance runs have been recorded yet.')
      context.terminal.subtitle('Run `bbk backbone maintain`.')
      return
    }

    const displayRows = rows.map((row: any) => {
        const summary = parseJson<MaintenanceSummary | null>(row.summary_json, null)
        return {
          id: row.id,
          status: row.status,
          completed: row.completed_at,
          snapshot: row.snapshot_label ?? summary?.snapshot.label ?? '',
          auditFailures: row.audit_failures,
          auditWarnings: row.audit_warnings,
          gaps: row.gap_count,
          recipeCoverage: summary?.gaps.toastRecipeCoveragePct ?? '',
          staleCounts: summary?.gaps.staleCountSkus ?? '',
          missingCosts: summary?.gaps.missingVendorCostSkus ?? '',
          verification: summary?.verification?.status ?? '',
          topAction: summary?.nextActions?.[0]?.action ?? '',
        }
      })
    context.terminal.table(displayRows)
    context.terminal.section('Snapshots')
    for (const row of displayRows) context.terminal.line(`${row.id}: ${row.snapshot}`)
    renderCommandLines(context, 'Top actions', displayRows, 'topAction')
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
        ground: sparseCountAction(prediction.skuName, prediction.unit),
      }))
    context.terminal.section('Order now')
    context.terminal.table(orderRows)
    renderCommandLines(context, 'Grounding commands', orderRows, 'ground')

    const costRows = result.predictions
      .filter((prediction) => prediction.costSignal !== 'none')
      .slice(0, 12)
      .map((prediction) => ({
        sku: prediction.skuName,
        signal: prediction.costSignal,
        confidence: prediction.confidence,
        learned: prediction.calibrationSamples,
        next: `bbk backbone explain --sku ${shellArg(prediction.skuName)}`,
      }))
    context.terminal.section('Cost cuts')
    context.terminal.table(costRows)
    renderCommandLines(context, 'Cost drill-down commands', costRows, 'next')
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

export const backboneEnvPrune = async (args: string[], context: CommandContext): Promise<void> => {
  const options = parseOptions(args)
  const olderThanDays = options.olderThanDays ?? 7
  const keep = options.keep ?? 20
  const dryRun = !options.force
  const environmentRoot = resolve(context.config.dataDir, 'environments')
  const now = Date.now()

  context.terminal.title('Backbone environment prune')
  context.terminal.dump({ dryRun, olderThanDays, keep, environmentRoot })

  await withBackendDb(context.config, async (db: any) => {
    const rows = db
      .prepare(
        `SELECT id, name, db_path, description, created_at, last_run_at
         FROM backbone_environments
         ORDER BY COALESCE(last_run_at, created_at) DESC, id DESC`,
      )
      .all()

    const candidates: EnvironmentPruneCandidate[] = rows
      .map((row: any, index: number) => {
        const lastSeen = String(row.last_run_at ?? row.created_at)
        const ageDays = Math.max(0, (now - new Date(lastSeen).getTime()) / 86_400_000)
        const envDir = resolve(dirname(String(row.db_path)))
        const safePath = isInsideDirectory(environmentRoot, envDir)
        const keepByRank = index < keep
        const oldEnough = ageDays >= olderThanDays
        return {
          id: toNumber(row.id),
          env: String(row.name),
          path: envDir,
          lastSeen,
          ageDays,
          action: !safePath
            ? 'skip-unsafe-path'
            : keepByRank
              ? 'keep-newest'
              : oldEnough
                ? dryRun
                  ? 'would-prune'
                  : 'prune'
                : 'keep-young',
        }
      })
      .filter((row: EnvironmentPruneCandidate) => row.action === 'would-prune' || row.action === 'prune' || row.action === 'skip-unsafe-path')

    if (candidates.length === 0) {
      context.terminal.success('No Backbone environments matched prune policy.')
      return
    }

    context.terminal.table(
      candidates.map((row) => ({
        env: row.env,
        action: row.action,
        ageDays: round(row.ageDays, 2),
        lastSeen: row.lastSeen,
        path: row.path,
      })),
    )

    const prunable = candidates.filter((row) => row.action === 'would-prune' || row.action === 'prune')
    if (dryRun) {
      context.terminal.warn(`Dry run only; add --force to delete ${prunable.length} environment${prunable.length === 1 ? '' : 's'}.`)
      return
    }

    for (const row of prunable) {
      await rm(row.path, { force: true, recursive: true })
      db.prepare('DELETE FROM backbone_environments WHERE id = ?').run(row.id)
    }
    context.terminal.success(`Pruned ${prunable.length} Backbone environment${prunable.length === 1 ? '' : 's'}.`)
  })
}

export const backboneAccuracy = async (args: string[], context: CommandContext): Promise<void> => {
  const options = parseOptions(args)
  const minSamples = options.minSamples ?? 1
  context.terminal.title('Backbone accuracy')

  await withBackboneTargetDb(context, options, (db, target) => {
    const summary = buildAccuracySummary(db, target)
    context.terminal.dump(summary)

    if (summary.feedbackSamples === 0) {
      context.terminal.warn('No Backbone feedback has been scored yet.')
      context.terminal.subtitle('Run `bbk backbone simulate --env <name>` or add a later hand count after a prediction run.')
      return
    }

    context.terminal.status(
      summary.feedbackSamples >= minSamples ? 'ok' : 'warn',
      `feedback sample floor: ${summary.feedbackSamples}/${minSamples}`,
    )
    context.terminal.status(
      summary.bottleMae <= 0.25 ? 'ok' : 'warn',
      `bottle MAE: ${summary.bottleMae}`,
      summary.bottleMae <= 0.25 ? 'within target' : 'above 0.25 bottle target',
    )
    context.terminal.status(
      summary.feedbackBandCoverage >= 0.8 ? 'ok' : 'warn',
      `feedback band coverage: ${summary.feedbackBandCoverage}`,
      `${summary.outOfBandSamples} out-of-band sample${summary.outOfBandSamples === 1 ? '' : 's'}`,
    )

    context.terminal.section('SKU accuracy')
    context.terminal.table(buildSkuAccuracyRows(db))
  })
}

export const backboneMemory = async (args: string[], context: CommandContext): Promise<void> => {
  const options = parseOptions(args)
  const limit = options.limit ?? 12
  context.terminal.title('Backbone memory')

  await withBackboneTargetDb(context, options, (db, target) => {
    const summary = buildAccuracySummary(db, target)
    context.terminal.dump(summary)

    context.terminal.section('Learned SKU corrections')
    const corrections = db
      .prepare(
        `SELECT s.name AS sku,
                c.sample_count,
                c.mean_error_quantity,
                c.mean_abs_error_quantity,
                c.mean_bottle_error,
                c.usage_adjustment_daily,
                c.confidence_adjustment,
                c.updated_at,
                MAX(f.evaluated_at) AS latest_feedback
         FROM backbone_calibrations c
         JOIN skus s ON s.id = c.sku_id
         LEFT JOIN backbone_feedback f ON f.sku_id = c.sku_id
         GROUP BY c.sku_id
         ORDER BY c.mean_bottle_error DESC, c.sample_count DESC, s.name
         LIMIT ?`,
      )
      .all(limit)

    if (corrections.length === 0) {
      context.terminal.warn('No learned calibration memory yet.')
      context.terminal.subtitle('Run `bbk backbone simulate --env <name>` or add later bottle counts after prediction runs.')
    } else {
      context.terminal.table(
        corrections.map((row: any) => {
          const meanError = toNumber(row.mean_error_quantity)
          return {
            sku: row.sku,
            samples: row.sample_count,
            direction: meanError > 0 ? 'predicted too low' : meanError < 0 ? 'predicted too high' : 'centered',
            meanError: round(meanError, 2),
            bottleMae: round(toNumber(row.mean_bottle_error), 4),
            dailyCorrection: round(toNumber(row.usage_adjustment_daily), 4),
            confidenceAdjust: round(toNumber(row.confidence_adjustment), 3),
            latestFeedback: row.latest_feedback ?? row.updated_at ?? '',
          }
        }),
      )
    }

    context.terminal.section('Recent feedback')
    context.terminal.table(buildRecentFeedbackRows(db, limit))

    context.terminal.section('Ungrounded current risks')
    context.terminal.table(buildUngroundedRiskRows(db, limit))
  })
}

export const backboneDrift = async (args: string[], context: CommandContext): Promise<void> => {
  const options = parseOptions(args)
  const limit = options.limit ?? 12
  const thresholds = {
    minSamples: options.minSamples ?? 3,
    maxBottleMae: options.maxBottleMae ?? 0.25,
    maxBiasBottles: options.maxBiasBottles ?? 0.2,
    maxFeedbackAgeDays: options.maxFeedbackAgeDays ?? options.maxCountAgeDays ?? 45,
  }
  context.terminal.title('Backbone learning drift')

  await withBackboneTargetDb(context, options, (db, target) => {
    const summary = buildLearningDriftSummary(db, target, thresholds)
    context.terminal.dump(summary)

    if (summary.feedbackSamples === 0) {
      context.terminal.warn('No Backbone feedback has been scored yet.')
      context.terminal.subtitle('Run `bbk backbone simulate --env <name>` or add a later hand count after a prediction run.')
      return
    }

    context.terminal.status(
      summary.feedbackSamples >= thresholds.minSamples ? 'ok' : 'warn',
      `feedback sample floor: ${summary.feedbackSamples}/${thresholds.minSamples}`,
    )
    context.terminal.status(
      summary.bottleMae <= thresholds.maxBottleMae ? 'ok' : 'warn',
      `overall bottle MAE: ${summary.bottleMae}`,
      summary.bottleMae <= thresholds.maxBottleMae ? 'within drift target' : `above ${thresholds.maxBottleMae} bottle target`,
    )
    context.terminal.status(
      Math.abs(summary.biasBottles) <= thresholds.maxBiasBottles ? 'ok' : 'warn',
      `bias: ${summary.biasBottles} bottles`,
      Math.abs(summary.biasBottles) <= thresholds.maxBiasBottles ? 'centered' : `outside +/-${thresholds.maxBiasBottles} bottle target`,
    )
    context.terminal.status(
      summary.feedbackAgeDays !== null && summary.feedbackAgeDays <= thresholds.maxFeedbackAgeDays ? 'ok' : 'warn',
      summary.feedbackAgeDays === null
        ? 'feedback freshness: no scored feedback'
        : `feedback freshness: ${summary.feedbackAgeDays}d old`,
      `max ${thresholds.maxFeedbackAgeDays}d`,
    )
    context.terminal.status(
      summary.trendDelta <= 0.05 ? 'ok' : 'warn',
      `recent-vs-prior bottle MAE delta: ${summary.trendDelta}`,
      summary.previousBottleMae > 0 ? `recent ${summary.recentBottleMae}; prior ${summary.previousBottleMae}` : 'not enough prior samples for trend',
    )
    context.terminal.status(
      summary.feedbackBandCoverage >= 0.8 ? 'ok' : 'warn',
      `feedback band coverage: ${summary.feedbackBandCoverage}`,
      `${summary.outOfBandSamples} out-of-band sample${summary.outOfBandSamples === 1 ? '' : 's'}`,
    )

    context.terminal.section('SKU drift watchlist')
    context.terminal.table(buildLearningDriftRows(db, limit))
  })
}

export const backboneIntake = async (args: string[], context: CommandContext): Promise<void> => {
  const options = parseOptions(args)
  const limit = options.limit ?? 12
  context.terminal.title('Backbone Toast intake')

  await withBackboneTargetDb(context, options, (db, target) => {
    const summary = buildToastIntakeSummary(db, target)
    context.terminal.dump(summary)

    if (summary.toastDocuments === 0) {
      context.terminal.warn('No Toast sale documents have been ingested yet.')
      context.terminal.subtitle('Run `bbk toast pull` or `bbk backbone listen --once`.')
      return
    }

    context.terminal.status(
      summary.recipeCoveragePct >= 95 ? 'ok' : 'warn',
      `Toast recipe coverage: ${summary.recipeCoveragePct}%`,
      summary.missingRecipeDocuments > 0
        ? `${summary.missingRecipeDocuments} Toast item${summary.missingRecipeDocuments === 1 ? '' : 's'} still need recipe mapping`
        : 'all ingested Toast sale documents produced consumption events',
    )

    context.terminal.section('Missing recipe backlog')
    context.terminal.table(buildMissingRecipeRows(db, limit))

    context.terminal.section('Suggested recipe mappings')
    context.terminal.table(buildRecipeSuggestionRows(db, limit))

    context.terminal.section('Recent mapped Toast consumption')
    context.terminal.table(buildMappedToastRows(db, limit))
  })
}

export const backboneRecipeSuggestions = async (args: string[], context: CommandContext): Promise<void> => {
  const options = parseOptions(args)
  const limit = options.limit ?? 12
  context.terminal.title('Backbone recipe suggestions')

  await withBackboneTargetDb(context, options, (db, target) => {
    const rows = buildRecipeSuggestionRows(db, limit)
    context.terminal.dump({
      target,
      suggestions: rows.length,
      note: 'Review before applying; suggestions do not mutate inventory.',
    })

    if (rows.length === 0) {
      context.terminal.success('No conservative Toast recipe suggestions found.')
      context.terminal.subtitle('Run `bbk backbone intake` to inspect unmapped Toast items and recipe coverage.')
      return
    }

    context.terminal.table(rows)
    renderCommandLines(context, 'Commands', rows, 'command')
  })
}

export const backboneGaps = async (args: string[], context: CommandContext): Promise<void> => {
  const options = parseOptions(args)
  const limit = options.limit ?? 12
  const maxCountAgeDays = options.maxCountAgeDays ?? 45
  context.terminal.title('Backbone data gaps')

  await withBackboneTargetDb(context, options, (db, target) => {
    const rows = buildBackboneGapRows(db, { limit, maxCountAgeDays })
    const summary = buildBackboneGapSummary(db, target, rows, maxCountAgeDays)
    context.terminal.dump(summary)

    if (rows.length === 0) {
      context.terminal.success('No high-value Backbone data gaps found.')
      return
    }

    context.terminal.section('Prioritized gaps')
    context.terminal.table(rows)
    renderCommandLines(context, 'Commands', rows, 'action')
  })
}

export const backboneExplain = async (args: string[], context: CommandContext): Promise<void> => {
  const options = parseOptions(args)
  context.terminal.title('Backbone explanation')

  await withBackboneTargetDb(context, options, (db, target) => {
    const row = latestPredictionRow(db, options.sku)
    if (!row) {
      context.terminal.warn(options.sku ? `No Backbone prediction found for ${options.sku}.` : 'No Backbone predictions yet.')
      context.terminal.subtitle('Run `bbk backbone run`, `bbk backbone listen --once`, or `bbk backbone simulate --env <name>`.')
      return
    }

    const evidence = parseJson<PredictionEvidence>(row.evidence_json, {})
    context.terminal.dump({
      target,
      runId: row.run_id,
      asOf: row.as_of,
      sku: row.sku_name,
      risk: row.low_stock_risk,
      confidence: row.confidence,
      predictedOnHand: `${row.predicted_on_hand} ${row.unit}`,
      predictionBand: `${row.predicted_lower_on_hand ?? row.predicted_on_hand}..${row.predicted_upper_on_hand ?? row.predicted_on_hand} ${row.unit}`,
      stockoutProbability: row.stockout_probability ?? '',
      onHand: `${row.on_hand} ${row.unit}`,
      daysRemaining: row.predicted_days_remaining ?? '',
      costSignal: row.cost_signal,
    })

    context.terminal.section('Projection evidence')
    context.terminal.table([
      {
        method: evidence.projectionMethod ?? 'unknown',
        baselineDailyUsage: evidence.baselineDailyUsage ?? '',
        projectedUsage: evidence.projectedUsage ?? '',
        uncertainty: evidence.uncertainty ?? '',
        avgDailyUsage: row.avg_daily_usage,
        targetAsOf: evidence.targetAsOf ?? '',
        countAgeDays: evidence.countAgeDays ?? '',
        trendMultiplier: evidence.trend?.multiplier ?? '',
        recentDailyUsage: evidence.trend?.recentDailyUsage ?? '',
        priorDailyUsage: evidence.trend?.priorDailyUsage ?? '',
        sourceWarning: evidence.positionWarningState ?? '',
      },
    ])

    context.terminal.section('Cost evidence')
    context.terminal.table([
      {
        vendor: evidence.vendorCost?.vendorName ?? '',
        vendorUnitCost: evidence.vendorCost?.unitCost ?? '',
        leadTimeDays: evidence.vendorCost?.leadTimeDays ?? '',
        latestUnitCost: evidence.latestCost ?? '',
        highHistoricalUnitCost: evidence.highHistoricalCost ?? '',
        shrinkDaily: evidence.shrinkDaily ?? '',
      },
    ])

    context.terminal.section('Calibration evidence')
    context.terminal.table([
      {
        samples: evidence.calibration?.sampleCount ?? 0,
        usageAdjustDaily: evidence.calibration?.usageAdjustmentDaily ?? 0,
        confidenceAdjust: evidence.calibration?.confidenceAdjustment ?? 0,
        meanBottleError: evidence.calibration?.meanBottleError ?? 0,
      },
    ])
  })
}

export const backboneAudit = async (args: string[], context: CommandContext): Promise<void> => {
  const options = parseOptions(args)
  const maxAgeMinutes = options.maxAgeMinutes ?? 60
  const maxRunAgeMinutes = options.maxRunAgeMinutes ?? maxAgeMinutes
  const maxCountAgeDays = options.maxCountAgeDays ?? 45
  context.terminal.title('Backbone audit')

  await withBackendDb(context.config, async (db: any) => {
    const checks = buildBackboneAudit(db, { maxAgeMinutes, maxRunAgeMinutes, maxCountAgeDays })
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

export const backboneTrust = async (args: string[], context: CommandContext): Promise<void> => {
  const options = parseOptions(args)
  const limit = options.limit ?? 8
  const maxAgeMinutes = options.maxAgeMinutes ?? 60
  const maxRunAgeMinutes = options.maxRunAgeMinutes ?? maxAgeMinutes
  const maxCountAgeDays = options.maxCountAgeDays ?? 45
  context.terminal.title('Backbone trust report')

  await withBackendDb(context.config, async (db: any) => {
    const auditChecks = buildBackboneAudit(db, { maxAgeMinutes, maxRunAgeMinutes, maxCountAgeDays })
    const failures = auditChecks.filter((check) => check.status === 'fail')
    const warnings = auditChecks.filter((check) => check.status === 'warn')
    const gapRows = buildBackboneGapRows(db, { limit, maxCountAgeDays })
    const gapSummary = buildBackboneGapSummary(db, 'base', gapRows, maxCountAgeDays)
    const predictionRisk = buildPredictionTrustSummary(db)
    const learningDrift = buildLearningDriftSummary(db, 'base', {
      minSamples: 3,
      maxBottleMae: 0.25,
      maxBiasBottles: 0.2,
      maxFeedbackAgeDays: maxCountAgeDays,
    })
    const latestVerification = latestVerificationTrustRow(db)
    const latestMaintenance = latestMaintenanceTrustRow(db)
    const readinessScore = Math.max(0, Math.min(100, 100 - failures.length * 25 - warnings.length * 7 - Math.min(gapRows.length, 8) * 3))
    const trustStatus = failures.length > 0
      ? 'fail'
      : warnings.length > 0 || gapRows.length > 0 || latestVerification.status !== 'passed'
        ? 'warn'
        : 'ready'

    context.terminal.dump({
      status: trustStatus,
      readinessScore,
      auditFailures: failures.length,
      auditWarnings: warnings.length,
      dataGaps: gapRows.length,
      latestRunId: predictionRisk.latestRunId,
      predictionCount: predictionRisk.predictionCount,
      nonOkRisks: predictionRisk.nonOkRisks,
      maxStockoutProbability: predictionRisk.maxStockoutProbability,
      avgStockoutProbability: predictionRisk.avgStockoutProbability,
      feedbackBandCoverage: learningDrift.feedbackBandCoverage,
      outOfBandFeedback: learningDrift.outOfBandSamples,
      latestVerification: latestVerification.status,
      latestMaintenance: latestMaintenance.status,
      toastRecipeCoveragePct: gapSummary.toastRecipeCoveragePct,
      latestCount: gapSummary.latestCount,
      latestInvoice: gapSummary.latestInvoice,
    })

    context.terminal.section('Trust gates')
    context.terminal.table([
      {
        gate: 'audit',
        status: failures.length > 0 ? 'fail' : warnings.length > 0 ? 'warn' : 'pass',
        detail: `${failures.length} fail, ${warnings.length} warn`,
      },
      {
        gate: 'verification',
        status: latestVerification.status || 'missing',
        detail: latestVerification.detail,
      },
      {
        gate: 'maintenance',
        status: latestMaintenance.status || 'missing',
        detail: latestMaintenance.detail,
      },
      {
        gate: 'uncertainty risk',
        status: predictionRisk.maxStockoutProbability >= 0.45 ? 'warn' : predictionRisk.predictionCount > 0 ? 'pass' : 'missing',
        detail: `${predictionRisk.nonOkRisks} non-ok risk${predictionRisk.nonOkRisks === 1 ? '' : 's'}; max stockout ${predictionRisk.maxStockoutProbability}`,
      },
      {
        gate: 'calibration coverage',
        status: learningDrift.feedbackSamples > 0 && learningDrift.feedbackBandCoverage >= 0.8 ? 'pass' : 'warn',
        detail: learningDrift.feedbackSamples > 0
          ? `${learningDrift.feedbackBandCoverage} band coverage; ${learningDrift.outOfBandSamples} out-of-band feedback sample${learningDrift.outOfBandSamples === 1 ? '' : 's'}`
          : 'no scored feedback with prediction bands',
      },
      {
        gate: 'data gaps',
        status: gapRows.length > 0 ? 'warn' : 'pass',
        detail: `${gapRows.length} prioritized gap${gapRows.length === 1 ? '' : 's'}`,
      },
    ])

    const actionRows = buildTrustActionRows(auditChecks, gapRows, limit)
    context.terminal.section('Next actions')
    context.terminal.table(actionRows)
    renderCommandLines(context, 'Command queue', actionRows, 'action')

    if (failures.length > 0) {
      throw new Error(`backbone_trust_failed:${failures.map((check) => check.check).join(',')}`)
    }
    context.terminal.status(
      trustStatus === 'ready' ? 'ok' : 'warn',
      trustStatus === 'ready'
        ? 'Backbone trust report is ready.'
        : `Backbone trust report passed with ${warnings.length + gapRows.length} warning signal${warnings.length + gapRows.length === 1 ? '' : 's'}.`,
    )
  })
}

const latestPredictionRow = (db: Db, sku?: string): any | null => {
  const skuFilter = sku ? 'AND p.sku_name LIKE ?' : ''
  const params = sku ? [`%${sku}%`] : []
  return db
    .prepare(
      `SELECT p.*, r.as_of
       FROM backbone_predictions p
       JOIN backbone_runs r ON r.id = p.run_id
       WHERE r.status = 'completed'
         ${skuFilter}
       ORDER BY r.created_at DESC,
         CASE p.low_stock_risk
           WHEN 'critical' THEN 0
           WHEN 'high' THEN 1
           WHEN 'low' THEN 2
           WHEN 'watch' THEN 3
           ELSE 4
         END,
         p.predicted_on_hand,
         p.id
       LIMIT 1`,
    )
    .get(...params)
}

const buildPredictionTrustSummary = (db: Db): {
  latestRunId: number | ''
  predictionCount: number
  nonOkRisks: number
  maxStockoutProbability: number
  avgStockoutProbability: number
} => {
  const latestRun = db
    .prepare(
      `SELECT id
       FROM backbone_runs
       WHERE status = 'completed'
       ORDER BY id DESC
       LIMIT 1`,
    )
    .get()
  if (!latestRun) {
    return {
      latestRunId: '',
      predictionCount: 0,
      nonOkRisks: 0,
      maxStockoutProbability: 0,
      avgStockoutProbability: 0,
    }
  }

  const row = db
    .prepare(
      `SELECT COUNT(*) AS prediction_count,
              SUM(CASE WHEN low_stock_risk != 'ok' THEN 1 ELSE 0 END) AS non_ok_risks,
              MAX(COALESCE(stockout_probability, 0)) AS max_stockout_probability,
              AVG(COALESCE(stockout_probability, 0)) AS avg_stockout_probability
       FROM backbone_predictions
       WHERE run_id = ?`,
    )
    .get(toNumber(latestRun.id))

  return {
    latestRunId: toNumber(latestRun.id),
    predictionCount: toNumber(row?.prediction_count),
    nonOkRisks: toNumber(row?.non_ok_risks),
    maxStockoutProbability: round(toNumber(row?.max_stockout_probability), 3),
    avgStockoutProbability: round(toNumber(row?.avg_stockout_probability), 3),
  }
}

const latestVerificationTrustRow = (db: Db): { status: string; detail: string } => {
  const row = db
    .prepare(
      `SELECT status, scenario_count, passed_scenarios, failed_scenarios, completed_at, summary_json
       FROM backbone_verifications
       ORDER BY completed_at DESC, id DESC
       LIMIT 1`,
    )
    .get()
  if (!row) return { status: 'missing', detail: 'no persisted verification run' }

  const summary = parseJson<{
    worstRollingBottleMae?: number
    minRollingUncertaintyCoverage?: number
    minRollingFeedbackBandCoverage?: number
    maxRollingMeanBandBottles?: number
  }>(row.summary_json, {})
  const detail = `${row.passed_scenarios}/${row.scenario_count} scenarios at ${row.completed_at}; rollingMae ${summary.worstRollingBottleMae ?? ''}; uncertaintyCoverage ${summary.minRollingUncertaintyCoverage ?? ''}; feedbackBandCoverage ${summary.minRollingFeedbackBandCoverage ?? ''}; bandBottles ${summary.maxRollingMeanBandBottles ?? ''}`
  return { status: String(row.status), detail }
}

const latestMaintenanceTrustRow = (db: Db): { status: string; detail: string } => {
  const row = db
    .prepare(
      `SELECT status, completed_at, audit_failures, audit_warnings, gap_count, snapshot_label
       FROM backbone_maintenance_runs
       ORDER BY completed_at DESC, id DESC
       LIMIT 1`,
    )
    .get()
  if (!row) return { status: 'missing', detail: 'no persisted maintenance run' }
  return {
    status: String(row.status),
    detail: `${row.snapshot_label ?? 'maintenance'} at ${row.completed_at}; ${row.audit_failures} fail, ${row.audit_warnings} warn, ${row.gap_count} gap${toNumber(row.gap_count) === 1 ? '' : 's'}`,
  }
}

const buildTrustActionRows = (
  auditChecks: AuditCheck[],
  gapRows: Array<Record<string, unknown>>,
  limit: number,
): Array<Record<string, unknown>> => {
  const rows: Array<Record<string, unknown>> = []
  for (const check of auditChecks.filter((row) => row.status !== 'pass')) {
    rows.push({
      priority: check.status === 'fail' ? 'critical' : 'medium',
      source: 'audit',
      target: check.check,
      detail: check.detail,
      action: trustActionForAuditCheck(check.check),
    })
  }
  for (const gap of gapRows) {
    rows.push({
      priority: gap.priority,
      source: 'gap',
      target: gap.target,
      detail: gap.detail,
      action: gap.action,
    })
  }
  return rows
    .sort((left, right) => gapPriorityRank(String(left.priority)) - gapPriorityRank(String(right.priority)))
    .slice(0, limit)
}

const trustActionForAuditCheck = (check: string): string => {
  if (check.includes('listener')) return 'bbk backbone listen --once'
  if (check.includes('prediction')) return 'bbk backbone run'
  if (check.includes('count')) return 'bbk backbone gaps --limit 8'
  if (check.includes('recipe')) return 'bbk backbone recipe-suggestions --limit 8'
  if (check.includes('feedback') || check.includes('drift')) return 'bbk backbone verify --env acceptance --days 60'
  if (check.includes('cursor')) return 'bbk toast pull'
  if (check.includes('cost')) return 'bbk backbone gaps --limit 8'
  if (check.includes('low-stock')) return 'bbk backbone actions'
  return 'bbk backbone status'
}

const renderCommandLines = (
  context: CommandContext,
  title: string,
  rows: Array<Record<string, unknown>>,
  field: string,
): void => {
  const commands = rows
    .map((row) => String(row[field] ?? '').trim())
    .filter((value, index, all) => value.startsWith('bbk ') && all.indexOf(value) === index)
  if (commands.length === 0) return
  context.terminal.section(title)
  for (const command of commands) context.terminal.line(command)
}

const shellArg = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

const sparseCountAction = (skuName: string, unit?: string): string => {
  const cleanUnit = unit?.trim() || 'units'
  if (cleanUnit.toLowerCase() === 'ml' && /\b\d+(?:\.\d+)?\s*(?:l|ml)\b/i.test(skuName)) {
    return `bbk ingest note ${shellArg(`${skuName} <actual bottles> bottles`)} --dry-run`
  }
  return `bbk ingest note ${shellArg(`${skuName} <actual ${cleanUnit}> ${cleanUnit}`)} --dry-run`
}

const horizonRiskRank: Record<string, number> = {
  ok: 0,
  watch: 1,
  low: 2,
  high: 3,
  critical: 4,
}

const buildHorizonRiskRows = (runs: HorizonRun[]): Array<Record<string, unknown>> => {
  const bySku = new Map<string, Array<HorizonRun['predictions'][number] & { horizonDays: number }>>()
  for (const run of runs) {
    for (const prediction of run.predictions) {
      const rows = bySku.get(prediction.skuName) ?? []
      rows.push({ ...prediction, horizonDays: run.horizonDays })
      bySku.set(prediction.skuName, rows)
    }
  }

  return Array.from(bySku.entries())
    .map(([sku, predictions]) => {
      const sorted = predictions.sort((left, right) => left.horizonDays - right.horizonDays)
      const worst = sorted.reduce((current, prediction) =>
        (horizonRiskRank[prediction.lowStockRisk] ?? 0) > (horizonRiskRank[current.lowStockRisk] ?? 0) ? prediction : current,
      )
      const firstNonOk = sorted.find((prediction) => prediction.lowStockRisk !== 'ok')
      const latest = sorted[sorted.length - 1] ?? worst
      return {
        sku,
        firstRisk: firstNonOk ? `${firstNonOk.lowStockRisk}@${firstNonOk.horizonDays}d` : 'none',
        worstRisk: `${worst.lowStockRisk}@${worst.horizonDays}d`,
        finalPredicted: `${latest.predictedOnHand} ${latest.unit}`,
        daysRemaining: latest.predictedDaysRemaining ?? '',
        confidence: latest.confidence,
        cost: sorted.find((prediction) => prediction.costSignal !== 'none')?.costSignal ?? 'none',
      }
    })
    .filter((row) => row.firstRisk !== 'none' || row.cost !== 'none')
    .sort((left, right) => {
      const leftRisk = String(left.worstRisk).split('@')[0]
      const rightRisk = String(right.worstRisk).split('@')[0]
      return (horizonRiskRank[rightRisk] ?? 0) - (horizonRiskRank[leftRisk] ?? 0)
    })
    .slice(0, 15)
}

const buildSnapshotManifest = (
  db: any,
  input: {
    label: string
    snapshotPath: string
    manifestPath: string
    sizeBytes: number
    dataDir: string
    dbPath: string
  },
): SnapshotManifest => {
  const latestRun = db
    .prepare(
      `SELECT id, as_of, completed_at, metrics_json
       FROM backbone_runs
       WHERE status = 'completed'
       ORDER BY id DESC
       LIMIT 1`,
    )
    .get()
  const latestVerification = db
    .prepare(
      `SELECT id, status, completed_at, summary_json
       FROM backbone_verifications
       ORDER BY completed_at DESC, id DESC
       LIMIT 1`,
    )
    .get()
  const cursor = db.prepare('SELECT last_start, last_end, last_source, updated_at FROM backbone_toast_cursor WHERE id = 1').get()

  return {
    label: input.label,
    createdAt: new Date().toISOString(),
    dataDir: input.dataDir,
    dbPath: input.dbPath,
    snapshotPath: input.snapshotPath,
    manifestPath: input.manifestPath,
    sizeBytes: input.sizeBytes,
    counts: {
      sourceDocuments: scalarCount(db, 'source_documents'),
      inventoryEvents: scalarCount(db, 'inventory_events'),
      backboneRuns: scalarCount(db, 'backbone_runs'),
      backbonePredictions: scalarCount(db, 'backbone_predictions'),
      backboneFeedback: scalarCount(db, 'backbone_feedback'),
      backboneCalibrations: scalarCount(db, 'backbone_calibrations'),
      backboneListenerCycles: scalarCount(db, 'backbone_listener_cycles'),
      backboneVerifications: scalarCount(db, 'backbone_verifications'),
      backboneMaintenanceRuns: scalarCount(db, 'backbone_maintenance_runs'),
      openReviewTasks: toNumber(db.prepare("SELECT COUNT(*) AS count FROM openclaw_decisions WHERE state = 'needs_review'").get()?.count),
    },
    latestRun: latestRun
      ? {
          id: toNumber(latestRun.id),
          asOf: latestRun.as_of,
          completedAt: latestRun.completed_at,
          metrics: parseJson<Record<string, unknown>>(latestRun.metrics_json, {}),
        }
      : null,
    latestVerification: latestVerification
      ? {
          id: toNumber(latestVerification.id),
          status: latestVerification.status,
          completedAt: latestVerification.completed_at,
          summary: parseJson<Record<string, unknown>>(latestVerification.summary_json, {}),
        }
      : null,
    toastCursor: cursor
      ? {
          lastStart: cursor.last_start,
          lastEnd: cursor.last_end,
          source: cursor.last_source,
          updatedAt: cursor.updated_at,
        }
      : null,
  }
}

const createBackboneSnapshotArtifact = async (context: CommandContext, label: string): Promise<SnapshotArtifact> => {
  const backupDir = resolve(context.config.dataDir, 'backups')
  const snapshotPath = resolve(backupDir, `${label}.sqlite`)
  const manifestPath = resolve(backupDir, `${label}.manifest.json`)

  await mkdir(backupDir, { recursive: true })
  if (existsSync(snapshotPath) || existsSync(manifestPath)) {
    throw new Error(`backbone_snapshot_exists:${label}`)
  }

  return withBackendDb(context.config, async (db: any) => {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    db.exec(`VACUUM INTO '${sqlString(snapshotPath)}'`)
    const snapshotStat = await stat(snapshotPath)
    const manifest = buildSnapshotManifest(db, {
      label,
      snapshotPath,
      manifestPath,
      sizeBytes: snapshotStat.size,
      dataDir: context.config.dataDir,
      dbPath: context.config.dbPath,
    })
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

    return {
      label,
      snapshotPath,
      manifestPath,
      sizeBytes: snapshotStat.size,
      manifest,
    }
  })
}

const restoreBackboneSnapshotArtifact = async (
  context: CommandContext,
  input: {
    label: string
    envName: string
    force: boolean
  },
): Promise<SnapshotRestoreArtifact> => {
  const backupDir = resolve(context.config.dataDir, 'backups')
  const snapshotPath = resolve(backupDir, `${input.label}.sqlite`)
  const manifestPath = resolve(backupDir, `${input.label}.manifest.json`)
  const environmentRoot = resolve(context.config.dataDir, 'environments')
  const envDir = resolve(environmentRoot, input.envName)
  const envDbPath = resolve(envDir, 'barsbookkeeper.sqlite')

  if (!existsSync(snapshotPath)) throw new Error(`backbone_snapshot_missing:${snapshotPath}`)
  if (!existsSync(manifestPath)) throw new Error(`backbone_snapshot_manifest_missing:${manifestPath}`)
  if (!isInsideDirectory(environmentRoot, envDir)) throw new Error(`unsafe_restore_environment_path:${envDir}`)
  if (existsSync(envDir) && !input.force) throw new Error(`backbone_restore_environment_exists:${input.envName}:use_--force_to_replace`)

  await assertSnapshotReadable(snapshotPath, manifestPath)
  if (input.force) await rm(envDir, { recursive: true, force: true })
  await mkdir(envDir, { recursive: true })
  await copyFile(snapshotPath, envDbPath)

  const restoredDb = openDatabase(envDbPath)
  try {
    migrateDatabase(restoredDb)
  } finally {
    restoredDb.close()
  }

  await withBackendDb(context.config, async (controlDb: any) => {
    ensureBackboneEnvironment(controlDb, {
      name: input.envName,
      dbPath: envDbPath,
      description: `Restored from Backbone snapshot ${input.label}`,
    })
  })

  return {
    label: input.label,
    env: input.envName,
    snapshotPath,
    envDbPath,
    forced: input.force,
  }
}

const scalarCount = (db: any, table: string): number =>
  toNumber(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count)

const countMismatch = (name: string, actual: number, expected: number | undefined): string =>
  expected === undefined || actual === expected ? '' : `${name}:${actual}!=${expected}`

const assertSnapshotReadable = async (snapshotPath: string, manifestPath: string): Promise<void> => {
  const manifest = parseJson<SnapshotManifest>(await readFile(manifestPath, 'utf8'), { counts: { backboneRuns: 0, backbonePredictions: 0, backboneVerifications: 0 } })
  const snapshotDb = openDatabase(snapshotPath)
  try {
    const integrity = String(snapshotDb.prepare('PRAGMA integrity_check').get()?.integrity_check ?? '')
    const mismatches = [
      countMismatch('backboneRuns', scalarCount(snapshotDb, 'backbone_runs'), manifest.counts.backboneRuns),
      countMismatch('backbonePredictions', scalarCount(snapshotDb, 'backbone_predictions'), manifest.counts.backbonePredictions),
      countMismatch('backboneVerifications', scalarCount(snapshotDb, 'backbone_verifications'), manifest.counts.backboneVerifications),
    ].filter(Boolean)
    if (integrity !== 'ok') throw new Error(`backbone_snapshot_integrity_failed:${integrity}`)
    if (mismatches.length > 0) throw new Error(`backbone_snapshot_manifest_mismatch:${mismatches.join(',')}`)
  } finally {
    snapshotDb.close()
  }
}

const sqlString = (value: string): string => value.replace(/'/g, "''")

const renderLaunchdPlist = (input: {
  label: string
  workingDirectory: string
  dataDir: string
  intervalMs: number
  stdoutPath: string
  stderrPath: string
}): string => {
  const intervalMs = Math.max(1000, input.intervalMs)
  const args = [
    '/usr/bin/env',
    'npm',
    'run',
    'bbk',
    '--',
    'backbone',
    'listen',
    '--interval-ms',
    String(intervalMs),
  ]
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(input.label)}</string>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(input.workingDirectory)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((arg) => `    <string>${xmlEscape(arg)}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>BBK_DATA_DIR</key>
    <string>${xmlEscape(input.dataDir)}</string>
    <key>OPENCLAW_USE_CODEX</key>
    <string>${xmlEscape(process.env.OPENCLAW_USE_CODEX ?? '0')}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(input.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(input.stderrPath)}</string>
</dict>
</plist>
`
}

const renderMaintenanceLaunchdPlist = (input: {
  label: string
  workingDirectory: string
  dataDir: string
  intervalMs: number
  stdoutPath: string
  stderrPath: string
  maintainArgs: string[]
}): string => {
  const intervalSeconds = Math.max(60, Math.round(input.intervalMs / 1000))
  const args = [
    '/usr/bin/env',
    'npm',
    'run',
    'bbk',
    '--',
    'backbone',
    'maintain',
    ...input.maintainArgs,
  ]
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(input.label)}</string>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(input.workingDirectory)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((arg) => `    <string>${xmlEscape(arg)}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>BBK_DATA_DIR</key>
    <string>${xmlEscape(input.dataDir)}</string>
    <key>OPENCLAW_USE_CODEX</key>
    <string>${xmlEscape(process.env.OPENCLAW_USE_CODEX ?? '0')}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>${intervalSeconds}</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(input.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(input.stderrPath)}</string>
</dict>
</plist>
`
}

const buildScheduledMaintenanceArgs = (options: ParsedOptions): string[] => {
  const args: string[] = []
  if (options.runVerify) args.push('--verify')
  if (options.scenario) args.push('--scenario', options.scenario)
  if (options.days !== undefined) args.push('--days', String(options.days))
  if (options.countCadenceDays !== undefined) args.push('--count-cadence-days', String(options.countCadenceDays))
  if (options.horizonDays !== undefined) args.push('--horizon-days', String(options.horizonDays))
  if (options.warmupDays !== undefined) args.push('--warmup-days', String(options.warmupDays))
  if (options.trainingDays !== undefined) args.push('--training-days', String(options.trainingDays))
  if (options.maxAgeMinutes !== undefined) args.push('--max-age-minutes', String(options.maxAgeMinutes))
  if (options.maxRunAgeMinutes !== undefined) args.push('--max-run-age-minutes', String(options.maxRunAgeMinutes))
  if (options.maxCountAgeDays !== undefined) args.push('--max-count-age-days', String(options.maxCountAgeDays))
  if (options.limit !== undefined) args.push('--limit', String(options.limit))
  return args
}

const xmlEscape = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')

const withBackboneTargetDb = async <T>(
  context: CommandContext,
  options: ParsedOptions,
  work: (db: Db, target: string) => T,
): Promise<T> => {
  if (!options.env) {
    return withBackendDb(context.config, async (db: any) => work(db, 'base'))
  }

  return withBackendDb(context.config, async (controlDb: any) => {
    const environment = controlDb
      .prepare('SELECT name, db_path FROM backbone_environments WHERE name = ?')
      .get(options.env)
    if (!environment) throw new Error(`backbone_environment_not_found:${options.env}`)

    const dbPath = String(environment.db_path)
    if (!existsSync(dbPath)) throw new Error(`backbone_environment_db_missing:${options.env}`)

    const envDb = openDatabase(dbPath)
    try {
      migrateDatabase(envDb)
      return work(envDb, String(environment.name))
    } finally {
      envDb.close()
    }
  })
}

const buildAccuracySummary = (db: Db, target: string): AccuracySummary => {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS feedback_samples,
              COUNT(DISTINCT sku_id) AS calibrated_skus,
              AVG(bottle_error) AS bottle_mae,
              MAX(bottle_error) AS max_bottle_error,
              AVG(absolute_error_quantity) AS mean_abs_error_qty,
              AVG(error_quantity) AS bias_qty,
              AVG(CASE WHEN in_band IS NULL THEN NULL ELSE in_band END) AS feedback_band_coverage,
              SUM(CASE WHEN in_band = 0 THEN 1 ELSE 0 END) AS out_of_band_samples,
              MAX(evaluated_at) AS latest_feedback
       FROM backbone_feedback`,
    )
    .get()

  return {
    target,
    feedbackSamples: toNumber(row?.feedback_samples),
    calibratedSkus: toNumber(row?.calibrated_skus),
    bottleMae: round(toNumber(row?.bottle_mae), 4),
    maxBottleError: round(toNumber(row?.max_bottle_error), 4),
    meanAbsErrorQty: round(toNumber(row?.mean_abs_error_qty), 2),
    biasQty: round(toNumber(row?.bias_qty), 2),
    feedbackBandCoverage: round(toNumber(row?.feedback_band_coverage), 3),
    outOfBandSamples: toNumber(row?.out_of_band_samples),
    latestFeedback: row?.latest_feedback ? String(row.latest_feedback) : '',
  }
}

const buildLearningDriftSummary = (
  db: Db,
  target: string,
  thresholds: LearningDriftSummary['thresholds'],
): LearningDriftSummary => {
  const aggregate = db
    .prepare(
      `WITH feedback_with_bottles AS (
         SELECT f.*,
                COALESCE(
                  (SELECT MIN(vi.pack_size)
                   FROM vendor_items vi
                   WHERE vi.sku_id = f.sku_id AND vi.active = 1),
                  1000
                ) AS bottle_size
         FROM backbone_feedback f
       )
       SELECT COUNT(*) AS feedback_samples,
              COUNT(DISTINCT sku_id) AS calibrated_skus,
              AVG(bottle_error) AS bottle_mae,
              AVG(error_quantity / NULLIF(bottle_size, 0)) AS bias_bottles,
              AVG(CASE WHEN in_band IS NULL THEN NULL ELSE in_band END) AS feedback_band_coverage,
              SUM(CASE WHEN in_band = 0 THEN 1 ELSE 0 END) AS out_of_band_samples,
              MAX(evaluated_at) AS latest_feedback
       FROM feedback_with_bottles`,
    )
    .get()
  const feedbackSamples = toNumber(aggregate?.feedback_samples)
  const latestFeedback = aggregate?.latest_feedback ? String(aggregate.latest_feedback) : ''
  const feedbackAgeDays = latestFeedback ? round(ageMinutes(latestFeedback) / (24 * 60), 2) : null
  const staleCalibrationSkus = toNumber(
    db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM backbone_calibrations c
         WHERE NOT EXISTS (
           SELECT 1
           FROM backbone_feedback f
           WHERE f.sku_id = c.sku_id
             AND datetime(f.evaluated_at) >= datetime('now', '-' || ? || ' days')
         )`,
      )
      .get(thresholds.maxFeedbackAgeDays)?.count,
  )

  const orderedFeedback = db
    .prepare(
      `SELECT bottle_error
       FROM backbone_feedback
       ORDER BY datetime(evaluated_at) DESC, id DESC`,
    )
    .all()
    .map((row: any) => toNumber(row.bottle_error))
  const recentWindowSize = Math.min(5, Math.ceil(orderedFeedback.length / 2))
  const recent = orderedFeedback.slice(0, recentWindowSize)
  const previous = orderedFeedback.slice(recentWindowSize, recentWindowSize * 2)
  const recentBottleMae = mean(recent)
  const previousBottleMae = mean(previous)
  const trendDelta = previousBottleMae > 0 ? round(recentBottleMae - previousBottleMae, 4) : 0
  const bottleMae = round(toNumber(aggregate?.bottle_mae), 4)
  const biasBottles = round(toNumber(aggregate?.bias_bottles), 4)
  const feedbackBandCoverage = round(toNumber(aggregate?.feedback_band_coverage), 3)
  const outOfBandSamples = toNumber(aggregate?.out_of_band_samples)
  const warnings = [
    feedbackSamples < thresholds.minSamples ? 'sample floor not met' : '',
    bottleMae > thresholds.maxBottleMae ? 'overall bottle MAE above threshold' : '',
    Math.abs(biasBottles) > thresholds.maxBiasBottles ? 'directional bias above threshold' : '',
    feedbackAgeDays === null || feedbackAgeDays > thresholds.maxFeedbackAgeDays ? 'feedback is stale' : '',
    trendDelta > 0.05 ? 'recent error is worsening' : '',
    feedbackSamples > 0 && feedbackBandCoverage < 0.8 ? 'prediction band coverage below target' : '',
  ].filter(Boolean)

  return {
    target,
    feedbackSamples,
    calibratedSkus: toNumber(aggregate?.calibrated_skus),
    staleCalibrationSkus,
    bottleMae,
    biasBottles,
    recentBottleMae: round(recentBottleMae, 4),
    previousBottleMae: round(previousBottleMae, 4),
    trendDelta,
    feedbackBandCoverage,
    outOfBandSamples,
    latestFeedback,
    feedbackAgeDays,
    thresholds,
    status: warnings.length === 0 ? 'pass' : 'warn',
    statusReason: warnings.length === 0 ? 'learning feedback is centered and fresh' : warnings.join('; '),
  }
}

const buildLearningDriftRows = (db: Db, limit: number): Array<Record<string, unknown>> => {
  const rows = db
    .prepare(
      `WITH feedback_with_bottles AS (
         SELECT f.*,
                COALESCE(
                  (SELECT MIN(vi.pack_size)
                   FROM vendor_items vi
                   WHERE vi.sku_id = f.sku_id AND vi.active = 1),
                  1000
                ) AS bottle_size
         FROM backbone_feedback f
       )
       SELECT s.name AS sku,
              COUNT(f.id) AS samples,
              AVG(f.bottle_error) AS bottle_mae,
              MAX(f.bottle_error) AS max_bottle_error,
              AVG(f.error_quantity / NULLIF(f.bottle_size, 0)) AS bias_bottles,
              AVG(CASE WHEN f.in_band IS NULL THEN NULL ELSE f.in_band END) AS band_coverage,
              SUM(CASE WHEN f.in_band = 0 THEN 1 ELSE 0 END) AS out_of_band,
              SUM(CASE WHEN f.error_quantity > 0 THEN 1 ELSE 0 END) AS predicted_too_low,
              SUM(CASE WHEN f.error_quantity < 0 THEN 1 ELSE 0 END) AS predicted_too_high,
              c.usage_adjustment_daily,
              c.confidence_adjustment,
              MAX(f.evaluated_at) AS latest_feedback
       FROM feedback_with_bottles f
       JOIN skus s ON s.id = f.sku_id
       LEFT JOIN backbone_calibrations c ON c.sku_id = f.sku_id
       GROUP BY f.sku_id
       ORDER BY ABS(bias_bottles) DESC, bottle_mae DESC, samples DESC, sku
       LIMIT ?`,
    )
    .all(limit)

  return rows.map((row: any) => {
    const biasBottles = toNumber(row.bias_bottles)
    return {
      sku: row.sku,
      samples: row.samples,
      bottleMae: round(toNumber(row.bottle_mae), 4),
      maxBottleError: round(toNumber(row.max_bottle_error), 4),
      biasBottles: round(biasBottles, 4),
      direction: biasBottles > 0 ? 'predicted too low' : biasBottles < 0 ? 'predicted too high' : 'centered',
      bandCoverage: round(toNumber(row.band_coverage), 3),
      outOfBand: toNumber(row.out_of_band),
      tooLow: row.predicted_too_low,
      tooHigh: row.predicted_too_high,
      dailyAdjust: round(toNumber(row.usage_adjustment_daily), 4),
      confidenceAdjust: round(toNumber(row.confidence_adjustment), 3),
      latest: row.latest_feedback ?? '',
    }
  })
}

const buildSkuAccuracyRows = (db: Db): Array<Record<string, unknown>> => {
  const rows = db
    .prepare(
      `SELECT s.name AS sku,
              COUNT(f.id) AS samples,
              AVG(f.bottle_error) AS bottle_mae,
              MAX(f.bottle_error) AS max_bottle_error,
              AVG(f.error_quantity) AS bias_qty,
              AVG(CASE WHEN f.in_band IS NULL THEN NULL ELSE f.in_band END) AS band_coverage,
              SUM(CASE WHEN f.in_band = 0 THEN 1 ELSE 0 END) AS out_of_band,
              c.usage_adjustment_daily,
              c.confidence_adjustment
       FROM backbone_feedback f
       JOIN skus s ON s.id = f.sku_id
       LEFT JOIN backbone_calibrations c ON c.sku_id = f.sku_id
       GROUP BY f.sku_id
       ORDER BY bottle_mae DESC, samples DESC, sku`,
    )
    .all()

  return rows.map((row: any) => ({
    sku: row.sku,
    samples: row.samples,
    mae: round(toNumber(row.bottle_mae), 4),
    max: round(toNumber(row.max_bottle_error), 4),
    biasQty: round(toNumber(row.bias_qty), 2),
    bandCoverage: round(toNumber(row.band_coverage), 3),
    out: toNumber(row.out_of_band),
    daily: round(toNumber(row.usage_adjustment_daily), 4),
    conf: round(toNumber(row.confidence_adjustment), 3),
  }))
}

const buildRecentFeedbackRows = (db: Db, limit: number): Array<Record<string, unknown>> => {
  const rows = db
    .prepare(
      `SELECT s.name AS sku,
              f.predicted_on_hand,
              f.predicted_lower_on_hand,
              f.predicted_upper_on_hand,
              f.actual_on_hand,
              f.error_quantity,
              f.bottle_error,
              f.in_band,
              f.evaluated_at
       FROM backbone_feedback f
       JOIN skus s ON s.id = f.sku_id
       ORDER BY f.evaluated_at DESC, f.id DESC
       LIMIT ?`,
    )
    .all(limit)

  return rows.map((row: any) => ({
    sku: row.sku,
    predicted: round(toNumber(row.predicted_on_hand), 2),
    band: `${round(toNumber(row.predicted_lower_on_hand, row.predicted_on_hand), 2)}-${round(toNumber(row.predicted_upper_on_hand, row.predicted_on_hand), 2)}`,
    actual: round(toNumber(row.actual_on_hand), 2),
    error: round(toNumber(row.error_quantity), 2),
    bottleError: round(toNumber(row.bottle_error), 4),
    inBand: toNumber(row.in_band) === 1,
    evaluated: row.evaluated_at ?? '',
  }))
}

const buildToastIntakeSummary = (db: Db, target: string): ToastIntakeSummary => {
  const documents = db
    .prepare(
      `SELECT COUNT(*) AS toast_documents,
              MAX(sd.document_date) AS latest_toast_document
       FROM source_documents sd
       JOIN sources s ON s.id = sd.source_id
       WHERE s.kind = 'toast'
         AND sd.document_type = 'toast_sale'`,
    )
    .get()
  const mappedDocuments = toNumber(
    db
      .prepare(
        `SELECT COUNT(DISTINCT source_document_id) AS count
         FROM evidence_items
         WHERE evidence_type = 'toast_sale'
           AND source_document_id IS NOT NULL`,
      )
      .get()?.count,
  )
  const missingRecipeDocuments = toNumber(
    db
      .prepare(
        `SELECT COUNT(DISTINCT source_document_id) AS count
         FROM evidence_items
         JOIN openclaw_decisions d ON d.id = evidence_items.decision_id
         WHERE evidence_type = 'toast_missing_recipe'
           AND source_document_id IS NOT NULL
           AND d.state = 'needs_review'`,
      )
      .get()?.count,
  )
  const saleEvents = db
    .prepare(
      `SELECT COUNT(*) AS imported_sale_events,
              COALESCE(SUM(ABS(e.quantity)), 0) AS consumed_quantity,
              MAX(e.occurred_at) AS latest_sale_event
       FROM inventory_events e
       JOIN source_documents sd ON sd.id = e.source_document_id
       JOIN sources s ON s.id = sd.source_id
       WHERE s.kind = 'toast'
         AND e.event_type = 'sale'`,
    )
    .get()
  const openReviews = toNumber(
    db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM evidence_items e
         JOIN openclaw_decisions d ON d.id = e.decision_id
         WHERE e.evidence_type = 'toast_missing_recipe'
           AND d.state = 'needs_review'`,
      )
      .get()?.count,
  )
  const toastDocuments = toNumber(documents?.toast_documents)
  return {
    target,
    toastDocuments,
    mappedDocuments,
    missingRecipeDocuments,
    recipeCoveragePct: toastDocuments === 0 ? 100 : round((mappedDocuments / toastDocuments) * 100, 1),
    importedSaleEvents: toNumber(saleEvents?.imported_sale_events),
    consumedQuantity: round(toNumber(saleEvents?.consumed_quantity), 2),
    openMissingRecipeReviews: openReviews,
    latestToastDocument: documents?.latest_toast_document ? String(documents.latest_toast_document) : '',
    latestSaleEvent: saleEvents?.latest_sale_event ? String(saleEvents.latest_sale_event) : '',
  }
}

const buildMissingRecipeRows = (db: Db, limit: number): Array<Record<string, unknown>> => {
  const rows = db
    .prepare(
      `SELECT e.summary, e.payload_json, e.amount, e.occurred_at
       FROM evidence_items e
       JOIN openclaw_decisions d ON d.id = e.decision_id
       WHERE e.evidence_type = 'toast_missing_recipe'
         AND d.state = 'needs_review'
       ORDER BY e.occurred_at DESC, e.id DESC
       LIMIT ?`,
    )
    .all(Math.max(limit * 3, limit))
  const grouped = new Map<string, { menuItem: string; sales: number; occurrences: number; latest: string; summary: string }>()

  for (const row of rows as any[]) {
    const payload = parseJson<Record<string, unknown>>(row.payload_json, {})
    const menuItem = String(payload.menuItem ?? payload.menuItemName ?? payload.displayName ?? row.summary)
    const existing = grouped.get(menuItem) ?? {
      menuItem,
      sales: 0,
      occurrences: 0,
      latest: '',
      summary: String(row.summary),
    }
    existing.sales += toNumber(row.amount)
    existing.occurrences += 1
    existing.latest = existing.latest && existing.latest > String(row.occurred_at) ? existing.latest : String(row.occurred_at)
    grouped.set(menuItem, existing)
  }

  return Array.from(grouped.values())
    .sort((left, right) => right.occurrences - left.occurrences || right.sales - left.sales)
    .slice(0, limit)
    .map((row) => ({
      menuItem: row.menuItem,
      occurrences: row.occurrences,
      sales: round(row.sales, 2),
      latest: row.latest,
      action: 'map recipe',
    }))
}

const buildRecipeSuggestionRows = (db: Db, limit: number): Array<Record<string, unknown>> =>
  suggestToastRecipeMappings(db, limit).map((suggestion) => ({
    menuItem: suggestion.menuItemName,
    suggestedSku: suggestion.suggestedSkuName,
    qty: suggestion.suggestedQuantity,
    unit: suggestion.suggestedUnit,
    confidence: suggestion.confidence,
    occurrences: suggestion.occurrences,
    sales: suggestion.sales,
    reason: suggestion.reason,
    command: suggestion.command,
  }))

const buildMappedToastRows = (db: Db, limit: number): Array<Record<string, unknown>> => {
  const rows = db
    .prepare(
      `SELECT e.occurred_at,
              sku.name AS sku,
              ABS(e.quantity) AS consumed,
              e.unit,
              ei.summary
       FROM inventory_events e
       JOIN skus sku ON sku.id = e.sku_id
       LEFT JOIN evidence_items ei ON ei.id = e.evidence_item_id
       JOIN source_documents sd ON sd.id = e.source_document_id
       JOIN sources s ON s.id = sd.source_id
       WHERE s.kind = 'toast'
         AND e.event_type = 'sale'
       ORDER BY e.occurred_at DESC, e.id DESC
       LIMIT ?`,
    )
    .all(limit)

  return rows.map((row: any) => ({
    occurred: row.occurred_at,
    sku: row.sku,
    consumed: round(toNumber(row.consumed), 2),
    unit: row.unit,
    evidence: row.summary ?? '',
  }))
}

const buildBackboneGapSummary = (
  db: Db,
  target: string,
  rows: Array<Record<string, unknown>>,
  maxCountAgeDays: number,
): BackboneGapSummary => {
  const intake = buildToastIntakeSummary(db, target)
  const latestCount = db
    .prepare("SELECT MAX(occurred_at) AS latest FROM inventory_events WHERE event_type = 'adjustment'")
    .get()
  const latestInvoice = db
    .prepare("SELECT MAX(occurred_at) AS latest FROM inventory_events WHERE event_type = 'purchase'")
    .get()
  return {
    target,
    totalGaps: rows.length,
    critical: rows.filter((row) => row.priority === 'critical').length,
    high: rows.filter((row) => row.priority === 'high').length,
    medium: rows.filter((row) => row.priority === 'medium').length,
    low: rows.filter((row) => row.priority === 'low').length,
    toastRecipeCoveragePct: intake.recipeCoveragePct,
    staleCountSkus: countStaleCountSkus(db, maxCountAgeDays),
    unscoredCountEvents: unscoredCountFeedback(db, { maxTargetAgeDays: 14, limit: 1_000 }).length,
    missingVendorCostSkus: countMissingVendorCostSkus(db),
    uncalibratedRiskPredictions: buildUngroundedRiskRows(db, 1_000).length,
    latestToastDocument: intake.latestToastDocument,
    latestCount: latestCount?.latest ? String(latestCount.latest) : '',
    latestInvoice: latestInvoice?.latest ? String(latestInvoice.latest) : '',
  }
}

const buildBackboneGapRows = (
  db: Db,
  input: { limit: number; maxCountAgeDays: number },
): Array<Record<string, unknown>> => {
  const rows: Array<Record<string, unknown>> = []
  const recipeSuggestions = suggestToastRecipeMappings(db, input.limit)

  for (const row of buildMissingRecipeRows(db, input.limit)) {
    const suggestion = recipeSuggestions.find((candidate) => candidate.menuItemName === row.menuItem)
    rows.push({
      priority: 'critical',
      gap: 'map Toast recipe',
      target: row.menuItem,
      detail: `${row.occurrences} unresolved sale${row.occurrences === 1 ? '' : 's'}; ${row.sales} Toast unit${row.sales === 1 ? '' : 's'}`,
      action: suggestion?.command ?? `bbk toast map-recipe ${shellArg(String(row.menuItem))} <sku> <qty> <unit>`,
    })
  }

  rows.push(...buildStaleCountGapRows(db, input.maxCountAgeDays, input.limit))
  rows.push(...buildUnscoredCountGapRows(db, input.limit))
  rows.push(...buildMissingVendorCostGapRows(db, input.limit))
  rows.push(...buildUngroundedRiskRows(db, input.limit).map((row) => ({
    priority: riskGapPriority(String(row.risk)),
    gap: 'ground risky prediction',
    target: row.sku,
    detail: `${row.risk} risk; predicted ${row.predicted}; confidence ${row.confidence}`,
    action: sparseCountAction(String(row.sku), String(row.unit ?? '')),
  })))

  const seen = new Set<string>()
  return rows
    .filter((row) => {
      const key = `${row.gap}:${row.target}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((left, right) => gapPriorityRank(String(left.priority)) - gapPriorityRank(String(right.priority)))
    .slice(0, input.limit)
}

const buildStaleCountGapRows = (
  db: Db,
  maxCountAgeDays: number,
  limit: number,
): Array<Record<string, unknown>> => {
  const rows = db
    .prepare(
      `WITH latest_run AS (
         SELECT id
         FROM backbone_runs
         WHERE status = 'completed'
         ORDER BY created_at DESC, id DESC
         LIMIT 1
       ),
       latest_counts AS (
         SELECT sku_id, MAX(occurred_at) AS latest_count
         FROM inventory_events
         WHERE event_type = 'adjustment'
         GROUP BY sku_id
       )
       SELECT s.name AS sku,
              s.unit,
              latest_counts.latest_count,
              p.low_stock_risk,
              p.predicted_on_hand,
              p.confidence
       FROM skus s
       LEFT JOIN latest_counts ON latest_counts.sku_id = s.id
       LEFT JOIN backbone_predictions p
         ON p.sku_id = s.id
        AND p.run_id = (SELECT id FROM latest_run)
       WHERE EXISTS (
         SELECT 1
         FROM inventory_events e
         WHERE e.sku_id = s.id
       )
       ORDER BY
         CASE p.low_stock_risk
           WHEN 'critical' THEN 0
           WHEN 'high' THEN 1
           WHEN 'low' THEN 2
           WHEN 'watch' THEN 3
           ELSE 4
         END,
         s.name
       LIMIT ?`,
    )
    .all(Math.max(limit * 3, limit))

  return rows
    .map((row: any) => {
      const ageDays = row.latest_count ? round(ageMinutes(String(row.latest_count)) / (24 * 60), 1) : Number.POSITIVE_INFINITY
      return { row, ageDays }
    })
    .filter(({ ageDays }) => ageDays > maxCountAgeDays)
    .slice(0, limit)
    .map(({ row, ageDays }: { row: any; ageDays: number }) => {
      const risk = row.low_stock_risk ? String(row.low_stock_risk) : 'unknown'
      return {
        priority: risk === 'critical' || risk === 'high' ? 'high' : 'medium',
        gap: 'refresh sparse count',
        target: row.sku,
        detail: row.latest_count
          ? `latest count ${ageDays}d old; risk ${risk}`
          : `no hand count yet; risk ${risk}`,
        action: sparseCountAction(String(row.sku), String(row.unit ?? '')),
      }
    })
}

const buildUnscoredCountGapRows = (db: Db, limit: number): Array<Record<string, unknown>> =>
  unscoredCountFeedback(db, { limit }).map((row) => ({
    priority: row.reason === 'stale_prediction_target' ? 'high' : 'medium',
    gap: 'restore prediction cadence',
    target: row.skuName,
    detail: row.reason === 'stale_prediction_target'
      ? `count ${row.occurredAt} has no recent prediction target; latest target ${row.latestTargetAt} was ${row.targetAgeDays}d old`
      : `count ${row.occurredAt} has no completed prediction target to score`,
    action: 'bbk backbone listen --once',
  })).slice(0, limit)

const buildMissingVendorCostGapRows = (db: Db, limit: number): Array<Record<string, unknown>> => {
  const rows = db
    .prepare(
      `SELECT s.name AS sku,
              COUNT(DISTINCT e.id) AS event_count,
              MAX(e.occurred_at) AS latest_event
       FROM skus s
       JOIN inventory_events e ON e.sku_id = s.id
       WHERE NOT EXISTS (
         SELECT 1
         FROM vendor_items vi
         WHERE vi.sku_id = s.id
           AND vi.active = 1
           AND vi.price IS NOT NULL
       )
       GROUP BY s.id
       ORDER BY event_count DESC, latest_event DESC, s.name
       LIMIT ?`,
    )
    .all(limit)

  return rows.map((row: any) => ({
    priority: 'medium',
    gap: 'add invoice/vendor cost',
    target: row.sku,
    detail: `${row.event_count} inventory event${toNumber(row.event_count) === 1 ? '' : 's'} but no active priced vendor item`,
    action: `bbk ingest invoice ${shellArg(`./invoices/${String(row.sku).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'vendor'}-invoice.csv`)}`,
  }))
}

const countStaleCountSkus = (db: Db, maxCountAgeDays: number): number =>
  buildStaleCountGapRows(db, maxCountAgeDays, 1_000).length

const countMissingVendorCostSkus = (db: Db): number =>
  toNumber(
    db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM skus s
         WHERE EXISTS (
           SELECT 1
           FROM inventory_events e
           WHERE e.sku_id = s.id
         )
           AND NOT EXISTS (
             SELECT 1
             FROM vendor_items vi
             WHERE vi.sku_id = s.id
               AND vi.active = 1
               AND vi.price IS NOT NULL
           )`,
      )
      .get()?.count,
  )

const gapPriorityRank = (priority: string): number => {
  if (priority === 'critical') return 0
  if (priority === 'high') return 1
  if (priority === 'medium') return 2
  return 3
}

const riskGapPriority = (risk: string): 'critical' | 'high' | 'medium' | 'low' => {
  if (risk === 'critical') return 'critical'
  if (risk === 'high') return 'high'
  if (risk === 'low' || risk === 'watch') return 'medium'
  return 'low'
}

const buildUngroundedRiskRows = (db: Db, limit: number): Array<Record<string, unknown>> => {
  const latestRun = db
    .prepare(
      `SELECT id
       FROM backbone_runs
       WHERE status = 'completed'
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
    )
    .get()
  if (!latestRun) return []

  const rows = db
    .prepare(
      `SELECT p.sku_name,
              p.low_stock_risk,
              p.predicted_on_hand,
              p.predicted_days_remaining,
              p.confidence,
              p.unit,
              p.cost_signal
       FROM backbone_predictions p
       LEFT JOIN backbone_calibrations c ON c.sku_id = p.sku_id
       WHERE p.run_id = ?
         AND c.sku_id IS NULL
         AND (p.low_stock_risk != 'ok' OR p.cost_signal != 'none')
       ORDER BY
         CASE p.low_stock_risk
           WHEN 'critical' THEN 0
           WHEN 'high' THEN 1
           WHEN 'low' THEN 2
           WHEN 'watch' THEN 3
           ELSE 4
         END,
         p.predicted_on_hand,
         p.sku_name
       LIMIT ?`,
    )
    .all(toNumber(latestRun.id), limit)

  return rows.map((row: any) => ({
    sku: row.sku_name,
    risk: row.low_stock_risk,
    predicted: round(toNumber(row.predicted_on_hand), 2),
    days: row.predicted_days_remaining ?? '',
    confidence: row.confidence,
    unit: row.unit,
    cost: row.cost_signal,
  }))
}

const readRuntimeLock = (db: any, name = 'backbone-listener'): RuntimeLockState => {
  const row = db.prepare('SELECT * FROM backbone_runtime_locks WHERE name = ?').get(name)
  if (!row) {
    return {
      present: false,
      name,
      owner: '',
      acquiredAt: '',
      heartbeatAt: '',
      expiresAt: '',
      state: 'absent',
      ageMinutes: Number.POSITIVE_INFINITY,
    }
  }
  const expiresAt = String(row.expires_at)
  const heartbeatAt = String(row.heartbeat_at)
  return {
    present: true,
    name,
    owner: String(row.owner),
    acquiredAt: String(row.acquired_at),
    heartbeatAt,
    expiresAt,
    state: new Date(expiresAt).getTime() > Date.now() ? 'active' : 'stale',
    ageMinutes: ageMinutes(heartbeatAt),
  }
}

const renderListenerRuntimeLock = (db: any, context: CommandContext): void => {
  const lock = readRuntimeLock(db)
  context.terminal.section('Listener runtime lock')
  context.terminal.table([
    {
      state: lock.state,
      owner: lock.owner,
      heartbeatAgeMinutes: Number.isFinite(lock.ageMinutes) ? Number(lock.ageMinutes.toFixed(1)) : '',
      heartbeatAt: lock.heartbeatAt,
      expiresAt: lock.expiresAt,
    },
  ])
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
  const cycles = options.once ? 1 : options.cycles ?? Number.POSITIVE_INFINITY
  const intervalMs = options.intervalMs ?? 5 * 60 * 1000
  const recoverStaleMinutes = options.recoverStaleMinutes ?? Math.max(15, Math.ceil((intervalMs * 3) / 60_000))
  const lockTtlMinutes = options.lockTtlMinutes ?? Math.max(5, recoverStaleMinutes, Math.ceil((intervalMs * 3) / 60_000))
  const lockOwner = `${hostname()}:${process.pid}`
  let stopped = false
  let completed = 0
  let lockAcquired = false

  const stop = () => {
    stopped = true
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)

  context.terminal.title('Backbone listener')
  context.terminal.subtitle(
    options.once
      ? `one-shot; interval: ${intervalMs}ms`
      : Number.isFinite(cycles)
      ? `cycles: ${cycles}; interval: ${intervalMs}ms`
      : `continuous; interval: ${intervalMs}ms`,
  )

  const db = openDatabase(context.config.dbPath)
  try {
    migrateDatabase(db)
    const recovered = recoverStaleListenerCycles(db, recoverStaleMinutes)
    if (recovered > 0) {
      context.terminal.warn(`Recovered ${recovered} stale Backbone listener cycle${recovered === 1 ? '' : 's'}.`)
    }
    acquireRuntimeLock(db, {
      name: 'backbone-listener',
      owner: lockOwner,
      ttlMinutes: lockTtlMinutes,
    })
    lockAcquired = true
    context.terminal.status('ok', 'listener lock acquired', `${lockOwner}; ttl ${lockTtlMinutes}m`)
    while (!stopped && completed < cycles) {
      heartbeatRuntimeLock(db, {
        name: 'backbone-listener',
        owner: lockOwner,
        ttlMinutes: lockTtlMinutes,
      })
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
      heartbeatRuntimeLock(db, {
        name: 'backbone-listener',
        owner: lockOwner,
        ttlMinutes: lockTtlMinutes,
      })
      await sleep(intervalMs)
    }
    context.terminal.success(`Backbone listener stopped after ${completed} cycle${completed === 1 ? '' : 's'}.`)
  } finally {
    if (lockAcquired) releaseRuntimeLock(db, { name: 'backbone-listener', owner: lockOwner })
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
      trainingDays: options.trainingDays ?? (options.days ? options.days - 1 : undefined),
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
      uncertaintyCoverage: result.uncertaintyCoverage,
      meanBandBottles: result.meanBandBottles,
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

export const backboneBacktest = async (args: string[], context: CommandContext): Promise<void> => {
  const options = parseOptions(args)
  const envName = options.env ?? `backtest-${options.scenario ?? 'steady'}-${new Date().toISOString().replace(/[:.]/g, '-')}`
  const envDir = resolve(context.config.dataDir, 'environments', envName)
  const envDbPath = resolve(envDir, 'barsbookkeeper.sqlite')

  context.terminal.title('Backbone rolling backtest')
  await mkdir(envDir, { recursive: true })

  await withBackendDb(context.config, async (controlDb: any) => {
    ensureBackboneEnvironment(controlDb, {
      name: envName,
      dbPath: envDbPath,
      description: 'Isolated Backbone rolling backtest sandbox',
    })
  })

  const db = openDatabase(envDbPath)
  try {
    migrateDatabase(db)
    const result = runBackboneRollingBacktest(db, {
      startAt: options.asOf,
      days: options.days,
      horizonDays: options.horizonDays,
      countCadenceDays: options.countCadenceDays,
      warmupDays: options.warmupDays,
      scenario: options.scenario,
    })
    context.terminal.status(result.passed ? 'ok' : 'fail', `Rolling backtest ${envName} ${result.passed ? 'passed' : 'failed'}`)
    context.terminal.subtitle(`sandbox db: ${envDbPath}`)
    context.terminal.dump({
      scenario: result.scenario,
      days: result.days,
      horizonDays: result.horizonDays,
      warmupDays: result.warmupDays,
      countCadenceDays: result.countCadenceDays,
      runCount: result.runCount,
      evaluatedPredictions: result.evaluatedPredictions,
      countSnapshots: result.countSnapshots,
      feedbackItems: result.feedbackItems,
      calibratedSkus: result.calibratedSkus,
      bottleMae: result.bottleMae,
      maxBottleError: result.maxBottleError,
      lowStockRecall: result.lowStockRecall,
      lowStockPrecision: result.lowStockPrecision,
      uncertaintyCoverage: result.uncertaintyCoverage,
      meanBandBottles: result.meanBandBottles,
      costCuttingOptions: result.costCuttingOptions,
      shrinkSignals: result.shrinkSignals,
    })
    context.terminal.section('Worst prediction errors')
    context.terminal.table(
      [...result.rows]
        .sort((left, right) => right.bottleError - left.bottleError)
        .slice(0, options.limit ?? 12)
        .map((row) => ({
          target: row.targetAsOf,
          sku: row.sku,
          predicted: row.predictedOnHand,
          actual: row.actualOnHand,
          bottleError: row.bottleError,
          bandBottles: row.bandBottles,
          inBand: row.inBand,
          risk: row.risk,
          actualLow: row.actualLow,
          cost: row.costSignal,
        })),
    )
    if (!result.passed) {
      throw new Error('backbone_backtest_failed')
    }
  } finally {
    db.close()
  }
}

export const backboneBacktestMatrix = async (args: string[], context: CommandContext): Promise<void> => {
  const options = parseOptions(args)
  const scenarios = options.scenario ? [options.scenario] : backboneSimulationScenarios
  const prefix = options.env ?? `rolling-matrix-${new Date().toISOString().replace(/[:.]/g, '-')}`

  context.terminal.title('Backbone rolling backtest matrix')
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
          description: `Backbone ${scenario} rolling backtest sandbox`,
        })
      })

      const db = openDatabase(envDbPath)
      try {
        migrateDatabase(db)
        const result = runBackboneRollingBacktest(db, {
          startAt: options.asOf,
          days: options.days,
          horizonDays: options.horizonDays,
          countCadenceDays: options.countCadenceDays,
          warmupDays: options.warmupDays,
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
      runs: result.runCount,
      evaluated: result.evaluatedPredictions,
      counts: result.countSnapshots,
      bottleMae: result.bottleMae,
      maxBottleError: result.maxBottleError,
      lowStockRecall: result.lowStockRecall,
      lowStockPrecision: result.lowStockPrecision,
      uncertaintyCoverage: result.uncertaintyCoverage,
      meanBandBottles: result.meanBandBottles,
      costOptions: result.costCuttingOptions,
      shrinkSignals: result.shrinkSignals,
      feedback: result.feedbackItems,
      calibrated: result.calibratedSkus,
    })),
  )

  const failed = results.filter(({ result }) => !result.passed)
  if (failed.length > 0) throw new Error(`backbone_backtest_matrix_failed:${failed.map(({ result }) => result.scenario).join(',')}`)
  context.terminal.success(`Backbone rolling backtest matrix passed ${results.length}/${results.length} scenarios.`)
}

const runMaintenanceVerificationGate = async (
  context: CommandContext,
  input: {
    startedAt: string
    label: string
    options: ParsedOptions
  },
): Promise<MaintenanceVerificationSummary> => {
  const scenarios = input.options.scenario ? [input.options.scenario] : (['shrink'] satisfies BackboneSimulationScenario[])
  const prefix = cleanEnvName(`${input.label}-verify`)
  context.terminal.section('Verification gate')
  context.terminal.subtitle(`isolated prefix: ${prefix}; scenarios: ${scenarios.join(', ')}`)

  const results: VerificationScenarioResult[] = await Promise.all(
    scenarios.map(async (scenario) => {
      const validation = await runVerificationSandbox(context, {
        envName: cleanEnvName(`${prefix}-validation-${scenario}`),
        description: `Backbone maintenance ${scenario} validation-day sandbox`,
        run: (db) =>
          runBackboneAccuracySimulation(db, {
            startAt: input.options.asOf,
            trainingDays: input.options.trainingDays,
            scenario,
          }),
      })
      const rolling = await runVerificationSandbox(context, {
        envName: cleanEnvName(`${prefix}-rolling-${scenario}`),
        description: `Backbone maintenance ${scenario} rolling sandbox`,
        run: (db) =>
          runBackboneRollingBacktest(db, {
            startAt: input.options.asOf,
            days: input.options.days,
            horizonDays: input.options.horizonDays,
            countCadenceDays: input.options.countCadenceDays,
            warmupDays: input.options.warmupDays,
            scenario,
          }),
      })
      return { scenario, validation, rolling }
    }),
  )

  context.terminal.table(
    results.map(({ scenario, validation, rolling }) => ({
      scenario,
      validation: validation.result.passed,
      rolling: rolling.result.passed,
      bottleMae: validation.result.bottleMae,
      rollingMae: rolling.result.bottleMae,
      lowStockRecall: rolling.result.lowStockRecall,
      uncertaintyCoverage: rolling.result.uncertaintyCoverage,
      costOptions: rolling.result.costCuttingOptions,
      feedback: rolling.result.feedbackItems,
    })),
  )

  const failed = results.filter(({ validation, rolling }) => !validation.result.passed || !rolling.result.passed)
  const status = failed.length > 0 ? 'failed' : 'passed'
  await persistVerificationResult(context, {
    startedAt: input.startedAt,
    status,
    scenarios,
    options: { ...input.options, env: prefix },
    results,
  })

  return {
    enabled: true,
    status,
    scenarios: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    prefix,
    worstValidationBottleMae: round(Math.max(0, ...results.map(({ validation }) => validation.result.bottleMae)), 3),
    worstRollingBottleMae: round(Math.max(0, ...results.map(({ rolling }) => rolling.result.bottleMae)), 3),
    minRollingLowStockRecall: round(Math.min(...results.map(({ rolling }) => rolling.result.lowStockRecall)), 3),
    minRollingUncertaintyCoverage: round(Math.min(...results.map(({ rolling }) => rolling.result.uncertaintyCoverage)), 3),
    minRollingFeedbackBandCoverage: minFeedbackBandCoverage(results, input.options, 'rolling'),
  }
}

export const backboneVerify = async (args: string[], context: CommandContext): Promise<void> => {
  const options = parseOptions(args)
  const scenarios = options.scenario ? [options.scenario] : backboneSimulationScenarios
  const prefix = options.env ?? `verify-${new Date().toISOString().replace(/[:.]/g, '-')}`
  const startedAt = new Date().toISOString()

  context.terminal.title('Backbone verification gate')
  context.terminal.subtitle(`scenarios: ${scenarios.join(', ')}`)

  const results = await Promise.all(
    scenarios.map(async (scenario) => {
      const validation = await runVerificationSandbox(context, {
        envName: cleanEnvName(`${prefix}-validation-${scenario}`),
        description: `Backbone ${scenario} verification validation-day sandbox`,
        run: (db) =>
          runBackboneAccuracySimulation(db, {
            startAt: options.asOf,
            trainingDays: options.trainingDays,
            scenario,
          }),
      })
      const rolling = await runVerificationSandbox(context, {
        envName: cleanEnvName(`${prefix}-rolling-${scenario}`),
        description: `Backbone ${scenario} verification rolling sandbox`,
        run: (db) =>
          runBackboneRollingBacktest(db, {
            startAt: options.asOf,
            days: options.days,
            horizonDays: options.horizonDays,
            countCadenceDays: options.countCadenceDays,
            warmupDays: options.warmupDays,
            scenario,
          }),
      })
      return { scenario, validation, rolling }
    }),
  )

  context.terminal.section('Validation-day gate')
  context.terminal.table(
    results.map(({ scenario, validation }) => ({
      scenario,
      env: validation.envName,
      passed: validation.result.passed,
      bottleMae: validation.result.bottleMae,
      maxBottleError: validation.result.maxBottleError,
      lowStockRecall: validation.result.lowStockRecall,
      lowStockPrecision: validation.result.lowStockPrecision,
      uncertaintyCoverage: validation.result.uncertaintyCoverage,
      meanBandBottles: validation.result.meanBandBottles,
      costOptions: validation.result.costCuttingOptions,
      feedback: validation.result.feedbackItems,
      calibrated: validation.result.calibratedSkus,
    })),
  )

  context.terminal.section('Rolling backtest gate')
  context.terminal.table(
    results.map(({ scenario, rolling }) => ({
      scenario,
      env: rolling.envName,
      passed: rolling.result.passed,
      runs: rolling.result.runCount,
      evaluated: rolling.result.evaluatedPredictions,
      counts: rolling.result.countSnapshots,
      bottleMae: rolling.result.bottleMae,
      maxBottleError: rolling.result.maxBottleError,
      lowStockRecall: rolling.result.lowStockRecall,
      lowStockPrecision: rolling.result.lowStockPrecision,
      uncertaintyCoverage: rolling.result.uncertaintyCoverage,
      meanBandBottles: rolling.result.meanBandBottles,
      costOptions: rolling.result.costCuttingOptions,
      shrinkSignals: rolling.result.shrinkSignals,
      feedback: rolling.result.feedbackItems,
      calibrated: rolling.result.calibratedSkus,
    })),
  )

  const failed = results.filter(({ validation, rolling }) => !validation.result.passed || !rolling.result.passed)
  await persistVerificationResult(context, {
    startedAt,
    status: failed.length > 0 ? 'failed' : 'passed',
    scenarios,
    options,
    results,
  })
  if (failed.length > 0) throw new Error(`backbone_verify_failed:${failed.map(({ scenario }) => scenario).join(',')}`)
  context.terminal.success(`Backbone verification passed ${results.length}/${results.length} scenario${results.length === 1 ? '' : 's'}.`)
}

export const backboneAcceptance = async (args: string[], context: CommandContext): Promise<void> => {
  const options = parseOptions(args)
  const scenarios = options.scenario ? [options.scenario] : backboneSimulationScenarios
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const prefix = cleanEnvName(`${options.env ?? 'acceptance'}-${timestamp}`)
  const startedAt = new Date().toISOString()
  const driftThresholds = {
    minSamples: options.minSamples ?? 3,
    maxBottleMae: options.maxBottleMae ?? 0.25,
    maxBiasBottles: options.maxBiasBottles ?? 0.2,
    maxFeedbackAgeDays: options.maxFeedbackAgeDays ?? options.maxCountAgeDays ?? 45,
  }

  context.terminal.title('Backbone acceptance drill')
  context.terminal.subtitle(`fresh prefix: ${prefix}; scenarios: ${scenarios.join(', ')}`)

  const results = await Promise.all(
    scenarios.map(async (scenario) => {
      const validation = await runVerificationSandbox(context, {
        envName: cleanEnvName(`${prefix}-validation-${scenario}`),
        description: `Backbone ${scenario} acceptance validation-day sandbox`,
        run: (db) =>
          runBackboneAccuracySimulation(db, {
            startAt: options.asOf,
            trainingDays: options.trainingDays,
            scenario,
          }),
      })
      const rolling = await runVerificationSandbox(context, {
        envName: cleanEnvName(`${prefix}-rolling-${scenario}`),
        description: `Backbone ${scenario} acceptance rolling sandbox`,
        run: (db) =>
          runBackboneRollingBacktest(db, {
            startAt: options.asOf,
            days: options.days,
            horizonDays: options.horizonDays,
            countCadenceDays: options.countCadenceDays,
            warmupDays: options.warmupDays,
            scenario,
          }),
      })
      return { scenario, validation, rolling }
    }),
  )

  context.terminal.section('Validation-day gate')
  context.terminal.table(
    results.map(({ scenario, validation }) => ({
      scenario,
      env: validation.envName,
      passed: validation.result.passed,
      bottleMae: validation.result.bottleMae,
      maxBottleError: validation.result.maxBottleError,
      lowStockRecall: validation.result.lowStockRecall,
      lowStockPrecision: validation.result.lowStockPrecision,
      uncertaintyCoverage: validation.result.uncertaintyCoverage,
      meanBandBottles: validation.result.meanBandBottles,
      costOptions: validation.result.costCuttingOptions,
      feedback: validation.result.feedbackItems,
      calibrated: validation.result.calibratedSkus,
    })),
  )

  context.terminal.section('Rolling sparse-count gate')
  context.terminal.table(
    results.map(({ scenario, rolling }) => ({
      scenario,
      env: rolling.envName,
      passed: rolling.result.passed,
      runs: rolling.result.runCount,
      evaluated: rolling.result.evaluatedPredictions,
      counts: rolling.result.countSnapshots,
      bottleMae: rolling.result.bottleMae,
      maxBottleError: rolling.result.maxBottleError,
      lowStockRecall: rolling.result.lowStockRecall,
      lowStockPrecision: rolling.result.lowStockPrecision,
      uncertaintyCoverage: rolling.result.uncertaintyCoverage,
      meanBandBottles: rolling.result.meanBandBottles,
      costOptions: rolling.result.costCuttingOptions,
      shrinkSignals: rolling.result.shrinkSignals,
      feedback: rolling.result.feedbackItems,
      calibrated: rolling.result.calibratedSkus,
    })),
  )

  const driftRows = results.flatMap(({ scenario, validation, rolling }) => [
    {
      scenario,
      gate: 'validation',
      env: validation.envName,
      ...readLearningDriftSummary(validation.envDbPath, validation.envName, driftThresholds),
    },
    {
      scenario,
      gate: 'rolling',
      env: rolling.envName,
      ...readLearningDriftSummary(rolling.envDbPath, rolling.envName, driftThresholds),
    },
  ])
  context.terminal.section('Learning drift gate')
  context.terminal.table(
    driftRows.map((row) => ({
      scenario: row.scenario,
      gate: row.gate,
      env: row.env,
      status: row.status,
      samples: row.feedbackSamples,
      bottleMae: row.bottleMae,
      biasBottles: row.biasBottles,
      bandCoverage: row.feedbackBandCoverage,
      outOfBand: row.outOfBandSamples,
      ageDays: row.feedbackAgeDays ?? '',
      trendDelta: row.trendDelta,
      reason: row.statusReason,
    })),
  )

  const snapshotLabel = cleanEnvName(options.label ?? `${prefix}-snapshot`)
  const snapshot = await createBackboneSnapshotArtifact(context, snapshotLabel)
  const restored = await restoreBackboneSnapshotArtifact(context, {
    label: snapshotLabel,
    envName: cleanEnvName(`${prefix}-restore`),
    force: false,
  })
  context.terminal.section('Snapshot restore gate')
  context.terminal.table([
    {
      label: snapshot.label,
      restoredEnv: restored.env,
      snapshotBytes: snapshot.sizeBytes,
      integrity: 'ok',
      restored: true,
      db: restored.envDbPath,
    },
  ])

  const failed = results.filter(({ validation, rolling }) => !validation.result.passed || !rolling.result.passed)
  const driftWarnings = driftRows.filter((row) => row.status !== 'pass')
  await persistVerificationResult(context, {
    startedAt,
    status: failed.length > 0 || driftWarnings.length > 0 ? 'failed' : 'passed',
    scenarios,
    options: { ...options, env: prefix },
    results,
  })

  if (failed.length > 0) throw new Error(`backbone_acceptance_failed:${failed.map(({ scenario }) => scenario).join(',')}`)
  if (driftWarnings.length > 0) throw new Error(`backbone_acceptance_drift_warn:${driftWarnings.map((row) => `${row.scenario}:${row.gate}`).join(',')}`)
  context.terminal.success(`Backbone acceptance drill passed ${results.length}/${results.length} scenario${results.length === 1 ? '' : 's'}.`)
}

export const backboneVerifyHistory = async (args: string[], context: CommandContext): Promise<void> => {
  const options = parseOptions(args)
  const limit = options.limit ?? 10
  context.terminal.title('Backbone verification history')

  await withBackendDb(context.config, async (db: any) => {
    const rows = db
      .prepare(
        `SELECT *
         FROM backbone_verifications
         ORDER BY completed_at DESC, id DESC
         LIMIT ?`,
      )
      .all(limit)

    if (rows.length === 0) {
      context.terminal.warn('No Backbone verification runs have been recorded yet.')
      context.terminal.subtitle('Run `bbk backbone verify --env <prefix>`.')
      return
    }

    context.terminal.table(
      rows.map((row: any) => {
        const summary = parseJson<{
          worstValidationBottleMae?: number
          worstRollingBottleMae?: number
          maxRollingBottleError?: number
          minRollingLowStockRecall?: number
          minRollingUncertaintyCoverage?: number
          minRollingFeedbackBandCoverage?: number
        }>(row.summary_json, {})
        return {
          id: row.id,
          status: row.status,
          completed: row.completed_at,
          scenarios: `${row.passed_scenarios}/${row.scenario_count}`,
          failed: row.failed_scenarios,
          validationMae: summary.worstValidationBottleMae ?? '',
          rollingMae: summary.worstRollingBottleMae ?? '',
          maxBottleError: summary.maxRollingBottleError ?? '',
          lowStockRecall: summary.minRollingLowStockRecall ?? '',
          uncertaintyCoverage: summary.minRollingUncertaintyCoverage ?? '',
          feedbackBandCoverage: summary.minRollingFeedbackBandCoverage ?? '',
        }
      }),
    )
  })
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
          trainingDays: options.trainingDays ?? (options.days ? options.days - 1 : undefined),
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
      uncertaintyCoverage: result.uncertaintyCoverage,
      meanBandBottles: result.meanBandBottles,
      costOptions: result.costCuttingOptions,
      feedback: result.feedbackItems,
      calibrated: result.calibratedSkus,
    })),
  )

  const failed = results.filter(({ result }) => !result.passed)
  if (failed.length > 0) throw new Error(`backbone_matrix_failed:${failed.map(({ result }) => result.scenario).join(',')}`)
  context.terminal.success(`Backbone scenario matrix passed ${results.length}/${results.length} scenarios.`)
}

const runVerificationSandbox = async <T extends { passed: boolean }>(
  context: CommandContext,
  input: {
    envName: string
    description: string
    run: (db: Db) => T
  },
): Promise<{ envName: string; envDbPath: string; result: T }> => {
  const envDir = resolve(context.config.dataDir, 'environments', input.envName)
  const envDbPath = resolve(envDir, 'barsbookkeeper.sqlite')
  await mkdir(envDir, { recursive: true })

  await withBackendDb(context.config, async (controlDb: any) => {
    ensureBackboneEnvironment(controlDb, {
      name: input.envName,
      dbPath: envDbPath,
      description: input.description,
    })
  })

  const db = openDatabase(envDbPath)
  try {
    migrateDatabase(db)
    return { envName: input.envName, envDbPath, result: input.run(db) }
  } finally {
    db.close()
  }
}

const readLearningDriftSummary = (
  dbPath: string,
  target: string,
  thresholds: LearningDriftSummary['thresholds'],
): LearningDriftSummary => {
  const db = openDatabase(dbPath)
  try {
    migrateDatabase(db)
    return buildLearningDriftSummary(db, target, thresholds)
  } finally {
    db.close()
  }
}

const verificationDriftThresholds = (options: ParsedOptions): LearningDriftSummary['thresholds'] => ({
  minSamples: options.minSamples ?? 3,
  maxBottleMae: options.maxBottleMae ?? 0.25,
  maxBiasBottles: options.maxBiasBottles ?? 0.2,
  maxFeedbackAgeDays: options.maxFeedbackAgeDays ?? options.maxCountAgeDays ?? 45,
})

const minFeedbackBandCoverage = (
  results: VerificationScenarioResult[],
  options: ParsedOptions,
  gate: 'validation' | 'rolling',
): number => {
  const thresholds = verificationDriftThresholds(options)
  return round(
    Math.min(
      ...results.map((result) => {
        const target = gate === 'validation' ? result.validation : result.rolling
        return readLearningDriftSummary(target.envDbPath, target.envName, thresholds).feedbackBandCoverage
      }),
    ),
    3,
  )
}

const persistVerificationResult = async (
  context: CommandContext,
  input: {
    startedAt: string
    status: 'passed' | 'failed'
    scenarios: BackboneSimulationScenario[]
    options: ParsedOptions
    results: VerificationScenarioResult[]
  },
): Promise<void> => {
  const failedScenarios = input.results.filter(({ validation, rolling }) => !validation.result.passed || !rolling.result.passed)
  const driftThresholds = verificationDriftThresholds(input.options)
  const scenarioSummaries = input.results.map(({ scenario, validation, rolling }) => {
    const validationDrift = readLearningDriftSummary(validation.envDbPath, validation.envName, driftThresholds)
    const rollingDrift = readLearningDriftSummary(rolling.envDbPath, rolling.envName, driftThresholds)
    return {
      scenario,
      validationDrift,
      rollingDrift,
      validation: {
        env: validation.envName,
        passed: validation.result.passed,
        bottleMae: validation.result.bottleMae,
        maxBottleError: validation.result.maxBottleError,
        lowStockRecall: validation.result.lowStockRecall,
        lowStockPrecision: validation.result.lowStockPrecision,
        uncertaintyCoverage: validation.result.uncertaintyCoverage,
        feedbackBandCoverage: validationDrift.feedbackBandCoverage,
        outOfBandFeedback: validationDrift.outOfBandSamples,
        meanBandBottles: validation.result.meanBandBottles,
        costCuttingOptions: validation.result.costCuttingOptions,
        feedbackItems: validation.result.feedbackItems,
        calibratedSkus: validation.result.calibratedSkus,
      },
      rolling: {
        env: rolling.envName,
        passed: rolling.result.passed,
        runCount: rolling.result.runCount,
        evaluatedPredictions: rolling.result.evaluatedPredictions,
        countSnapshots: rolling.result.countSnapshots,
        bottleMae: rolling.result.bottleMae,
        maxBottleError: rolling.result.maxBottleError,
        lowStockRecall: rolling.result.lowStockRecall,
        lowStockPrecision: rolling.result.lowStockPrecision,
        uncertaintyCoverage: rolling.result.uncertaintyCoverage,
        feedbackBandCoverage: rollingDrift.feedbackBandCoverage,
        outOfBandFeedback: rollingDrift.outOfBandSamples,
        meanBandBottles: rolling.result.meanBandBottles,
        costCuttingOptions: rolling.result.costCuttingOptions,
        shrinkSignals: rolling.result.shrinkSignals,
        feedbackItems: rolling.result.feedbackItems,
        calibratedSkus: rolling.result.calibratedSkus,
      },
    }
  })
  const summary = {
    scenarios: scenarioSummaries.map(({ scenario, validation, rolling }) => ({ scenario, validation, rolling })),
    worstValidationBottleMae: round(Math.max(0, ...input.results.map(({ validation }) => validation.result.bottleMae)), 3),
    worstRollingBottleMae: round(Math.max(0, ...input.results.map(({ rolling }) => rolling.result.bottleMae)), 3),
    maxRollingBottleError: round(Math.max(0, ...input.results.map(({ rolling }) => rolling.result.maxBottleError)), 3),
    minRollingLowStockRecall: round(Math.min(...input.results.map(({ rolling }) => rolling.result.lowStockRecall)), 3),
    minRollingUncertaintyCoverage: round(Math.min(...input.results.map(({ rolling }) => rolling.result.uncertaintyCoverage)), 3),
    minValidationFeedbackBandCoverage: round(Math.min(...scenarioSummaries.map(({ validationDrift }) => validationDrift.feedbackBandCoverage)), 3),
    minRollingFeedbackBandCoverage: round(Math.min(...scenarioSummaries.map(({ rollingDrift }) => rollingDrift.feedbackBandCoverage)), 3),
    maxRollingMeanBandBottles: round(Math.max(0, ...input.results.map(({ rolling }) => rolling.result.meanBandBottles)), 3),
  }

  await withBackendDb(context.config, async (db: any) => {
    db.prepare(
      `INSERT INTO backbone_verifications
       (started_at, completed_at, status, scenario_count, passed_scenarios, failed_scenarios, options_json, summary_json)
       VALUES (?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.startedAt,
      input.status,
      input.results.length,
      input.results.length - failedScenarios.length,
      failedScenarios.length,
      stringifyJson({
        scenarios: input.scenarios,
        env: input.options.env,
        asOf: input.options.asOf,
        days: input.options.days,
        horizonDays: input.options.horizonDays,
        countCadenceDays: input.options.countCadenceDays,
        warmupDays: input.options.warmupDays,
        trainingDays: input.options.trainingDays,
      }),
      stringifyJson(summary),
    )
  })
}

const persistMaintenanceRun = (
  db: Db,
  input: {
    startedAt: string
    status: 'passed' | 'warn' | 'failed'
    snapshot: SnapshotArtifact
    auditFailures: number
    auditWarnings: number
    gapCount: number
    summary: MaintenanceSummary
  },
): void => {
  db.prepare(
    `INSERT INTO backbone_maintenance_runs
     (started_at, completed_at, status, snapshot_label, snapshot_path, manifest_path,
      audit_failures, audit_warnings, gap_count, summary_json)
     VALUES (?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.startedAt,
    input.status,
    input.snapshot.label,
    input.snapshot.snapshotPath,
    input.snapshot.manifestPath,
    input.auditFailures,
    input.auditWarnings,
    input.gapCount,
    stringifyJson(input.summary),
  )
}

const buildBackboneAudit = (
  db: any,
  options: { maxAgeMinutes: number; maxRunAgeMinutes: number; maxCountAgeDays: number },
): AuditCheck[] => {
  const latestRun = db
    .prepare(
      `SELECT id, as_of, completed_at, metrics_json
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
  const listenerLock = readRuntimeLock(db)
  const cursor = db.prepare('SELECT last_start, last_end, last_source, updated_at FROM backbone_toast_cursor WHERE id = 1').get()
  const countGrounding = db
    .prepare(
      `SELECT COUNT(*) AS count_events,
              COUNT(DISTINCT sku_id) AS counted_skus,
              MAX(occurred_at) AS latest_count_at
       FROM inventory_events
       WHERE event_type = 'adjustment'`,
    )
    .get()
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
  const learningDrift = buildLearningDriftSummary(db, 'base', {
    minSamples: 3,
    maxBottleMae: 0.25,
    maxBiasBottles: 0.2,
    maxFeedbackAgeDays: options.maxCountAgeDays,
  })
  const toastCoverage = buildToastIntakeSummary(db, 'base')
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
  if (latestRun) {
    const runFreshnessAge = ageMinutes(latestRun.completed_at ?? latestRun.as_of)
    checks.push({
      check: 'prediction freshness',
      status: runFreshnessAge <= options.maxRunAgeMinutes ? 'pass' : 'fail',
      detail: `run ${toNumber(latestRun.id)} ${Number(runFreshnessAge.toFixed(1))}m old; max ${options.maxRunAgeMinutes}m`,
    })
  } else {
    checks.push({
      check: 'prediction freshness',
      status: 'fail',
      detail: 'no completed Backbone run to age',
    })
  }
  checks.push({
    check: 'prediction coverage',
    status: predictionCount > 0 ? 'pass' : 'fail',
    detail: `${predictionCount} stored prediction${predictionCount === 1 ? '' : 's'}`,
  })
  checks.push({
    check: 'toast recipe coverage',
    status: toastCoverage.toastDocuments === 0 || toastCoverage.recipeCoveragePct < 95 ? 'warn' : 'pass',
    detail: toastCoverage.toastDocuments === 0
      ? 'no Toast sale documents have been ingested'
      : `${toastCoverage.mappedDocuments}/${toastCoverage.toastDocuments} Toast sale document${toastCoverage.toastDocuments === 1 ? '' : 's'} mapped into consumption (${toastCoverage.recipeCoveragePct}%); ${toastCoverage.missingRecipeDocuments} missing recipe${toastCoverage.missingRecipeDocuments === 1 ? '' : 's'}`,
  })

  const countEvents = toNumber(countGrounding?.count_events)
  const countedSkus = toNumber(countGrounding?.counted_skus)
  const latestCountAt = countGrounding?.latest_count_at ? String(countGrounding.latest_count_at) : ''
  const countAgeDays = latestCountAt ? ageMinutes(latestCountAt) / (24 * 60) : Number.POSITIVE_INFINITY
  checks.push({
    check: 'count grounding',
    status: countEvents > 0 && countAgeDays <= options.maxCountAgeDays ? 'pass' : 'warn',
    detail: countEvents > 0
      ? `${countEvents} count event${countEvents === 1 ? '' : 's'} across ${countedSkus} SKU${countedSkus === 1 ? '' : 's'}; latest ${Number(countAgeDays.toFixed(1))}d old; max ${options.maxCountAgeDays}d`
      : 'no sparse hand counts have grounded Backbone yet',
  })

  if (!latestCycle) {
    checks.push({ check: 'listener heartbeat', status: 'fail', detail: 'no listener cycle journaled' })
    checks.push({ check: 'listener prediction link', status: 'fail', detail: 'no listener cycle has produced Backbone output' })
  } else {
    const listenerAgeMinutes = ageMinutes(latestCycle.started_at)
    checks.push({
      check: 'listener heartbeat',
      status: listenerAgeMinutes <= options.maxAgeMinutes ? 'pass' : 'fail',
      detail: `cycle ${latestCycle.id} ${Number(listenerAgeMinutes.toFixed(1))}m old; max ${options.maxAgeMinutes}m`,
    })
    checks.push({
      check: 'listener status',
      status: latestCycle.status === 'completed' ? 'pass' : 'fail',
      detail: `${latestCycle.status}${latestCycle.error_message ? `: ${latestCycle.error_message}` : ''}`,
    })
    checks.push({
      check: 'listener prediction link',
      status: latestCycle.backbone_run_id && latestCycle.prediction_count > 0 ? 'pass' : 'fail',
      detail: latestCycle.backbone_run_id
        ? `cycle ${latestCycle.id} -> run ${latestCycle.backbone_run_id}, ${latestCycle.prediction_count} prediction${latestCycle.prediction_count === 1 ? '' : 's'}`
        : `cycle ${latestCycle.id} has no Backbone run`,
    })
    checks.push({
      check: 'toast intake',
      status: latestCycle.toast_ok ? 'pass' : 'warn',
      detail: latestCycle.toast_ok ? latestCycle.toast_summary : latestCycle.toast_error ?? latestCycle.toast_summary,
    })
  }

  checks.push({
    check: 'listener runtime lock',
    status: listenerLock.state === 'active' ? 'pass' : 'warn',
    detail: listenerLock.state === 'active'
      ? `active owner ${listenerLock.owner}; heartbeat ${Number(listenerLock.ageMinutes.toFixed(1))}m old; expires ${listenerLock.expiresAt}`
      : listenerLock.state === 'stale'
        ? `stale owner ${listenerLock.owner}; expired ${listenerLock.expiresAt}; next listener will take over`
        : 'no active listener lock; launchd listener may not be running',
  })

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
    check: 'feedback band coverage',
    status: feedbackCount > 0 && learningDrift.feedbackBandCoverage >= 0.8 ? 'pass' : 'warn',
    detail: feedbackCount === 0
      ? 'no scored feedback with prediction bands yet'
      : `${learningDrift.feedbackBandCoverage} band coverage; ${learningDrift.outOfBandSamples} out-of-band feedback sample${learningDrift.outOfBandSamples === 1 ? '' : 's'}`,
  })
  checks.push({
    check: 'learning drift',
    status: learningDrift.status,
    detail: feedbackCount === 0
      ? 'no scored feedback yet'
      : `bottle MAE ${learningDrift.bottleMae}, bias ${learningDrift.biasBottles} bottles, band coverage ${learningDrift.feedbackBandCoverage}, latest ${learningDrift.feedbackAgeDays ?? '?'}d old; ${learningDrift.statusReason}`,
  })
  checks.push({
    check: 'toast cursor',
    status: cursor?.last_end ? 'pass' : 'warn',
    detail: cursor?.last_end ? `${cursor.last_start ?? '?'} -> ${cursor.last_end} (${cursor.last_source ?? 'unknown'})` : 'no successful cursor yet',
  })

  return checks
}

const ageMinutes = (timestamp: unknown): number => {
  const value = timestamp ? new Date(String(timestamp)).getTime() : Number.NaN
  if (!Number.isFinite(value)) return Number.POSITIVE_INFINITY
  return Math.max(0, (Date.now() - value) / 60_000)
}

const isInsideDirectory = (root: string, candidate: string): boolean => {
  const relativePath = relative(root, candidate)
  return relativePath !== '' && !relativePath.startsWith('..') && !isAbsolute(relativePath)
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
  if (options.toastMaxRetries !== undefined) toastArgs.push('--max-retries', String(options.toastMaxRetries))
  if (options.toastRetryDelayMs !== undefined) toastArgs.push('--retry-delay-ms', String(options.toastRetryDelayMs))

  try {
    const result = await pullToast(db, context.config, toastArgs)
    if (toastWindow.start && toastWindow.end && result.failedRestaurants === 0) {
      updateToastCursor(db, {
        start: toastWindow.start,
        end: toastWindow.end,
        source: result.source,
      })
    }
    const failureSummary = result.failedRestaurants > 0
      ? ` failures:${result.failedRestaurants}/${result.restaurants}`
      : ''
    return {
      ok: result.failedRestaurants === 0,
      summary: `${result.source}:${result.rowsPulled}/${result.ingest.recordsImported}${failureSummary}${toastWindow.start && toastWindow.end ? ` ${toastWindow.start}->${toastWindow.end}` : ''}`,
      error: result.failures.length > 0 ? result.failures.map((failure) => `${failure.restaurantExternalId}:${failure.error}`).join('; ') : undefined,
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

const recoverStaleListenerCycles = (db: any, maxAgeMinutes: number): number => {
  const cutoff = new Date(Date.now() - Math.max(0, maxAgeMinutes) * 60_000).toISOString()
  const result = db
    .prepare(
      `UPDATE backbone_listener_cycles
       SET status = 'failed',
           completed_at = CURRENT_TIMESTAMP,
           error_message = COALESCE(error_message, 'recovered stale running cycle on listener startup')
       WHERE status = 'running'
         AND started_at < ?`,
    )
    .run(cutoff)
  return toNumber(result.changes)
}

const acquireRuntimeLock = (
  db: any,
  input: { name: string; owner: string; ttlMinutes: number },
): void => {
  const now = new Date()
  const expiresAt = new Date(now.getTime() + Math.max(1, input.ttlMinutes) * 60_000).toISOString()
  const existing = db.prepare('SELECT owner, expires_at FROM backbone_runtime_locks WHERE name = ?').get(input.name)
  if (existing && new Date(String(existing.expires_at)).getTime() > now.getTime() && String(existing.owner) !== input.owner) {
    throw new Error(`backbone_listener_lock_held:${existing.owner}:expires:${existing.expires_at}`)
  }

  db.prepare(
    `INSERT INTO backbone_runtime_locks (name, owner, acquired_at, heartbeat_at, expires_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       owner = excluded.owner,
       acquired_at = excluded.acquired_at,
       heartbeat_at = excluded.heartbeat_at,
       expires_at = excluded.expires_at`,
  ).run(input.name, input.owner, now.toISOString(), now.toISOString(), expiresAt)
}

const heartbeatRuntimeLock = (
  db: any,
  input: { name: string; owner: string; ttlMinutes: number },
): void => {
  const now = new Date()
  const expiresAt = new Date(now.getTime() + Math.max(1, input.ttlMinutes) * 60_000).toISOString()
  const result = db
    .prepare(
      `UPDATE backbone_runtime_locks
       SET heartbeat_at = ?, expires_at = ?
       WHERE name = ? AND owner = ?`,
    )
    .run(now.toISOString(), expiresAt, input.name, input.owner)
  if (toNumber(result.changes) === 0) throw new Error(`backbone_listener_lock_lost:${input.name}`)
}

const releaseRuntimeLock = (
  db: any,
  input: { name: string; owner: string },
): void => {
  db.prepare('DELETE FROM backbone_runtime_locks WHERE name = ? AND owner = ?').run(input.name, input.owner)
}

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
      predictedLowerOnHand?: number
      predictedUpperOnHand?: number
      unit: string
      predictedDaysRemaining: number | null
      stockoutProbability?: number
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
      band: prediction.predictedLowerOnHand === undefined || prediction.predictedUpperOnHand === undefined
        ? ''
        : `${prediction.predictedLowerOnHand}..${prediction.predictedUpperOnHand}`,
      stockout: prediction.stockoutProbability ?? '',
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
    } else if (arg === '--horizons' && next) {
      parsed.horizons = next.split(',').map((value) => positiveNumber(value.trim(), '--horizons'))
      index += 1
    } else if (arg === '--usage-window-days' && next) {
      parsed.usageWindowDays = positiveNumber(next, '--usage-window-days')
      index += 1
    } else if (arg === '--training-days' && next) {
      parsed.trainingDays = positiveNumber(next, '--training-days')
      index += 1
    } else if (arg === '--days' && next) {
      parsed.days = positiveNumber(next, '--days')
      index += 1
    } else if (arg === '--cycles' && next) {
      parsed.cycles = positiveNumber(next, '--cycles')
      index += 1
    } else if (arg === '--once') {
      parsed.once = true
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
    } else if (arg === '--verify') {
      parsed.runVerify = true
    } else if (arg === '--scenario' && next) {
      parsed.scenario = parseScenario(next)
      index += 1
    } else if (arg === '--max-age-minutes' && next) {
      parsed.maxAgeMinutes = nonNegativeNumber(next, '--max-age-minutes')
      index += 1
    } else if (arg === '--max-run-age-minutes' && next) {
      parsed.maxRunAgeMinutes = nonNegativeNumber(next, '--max-run-age-minutes')
      index += 1
    } else if (arg === '--max-count-age-days' && next) {
      parsed.maxCountAgeDays = nonNegativeNumber(next, '--max-count-age-days')
      index += 1
    } else if (arg === '--max-feedback-age-days' && next) {
      parsed.maxFeedbackAgeDays = nonNegativeNumber(next, '--max-feedback-age-days')
      index += 1
    } else if (arg === '--max-bottle-mae' && next) {
      parsed.maxBottleMae = nonNegativeDecimal(next, '--max-bottle-mae')
      index += 1
    } else if (arg === '--max-bias-bottles' && next) {
      parsed.maxBiasBottles = nonNegativeDecimal(next, '--max-bias-bottles')
      index += 1
    } else if (arg === '--recover-stale-minutes' && next) {
      parsed.recoverStaleMinutes = nonNegativeNumber(next, '--recover-stale-minutes')
      index += 1
    } else if (arg === '--cursor-lookback-minutes' && next) {
      parsed.cursorLookbackMinutes = positiveNumber(next, '--cursor-lookback-minutes')
      index += 1
    } else if (arg === '--max-retries' && next) {
      parsed.toastMaxRetries = nonNegativeNumber(next, '--max-retries')
      index += 1
    } else if (arg === '--retry-delay-ms' && next) {
      parsed.toastRetryDelayMs = nonNegativeNumber(next, '--retry-delay-ms')
      index += 1
    } else if (arg === '--min-samples' && next) {
      parsed.minSamples = nonNegativeNumber(next, '--min-samples')
      index += 1
    } else if (arg === '--sku' && next) {
      parsed.sku = next
      index += 1
    } else if (arg === '--older-than-days' && next) {
      parsed.olderThanDays = nonNegativeNumber(next, '--older-than-days')
      index += 1
    } else if (arg === '--keep' && next) {
      parsed.keep = nonNegativeNumber(next, '--keep')
      index += 1
    } else if (arg === '--force') {
      parsed.force = true
    } else if (arg === '--limit' && next) {
      parsed.limit = positiveNumber(next, '--limit')
      index += 1
    } else if (arg === '--count-cadence-days' && next) {
      parsed.countCadenceDays = positiveNumber(next, '--count-cadence-days')
      index += 1
    } else if (arg === '--warmup-days' && next) {
      parsed.warmupDays = positiveNumber(next, '--warmup-days')
      index += 1
    } else if (arg === '--label' && next) {
      parsed.label = next
      index += 1
    } else if (arg === '--lock-ttl-minutes' && next) {
      parsed.lockTtlMinutes = positiveNumber(next, '--lock-ttl-minutes')
      index += 1
    }
  }
  return parsed
}

const round = (value: number, decimals = 3): number => Number(value.toFixed(decimals))

const mean = (values: number[]): number =>
  values.length === 0 ? 0 : round(values.reduce((sum, value) => sum + value, 0) / values.length, 6)

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

const nonNegativeDecimal = (value: string, flag: string): number => {
  const number = toNumber(value)
  if (number < 0) throw new Error(`${flag}_must_be_non_negative`)
  return number
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
