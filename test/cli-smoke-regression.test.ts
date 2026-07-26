import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runBackboneModel, unscoredCountFeedback } from '../src/backbone/index.js'
import { openDatabase, toNumber, type Db } from '../src/db/database.js'
import { createInventoryEvent, ensureSku } from '../src/db/repositories.js'
import { ingestCounts, ingestInvoices } from '../src/ingest/index.js'

const execFileAsync = promisify(execFile)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cliPath = resolve(repoRoot, 'src/cli/index.ts')
const tsxPath = resolve(repoRoot, 'node_modules/.bin/tsx')
const fixturesDir = resolve(repoRoot, 'test/fixtures')

type CliResult = {
  code: number
  output: string
}

const runCli = async (
  args: string[],
  dataDir: string,
  extraEnv: Record<string, string | undefined> = {},
): Promise<CliResult> => {
  try {
    const { stdout, stderr } = await execFileAsync(tsxPath, [cliPath, ...args], {
      cwd: repoRoot,
      timeout: 90_000,
      env: {
        ...process.env,
        ...extraEnv,
        PATH: `${join(dataDir, 'bin')}:${process.env.PATH ?? ''}`,
        BBK_DATA_DIR: dataDir,
        BBK_SKIP_MODEL_SMOKE: '1',
        OPENCLAW_USE_CODEX: '0',
        OPENCLAW_LOGIC_MODEL: 'test-logic-model',
        OPENCLAW_FAST_MODEL: 'test-fast-model',
        TOAST_API_KEY: '',
        TOAST_CLIENT_ID: '',
        TOAST_CLIENT_SECRET: '',
        TOAST_RESTAURANT_EXTERNAL_IDS: '',
      },
    })
    return { code: 0, output: `${stdout}${stderr}` }
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string }
    return {
      code: typeof failed.code === 'number' ? failed.code : 1,
      output: `${failed.stdout ?? ''}${failed.stderr ?? ''}`,
    }
  }
}

const expectCliOk = async (args: string[], dataDir: string): Promise<string> => {
  const result = await runCli(args, dataDir)
  expect(result.code, result.output).toBe(0)
  expect(result.output).not.toMatch(/\[fail\]/i)
  return result.output
}

const scalar = (db: Db, sql: string): number => toNumber(db.prepare(sql).get()?.value)

describe('CLI/backend smoke regression harness', () => {
  let dataDir: string
  let db: Db | undefined

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'bbk-cli-smoke-'))
    const fakeBinDir = join(dataDir, 'bin')
    const fakeCodexPath = join(fakeBinDir, 'codex')
    await mkdir(fakeBinDir, { recursive: true })
    await writeFile(
      fakeCodexPath,
      `#!/usr/bin/env node
const args = process.argv.slice(2)
if (args[0] === 'login' && args[1] === 'status') {
  console.log('Logged in using ChatGPT')
  process.exit(0)
}
if (args[0] === 'exec') {
  const modelIndex = args.indexOf('--model')
  const model = modelIndex >= 0 ? args[modelIndex + 1] : 'unknown'
  console.log(JSON.stringify({ ok: true, model }))
  process.exit(0)
}
console.error('unexpected fake codex args: ' + args.join(' '))
process.exit(1)
`,
      'utf8',
    )
    await chmod(fakeCodexPath, 0o755)
  })

  afterEach(async () => {
    db?.close()
    db = undefined
    await rm(dataDir, { force: true, recursive: true })
  })

  it('runs the current deterministic CLI workflow against a clean data directory', async () => {
    await expectCliOk(['setup'], dataDir)
    const initialDoctor = await expectCliOk(['doctor'], dataDir)
    await expectCliOk(['seed-demo'], dataDir)
    await expectCliOk(['ingest', 'invoice', join(fixturesDir, 'smoke-invoice.csv')], dataDir)
    await expectCliOk(['ingest', 'count', join(fixturesDir, 'smoke-count.csv')], dataDir)
    const ingestNotePreview = await expectCliOk(
      [
        'ingest',
        'note',
        'House Vodka 1L 4.5 bottles; Lime Juice 1250 ml',
        '--as-of',
        '2026-05-11T16:00:00.000Z',
        '--dry-run',
      ],
      dataDir,
    )
    await expectCliOk(['toast', 'pull', '--file', join(fixturesDir, 'smoke-toast.json')], dataDir)
    await expectCliOk(['brain', 'run'], dataDir)
    const backboneRun = await expectCliOk(['backbone', 'run'], dataDir)
    const backbonePlan = await expectCliOk(['backbone', 'plan', '--horizons', '1,7,14'], dataDir)
    const backboneService = await expectCliOk(['backbone', 'service', '--interval-ms', '1000', '--label', 'com.barsbookkeeper.test'], dataDir)
    const backboneMaintainService = await expectCliOk(
      ['backbone', 'maintain-service', '--interval-ms', '60000', '--label', 'com.barsbookkeeper.test-maintenance', '--verify', '--scenario', 'shrink', '--days', '60', '--count-cadence-days', '30'],
      dataDir,
    )
    const listenOutput = await expectCliOk(
      [
        'backbone',
        'listen',
        '--cycles',
        '2',
        '--interval-ms',
        '0',
        '--toast-file',
        join(fixturesDir, 'smoke-toast.json'),
        '--start',
        '2026-05-10T00:00:00.000Z',
        '--end',
        '2026-05-11T00:00:00.000Z',
      ],
      dataDir,
    )
    const resilientListenOutput = await expectCliOk(
      [
        'backbone',
        'listen',
        '--once',
        '--interval-ms',
        '0',
        '--skip-toast',
        '--simulate-openclaw-failure',
      ],
      dataDir,
    )
    const backboneSimulation = await expectCliOk(['backbone', 'simulate', '--env', 'smoke', '--days', '30'], dataDir)
    const backboneAccuracy = await expectCliOk(['backbone', 'accuracy', '--env', 'smoke', '--min-samples', '3'], dataDir)
    const backboneMemory = await expectCliOk(['backbone', 'memory', '--env', 'smoke', '--limit', '5'], dataDir)
    const backboneDrift = await expectCliOk(['backbone', 'drift', '--env', 'smoke', '--min-samples', '3'], dataDir)
    const backboneIntake = await expectCliOk(['backbone', 'intake', '--limit', '5'], dataDir)
    const backboneRecipeSuggestions = await expectCliOk(['backbone', 'recipe-suggestions', '--limit', '5'], dataDir)
    const backboneGaps = await expectCliOk(['backbone', 'gaps', '--limit', '8'], dataDir)
    const recipeMap = await expectCliOk(['toast', 'map-recipe', 'Smoke Test Martini', 'House Vodka 1L', '75', 'ml'], dataDir)
    const remappedIntake = await expectCliOk(['backbone', 'intake', '--limit', '5'], dataDir)
    const backboneExplain = await expectCliOk(['backbone', 'explain', '--env', 'smoke', '--sku', 'Backbone Vodka 1L'], dataDir)
    const backboneBacktest = await expectCliOk(['backbone', 'backtest', '--env', 'smoke-rolling', '--days', '60', '--count-cadence-days', '30', '--limit', '5'], dataDir)
    const backboneBacktestMatrix = await expectCliOk(['backbone', 'backtest-matrix', '--env', 'smoke-rolling-matrix', '--days', '60', '--count-cadence-days', '30'], dataDir)
    const backboneVerify = await expectCliOk(['backbone', 'verify', '--env', 'smoke-verify', '--scenario', 'shrink', '--days', '60', '--count-cadence-days', '30'], dataDir)
    const backboneVerifyHistory = await expectCliOk(['backbone', 'verify-history'], dataDir)
    const backboneMatrix = await expectCliOk(['backbone', 'matrix', '--env', 'smoke-matrix', '--days', '30'], dataDir)
    await expectCliOk(['forecast', 'run'], dataDir)
    await expectCliOk(['orders', 'generate'], dataDir)
    const consoleOutput = await expectCliOk(['console'], dataDir)
    const backboneStatus = await expectCliOk(['backbone', 'status'], dataDir)
    const backboneAudit = await expectCliOk(['backbone', 'audit'], dataDir)
    const backboneMaintain = await expectCliOk(
      ['backbone', 'maintain', '--label', 'smoke-maintenance', '--limit', '5', '--verify', '--scenario', 'shrink', '--days', '60', '--count-cadence-days', '30'],
      dataDir,
    )
    const backboneTrust = await expectCliOk(['backbone', 'trust', '--limit', '6'], dataDir)
    const backboneMaintainHistory = await expectCliOk(['backbone', 'maintain-history'], dataDir)
    const backboneSnapshot = await expectCliOk(['backbone', 'snapshot', '--label', 'smoke-snapshot'], dataDir)
    const backboneSnapshotVerify = await expectCliOk(['backbone', 'snapshot-verify', '--label', 'smoke-snapshot'], dataDir)
    const backboneSnapshotRestore = await expectCliOk(['backbone', 'snapshot-restore', '--label', 'smoke-snapshot', '--env', 'restored-snapshot'], dataDir)
    const backboneActions = await expectCliOk(['backbone', 'actions'], dataDir)
    const backboneEnvs = await expectCliOk(['backbone', 'envs'], dataDir)

    expect(consoleOutput).toContain('Snapshot')
    expect(consoleOutput).toContain('Inventory')
    expect(consoleOutput).toContain('Open order recommendations')
    expect(initialDoctor).toContain('Backbone')
    expect(initialDoctor).toContain('no completed Backbone run yet')
    expect(backbonePlan).toContain('Backbone horizon plan')
    expect(backbonePlan).toContain('Horizon summary')
    expect(backbonePlan).toContain('Escalating risks')
    expect(backboneService).toContain('Backbone launchd service')
    expect(backboneService).toContain('com.barsbookkeeper.test')
    expect(backboneService).toContain('launchctl load')
    expect(backboneMaintainService).toContain('Backbone maintenance launchd service')
    expect(backboneMaintainService).toContain('com.barsbookkeeper.test-maintenance')
    expect(backboneMaintainService).toContain('startIntervalSeconds: 60')
    expect(backboneMaintainService).toContain('maintainArgs: --verify --scenario shrink --days 60 --count-cadence-days 30')
    expect(backboneMaintainService).toContain('launchctl load')
    expect(listenOutput).toContain('Backbone listener stopped after 2 cycles')
    expect(listenOutput).toContain('listener lock acquired')
    expect(listenOutput).toContain('file:')
    expect(resilientListenOutput).toContain('OpenClaw skipped this cycle: simulated_openclaw_failure')
    expect(resilientListenOutput).toContain('one-shot; interval: 0ms')
    expect(resilientListenOutput).toContain('Backbone listener stopped after 1 cycle')
    expect(backboneSimulation).toContain('bottleMae')
    expect(backboneSimulation).toContain('lowStockRecall')
    expect(backboneSimulation).toContain('uncertaintyCoverage')
    expect(backboneSimulation).toContain('meanBandBottles')
    expect(backboneRun).toContain('band')
    expect(backboneRun).toContain('stockout')
    expect(backboneAccuracy).toContain('Backbone accuracy')
    expect(backboneAccuracy).toContain('feedbackSamples: 3')
    expect(backboneAccuracy).toContain('feedbackBandCoverage')
    expect(backboneAccuracy).toContain('bandCoverage')
    expect(backboneAccuracy).toContain('SKU accuracy')
    expect(backboneAccuracy).toContain('Backbone Vodka 1L')
    expect(backboneMemory).toContain('Backbone memory')
    expect(backboneMemory).toContain('Learned SKU corrections')
    expect(backboneMemory).toContain('Recent feedback')
    expect(backboneMemory).toContain('inBand')
    expect(backboneMemory).toContain('Ungrounded current risks')
    expect(backboneDrift).toContain('Backbone learning drift')
    expect(backboneDrift).toContain('feedback sample floor: 3/3')
    expect(backboneDrift).toContain('overall bottle MAE')
    expect(backboneDrift).toContain('feedback band coverage')
    expect(backboneDrift).toContain('SKU drift watchlist')
    expect(backboneDrift).toContain('Backbon')
    expect(backboneDrift).toContain('centered')
    expect(backboneIntake).toContain('Backbone Toast intake')
    expect(backboneIntake).toContain('Toast recipe coverage')
    expect(backboneIntake).toContain('Missing recipe backlog')
    expect(backboneIntake).toContain('Smoke Test Martini')
    expect(backboneIntake).toContain('Suggested recipe mappings')
    expect(backboneIntake).toContain('House Vodka 1L')
    expect(backboneIntake).toContain('Recent mapped Toast consumption')
    expect(backboneRecipeSuggestions).toContain('Backbone recipe suggestions')
    expect(backboneRecipeSuggestions).toContain('Smoke Test Martini')
    expect(backboneRecipeSuggestions).toContain('House Vodka 1L')
    expect(backboneRecipeSuggestions).toContain('bbk toast map-recipe')
    expect(backboneRecipeSuggestions).toContain('suggestions: 1')
    expect(backboneGaps).toContain('Backbone data gaps')
    expect(backboneGaps).toContain('Prioritized gaps')
    expect(backboneGaps).toContain('map Toast recipe')
    expect(backboneGaps).toContain('Smoke Test Martini')
    expect(backboneGaps).toContain('House Vodka 1L')
    expect(backboneGaps).toContain('toastRecipeCoveragePct')
    expect(recipeMap).toContain('Toast recipe map')
    expect(recipeMap).toContain('backfilledEvents: 1')
    expect(recipeMap).toContain('suppressedReviews: 1')
    expect(remappedIntake).toContain('recipeCoveragePct: 100')
    expect(remappedIntake).toContain('openMissingRecipeReviews: 0')
    expect(remappedIntake).toContain('House Vodka 1L')
    expect(backboneExplain).toContain('Backbone explanation')
    expect(backboneExplain).toContain('Projection evidence')
    expect(backboneExplain).toContain('predictionBand')
    expect(backboneExplain).toContain('stockoutProbability')
    expect(backboneExplain).toContain('uncertainty')
    expect(backboneExplain).toContain('Cost evidence')
    expect(backboneExplain).toContain('leadTimeDays')
    expect(backboneExplain).toContain('Calibration evidence')
    expect(backboneExplain).toContain('Backbone Vodka 1L')
    expect(backboneBacktest).toContain('Backbone rolling backtest')
    expect(backboneBacktest).toContain('Rolling backtest smoke-rolling passed')
    expect(backboneBacktest).toContain('Worst prediction errors')
    expect(backboneBacktest).toContain('uncertaintyCoverage')
    expect(backboneBacktest).toContain('inBand')
    expect(backboneBacktestMatrix).toContain('Backbone rolling backtest matrix')
    expect(backboneBacktestMatrix).toContain('Backbone rolling backtest matrix passed 7/7 scenarios')
    expect(backboneVerify).toContain('Backbone verification gate')
    expect(backboneVerify).toContain('Validation-day gate')
    expect(backboneVerify).toContain('Rolling backtest gate')
    expect(backboneVerify).toContain('Backbone verification passed 1/1 scenario')
    expect(backboneVerifyHistory).toContain('Backbone verification history')
    expect(backboneVerifyHistory).toContain('passed')
    expect(backboneVerifyHistory).toContain('1/1')
    expect(backboneVerifyHistory).toContain('feedbackBandCoverage')
    expect(backboneMatrix).toContain('Backbone scenario matrix passed 7/7 scenarios')
    expect(backboneStatus).toContain('Listener health')
    expect(backboneStatus).toContain('Listener runtime lock')
    expect(backboneAudit).toContain('Backbone audit passed')
    expect(backboneAudit).toContain('listener heartbeat')
    expect(backboneAudit).toContain('listener runtime lock')
    expect(backboneAudit).toContain('prediction freshness')
    expect(backboneAudit).toContain('count grounding')
    expect(backboneAudit).toContain('toast recipe coverage')
    expect(backboneAudit).toContain('listener prediction link')
    expect(backboneAudit).toContain('unscored count feedback')
    expect(backboneAudit).toContain('feedback band coverage')
    expect(backboneAudit).toContain('learning drift')
    expect(backboneMaintain).toContain('Backbone maintenance')
    expect(backboneMaintain).toContain('Snapshot gate')
    expect(backboneMaintain).toContain('Verification gate')
    expect(backboneMaintain).toContain('Audit gate')
    expect(backboneMaintain).toContain('Data gap gate')
    expect(backboneMaintain).toContain('Command queue')
    expect(backboneMaintain).toContain('bbk backbone')
    expect(backboneMaintain).toContain('Backbone maintenance passed')
    expect(backboneTrust).toContain('Backbone trust report')
    expect(backboneTrust).toContain('readinessScore')
    expect(backboneTrust).toContain('feedbackBandCoverage')
    expect(backboneTrust).toContain('unscoredCountEvents')
    expect(backboneTrust).toContain('Trust gates')
    expect(backboneTrust).toContain('Next actions')
    expect(backboneTrust).toContain('bbk backbone')
    expect(backboneTrust).toContain('verification')
    expect(backboneTrust).toContain('uncertainty risk')
    expect(backboneTrust).toContain('calibration coverage')
    expect(ingestNotePreview).toContain('Ingest inventory note')
    expect(ingestNotePreview).toContain('dryRun: true')
    expect(ingestNotePreview).toContain('parsedRows: 2')
    expect(ingestNotePreview).toContain('House Vodka 1L')
    expect(ingestNotePreview).toContain('4500')
    expect(ingestNotePreview).toContain('Dry run only')
    expect(backboneTrust).toContain('latestMaintenance')
    expect(backboneMaintainHistory).toContain('Backbone maintenance history')
    expect(backboneMaintainHistory).toContain('smoke-main')
    expect(backboneMaintainHistory).toContain('auditWarnings')
    expect(backboneMaintainHistory).toContain('gaps')
    expect(backboneMaintainHistory).toContain('topAction')
    expect(backboneMaintainHistory).toContain('verification')
    expect(backboneSnapshot).toContain('Backbone snapshot')
    expect(backboneSnapshot).toContain('smoke-snapshot.sqlite')
    expect(backboneSnapshot).toContain('smoke-snapshot.manifest.json')
    expect(backboneSnapshotVerify).toContain('Backbone snapshot verification')
    expect(backboneSnapshotVerify).toContain('integrity: ok')
    expect(backboneSnapshotVerify).toContain('Snapshot smoke-snapshot verified.')
    expect(backboneSnapshotRestore).toContain('Backbone snapshot restore')
    expect(backboneSnapshotRestore).toContain('Snapshot smoke-snapshot restored into environment restored-snapshot.')
    expect(backboneSnapshotRestore).toContain('restored-snapshot')
    expect(backboneActions).toContain('Order now')
    expect(backboneActions).toContain('bbk ingest note')
    expect(backboneActions).toContain('Cost cuts')
    expect(backboneActions).toContain('bbk backbone explain --sku')
    expect(backboneEnvs).toContain('restored-snapshot')
    expect(backboneEnvs).toContain('smoke-matrix')
    expect(backboneEnvs).toContain('ready')

    db = openDatabase(join(dataDir, 'barsbookkeeper.sqlite'))
    const baseline = {
      sourceDocuments: scalar(db, 'SELECT COUNT(*) AS value FROM source_documents'),
      inventoryEvents: scalar(db, 'SELECT COUNT(*) AS value FROM inventory_events'),
      forecasts: scalar(db, 'SELECT COUNT(*) AS value FROM forecasts'),
      backboneRuns: scalar(db, 'SELECT COUNT(*) AS value FROM backbone_runs'),
      reviewTasks: scalar(db, "SELECT COUNT(*) AS value FROM openclaw_decisions WHERE state = 'needs_review'"),
      openOrders: scalar(db, "SELECT COUNT(*) AS value FROM order_recommendations WHERE status = 'open'"),
    }

    expect(baseline.sourceDocuments).toBeGreaterThanOrEqual(5)
    expect(baseline.forecasts).toBeGreaterThan(0)
    expect(baseline.backboneRuns).toBeGreaterThan(0)
    expect(baseline.reviewTasks).toBeGreaterThan(0)
    expect(baseline.openOrders).toBeGreaterThan(0)
    expect(
      scalar(db, "SELECT COUNT(*) AS value FROM evidence_items WHERE evidence_type = 'toast_missing_recipe'"),
    ).toBe(1)

    const plist = await readFile(join(dataDir, 'launchd', 'com.barsbookkeeper.test.plist'), 'utf8')
    expect(plist).toContain('<string>com.barsbookkeeper.test</string>')
    expect(plist).toContain('<key>BBK_DATA_DIR</key>')
    expect(plist).toContain(dataDir)
    expect(plist).toContain('<string>backbone</string>')
    expect(plist).toContain('<string>listen</string>')
    expect(plist).not.toContain('TOAST_API_KEY')
    expect(plist).not.toContain('TOAST_CLIENT_SECRET')
    const maintenancePlist = await readFile(join(dataDir, 'launchd', 'com.barsbookkeeper.test-maintenance.plist'), 'utf8')
    expect(maintenancePlist).toContain('<string>com.barsbookkeeper.test-maintenance</string>')
    expect(maintenancePlist).toContain('<key>StartInterval</key>')
    expect(maintenancePlist).toContain('<integer>60</integer>')
    expect(maintenancePlist).toContain('<string>backbone</string>')
    expect(maintenancePlist).toContain('<string>maintain</string>')
    expect(maintenancePlist).toContain('<string>--verify</string>')
    expect(maintenancePlist).toContain('<string>--scenario</string>')
    expect(maintenancePlist).toContain('<string>shrink</string>')
    expect(maintenancePlist).toContain('<string>--count-cadence-days</string>')
    expect(maintenancePlist).toContain('backbone-maintenance.out.log')
    expect(maintenancePlist).not.toContain('<key>KeepAlive</key>')
    expect(maintenancePlist).not.toContain('TOAST_API_KEY')
    expect(maintenancePlist).not.toContain('TOAST_CLIENT_SECRET')
    expect(existsSync(join(dataDir, 'backups', 'smoke-snapshot.sqlite'))).toBe(true)
    expect(existsSync(join(dataDir, 'backups', 'smoke-maintenance.sqlite'))).toBe(true)
    expect(existsSync(join(dataDir, 'backups', 'smoke-maintenance.manifest.json'))).toBe(true)
    const manifest = JSON.parse(await readFile(join(dataDir, 'backups', 'smoke-snapshot.manifest.json'), 'utf8')) as {
      counts: { backboneRuns: number; backbonePredictions: number; backboneVerifications: number }
      latestRun: { id: number } | null
      latestVerification: { status: string } | null
      toastCursor: { lastEnd?: string } | null
    }
    expect(manifest.counts.backboneRuns).toBeGreaterThan(0)
    expect(manifest.counts.backbonePredictions).toBeGreaterThan(0)
    expect(manifest.counts.backboneVerifications).toBe(2)
    const restoredPath = join(dataDir, 'environments', 'restored-snapshot', 'barsbookkeeper.sqlite')
    expect(existsSync(restoredPath)).toBe(true)
    const restoredDb = openDatabase(restoredPath)
    expect(toNumber(restoredDb.prepare('SELECT COUNT(*) AS value FROM backbone_runs').get()?.value)).toBe(
      manifest.counts.backboneRuns,
    )
    expect(toNumber(restoredDb.prepare('SELECT COUNT(*) AS value FROM backbone_predictions').get()?.value)).toBe(
      manifest.counts.backbonePredictions,
    )
    restoredDb.close()
    expect(manifest.latestRun?.id).toBeGreaterThan(0)
    expect(manifest.latestVerification?.status).toBe('passed')
    expect(manifest.toastCursor?.lastEnd).toBe('2026-05-11T00:00:00.000Z')
    expect(scalar(db, 'SELECT COUNT(*) AS value FROM backbone_listener_cycles')).toBe(3)
    expect(scalar(db, 'SELECT COUNT(*) AS value FROM backbone_verifications')).toBe(2)
    expect(scalar(db, "SELECT COUNT(*) AS value FROM backbone_verifications WHERE status = 'passed'")).toBe(2)
    expect(scalar(db, "SELECT COUNT(*) AS value FROM backbone_listener_cycles WHERE status = 'completed'")).toBe(3)
    expect(
      scalar(db, "SELECT COUNT(*) AS value FROM backbone_listener_cycles WHERE error_message LIKE 'openclaw:%'"),
    ).toBe(1)
    expect(scalar(db, "SELECT COUNT(*) AS value FROM backbone_toast_cursor WHERE last_end = '2026-05-11T00:00:00.000Z'")).toBe(1)
    expect(scalar(db, "SELECT COUNT(*) AS value FROM backbone_maintenance_runs WHERE snapshot_label = 'smoke-maintenance'")).toBe(1)
    const maintenanceSummary = JSON.parse(
      String(
        db
          .prepare("SELECT summary_json AS value FROM backbone_maintenance_runs WHERE snapshot_label = 'smoke-maintenance'")
          .get()?.value,
      ),
    ) as { nextActions?: Array<{ action?: string }>; verification?: { status?: string; passed?: number; minRollingFeedbackBandCoverage?: number } }
    expect(maintenanceSummary.nextActions?.some((row) => String(row.action ?? '').startsWith('bbk '))).toBe(true)
    expect(maintenanceSummary.verification?.status).toBe('passed')
    expect(maintenanceSummary.verification?.passed).toBe(1)
    expect(maintenanceSummary.verification?.minRollingFeedbackBandCoverage).toBeGreaterThanOrEqual(0.95)

    await expectCliOk(['setup'], dataDir)
    await expectCliOk(['seed-demo'], dataDir)
    await expectCliOk(['brain', 'run'], dataDir)
    await expectCliOk(['forecast', 'run'], dataDir)

    expect(scalar(db, 'SELECT COUNT(*) AS value FROM source_documents')).toBe(baseline.sourceDocuments)
    expect(scalar(db, 'SELECT COUNT(*) AS value FROM forecasts')).toBe(baseline.forecasts)
    expect(scalar(db, 'SELECT COUNT(*) AS value FROM backbone_runs')).toBeGreaterThanOrEqual(baseline.backboneRuns)
    expect(scalar(db, "SELECT COUNT(*) AS value FROM openclaw_decisions WHERE state = 'needs_review'")).toBe(
      baseline.reviewTasks,
    )

    await expectCliOk(['ingest', 'invoice', join(fixturesDir, 'smoke-invoice.csv')], dataDir)
    await expectCliOk(['ingest', 'count', join(fixturesDir, 'smoke-count.csv')], dataDir)
    await expectCliOk(['toast', 'pull', '--file', join(fixturesDir, 'smoke-toast.json')], dataDir)

    expect(scalar(db, 'SELECT COUNT(*) AS value FROM source_documents')).toBe(baseline.sourceDocuments)
    expect(scalar(db, 'SELECT COUNT(*) AS value FROM inventory_events')).toBe(baseline.inventoryEvents)
    await expectCliOk(['orders', 'generate'], dataDir)
    expect(scalar(db, "SELECT COUNT(*) AS value FROM order_recommendations WHERE status = 'open'")).toBe(
      baseline.openOrders,
    )
  }, 300_000)

  it('reports Toast setup problems without credentials and without making a network pull', async () => {
    await expectCliOk(['setup'], dataDir)

    const connect = await runCli(['toast', 'connect'], dataDir)
    expect(connect.code, connect.output).toBe(0)
    expect(connect.output).toContain('connected')
    expect(connect.output).toContain('false')
    expect(connect.output).toContain('TOAST_RESTAURANT_EXTERNAL_IDS')

    const pull = await runCli(['toast', 'pull'], dataDir)
    expect(pull.code).toBe(1)
    expect(pull.output).toContain('toast_restaurant_ids_missing')
    expect(pull.output).not.toContain('toast_pull_failed')
    expect(pull.output).not.toContain('toast_auth_failed')
  }, 30_000)

  it('recovers abandoned listener journal rows before starting a new Backbone cycle', async () => {
    await expectCliOk(['setup'], dataDir)
    await expectCliOk(['seed-demo'], dataDir)

    const recoveryDb = openDatabase(join(dataDir, 'barsbookkeeper.sqlite'))
    recoveryDb
      .prepare(
        `INSERT INTO backbone_listener_cycles (started_at, status)
         VALUES ('2026-05-01T00:00:00.000Z', 'running')`,
      )
      .run()
    recoveryDb.close()

    const output = await expectCliOk(
      ['backbone', 'listen', '--cycles', '1', '--interval-ms', '0', '--skip-toast', '--skip-openclaw', '--recover-stale-minutes', '0'],
      dataDir,
    )

    expect(output).toContain('Recovered 1 stale Backbone listener cycle.')
    expect(output).toContain('Backbone listener stopped after 1 cycle')

    db = openDatabase(join(dataDir, 'barsbookkeeper.sqlite'))
    expect(
      scalar(db, "SELECT COUNT(*) AS value FROM backbone_listener_cycles WHERE status = 'failed' AND error_message = 'recovered stale running cycle on listener startup'"),
    ).toBe(1)
    expect(scalar(db, "SELECT COUNT(*) AS value FROM backbone_listener_cycles WHERE status = 'completed'")).toBe(1)
    expect(scalar(db, 'SELECT COUNT(*) AS value FROM backbone_runs')).toBe(1)
    expect(scalar(db, 'SELECT COUNT(*) AS value FROM backbone_runtime_locks')).toBe(0)
  }, 60_000)

  it('takes over stale Backbone listener locks but rejects active concurrent listeners', async () => {
    await expectCliOk(['setup'], dataDir)
    await expectCliOk(['seed-demo'], dataDir)

    const lockDb = openDatabase(join(dataDir, 'barsbookkeeper.sqlite'))
    lockDb
      .prepare(
        `INSERT INTO backbone_runtime_locks (name, owner, acquired_at, heartbeat_at, expires_at)
         VALUES ('backbone-listener', 'stale-owner', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z', '2026-05-01T00:01:00.000Z')`,
      )
      .run()
    lockDb.close()

    const recovered = await expectCliOk(
      ['backbone', 'listen', '--cycles', '1', '--interval-ms', '0', '--skip-toast', '--skip-openclaw'],
      dataDir,
    )
    expect(recovered).toContain('listener lock acquired')

    db = openDatabase(join(dataDir, 'barsbookkeeper.sqlite'))
    expect(scalar(db, 'SELECT COUNT(*) AS value FROM backbone_runtime_locks')).toBe(0)
    db.close()
    db = undefined

    const activeDb = openDatabase(join(dataDir, 'barsbookkeeper.sqlite'))
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()
    activeDb
      .prepare(
        `INSERT INTO backbone_runtime_locks (name, owner, acquired_at, heartbeat_at, expires_at)
         VALUES ('backbone-listener', 'active-owner', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)`,
      )
      .run(expiresAt)
    activeDb.close()

    const status = await expectCliOk(['backbone', 'status'], dataDir)
    expect(status).toContain('Listener runtime lock')
    expect(status).toContain('active-owner')
    expect(status).toContain('active')

    const blocked = await runCli(
      ['backbone', 'listen', '--cycles', '1', '--interval-ms', '0', '--skip-toast', '--skip-openclaw'],
      dataDir,
    )
    expect(blocked.code).toBe(1)
    expect(blocked.output).toContain('backbone_listener_lock_held:active-owner')
  }, 60_000)

  it('does not treat manual corrections as terminal sparse-count grounding', async () => {
    await expectCliOk(['setup'], dataDir)

    const correctionDb = openDatabase(join(dataDir, 'barsbookkeeper.sqlite'))
    try {
      const skuId = ensureSku(correctionDb, { name: 'Manual Correction Vodka 1L', unit: 'ml', category: 'liquor' })
      createInventoryEvent(correctionDb, {
        skuId,
        eventType: 'adjustment',
        quantity: 1000,
        unit: 'ml',
        occurredAt: new Date().toISOString(),
        note: 'Opening correction without count evidence',
      })
    } finally {
      correctionDb.close()
    }

    const gaps = await expectCliOk(['backbone', 'gaps', '--limit', '5', '--max-count-age-days', '30'], dataDir)
    expect(gaps).toContain('refresh sparse count')
    expect(gaps).toContain('Manual Correction Vodka 1L')
    expect(gaps).toContain('no hand count yet')
  }, 30_000)

  it('uses configurable feedback target age for unscored count gaps', async () => {
    await expectCliOk(['setup'], dataDir)

    const targetDb = openDatabase(join(dataDir, 'barsbookkeeper.sqlite'))
    try {
      ingestInvoices(targetDb, [
        {
          vendor: 'Target Age Distributor',
          invoiceNumber: 'TARGET-AGE-OPEN',
          invoiceDate: '2026-01-01T09:00:00.000Z',
          sku: 'Target Age Vodka 1L',
          quantity: 1000,
          unit: 'ml',
          unitCost: 0.02,
          category: 'liquor',
        },
      ])
      runBackboneModel(targetDb, {
        asOf: '2026-01-01T12:00:00.000Z',
        horizonDays: 1,
        usageWindowDays: 7,
        mode: 'evaluation',
      })
      ingestCounts(targetDb, [
        {
          countId: 'TARGET-AGE-LATE-COUNT',
          occurredAt: '2026-01-20T12:00:00.000Z',
          sku: 'Target Age Vodka 1L',
          countedQuantity: 700,
          unit: 'ml',
        },
      ])
      expect(scalar(targetDb, 'SELECT COUNT(*) AS value FROM backbone_predictions')).toBeGreaterThan(0)
      expect(unscoredCountFeedback(targetDb, { maxTargetAgeDays: 30 })).toHaveLength(0)
    } finally {
      targetDb.close()
    }

    const strictGaps = await expectCliOk(['backbone', 'gaps', '--limit', '8', '--max-feedback-target-age-days', '14'], dataDir)
    expect(strictGaps).toContain('restore prediction cadence')
    expect(strictGaps).toContain('Target Age Vodka 1L')

    const relaxedGaps = await expectCliOk(['backbone', 'gaps', '--limit', '8', '--max-feedback-target-age-days', '30'], dataDir)
    expect(relaxedGaps).not.toContain('restore prediction cadence')
    expect(relaxedGaps).toContain('unscoredCountEvents: 0')
  }, 120_000)

  it('dry-runs and force-prunes isolated Backbone environments safely', async () => {
    await expectCliOk(['setup'], dataDir)
    await expectCliOk(['backbone', 'simulate', '--env', 'prune-a', '--days', '30'], dataDir)
    await expectCliOk(['backbone', 'simulate', '--env', 'prune-b', '--days', '30'], dataDir)

    const pruneAPath = join(dataDir, 'environments', 'prune-a', 'barsbookkeeper.sqlite')
    const pruneBPath = join(dataDir, 'environments', 'prune-b', 'barsbookkeeper.sqlite')
    expect(existsSync(pruneAPath)).toBe(true)
    expect(existsSync(pruneBPath)).toBe(true)

    const dryRun = await expectCliOk(['backbone', 'env-prune', '--older-than-days', '0', '--keep', '0'], dataDir)
    expect(dryRun).toContain('Backbone environment prune')
    expect(dryRun).toContain('dryRun: true')
    expect(dryRun).toContain('would-prune')
    expect(dryRun).toContain('Dry run only')
    expect(existsSync(pruneAPath)).toBe(true)
    expect(existsSync(pruneBPath)).toBe(true)

    const forced = await expectCliOk(['backbone', 'env-prune', '--older-than-days', '0', '--keep', '0', '--force'], dataDir)
    expect(forced).toContain('dryRun: false')
    expect(forced).toContain('Pruned 2 Backbone environments.')
    expect(existsSync(pruneAPath)).toBe(false)
    expect(existsSync(pruneBPath)).toBe(false)

    db = openDatabase(join(dataDir, 'barsbookkeeper.sqlite'))
    expect(
      scalar(db, "SELECT COUNT(*) AS value FROM backbone_environments WHERE name IN ('prune-a', 'prune-b')"),
    ).toBe(0)
  }, 90_000)

  it('rejects unsafe snapshot restore environment paths', async () => {
    await expectCliOk(['setup'], dataDir)
    await expectCliOk(['seed-demo'], dataDir)
    await expectCliOk(['backbone', 'run'], dataDir)
    await expectCliOk(['backbone', 'snapshot', '--label', 'unsafe-restore-check'], dataDir)

    const restore = await runCli(['backbone', 'snapshot-restore', '--label', 'unsafe-restore-check', '--env', '..', '--force'], dataDir)
    expect(restore.code).toBe(1)
    expect(restore.output).toContain('unsafe_restore_environment_path')
    expect(existsSync(join(dataDir, 'barsbookkeeper.sqlite'))).toBe(true)
  }, 60_000)

  it('fails closed on malformed ingest and recipe command options', async () => {
    const unknownNoteOption = await runCli(
      ['ingest', 'note', 'House Vodka 1L 4 bottles', '--dry-rnu'],
      dataDir,
    )
    expect(unknownNoteOption.code).toBe(1)
    expect(unknownNoteOption.output).toContain('Unknown inventory note option: --dry-rnu')

    const invalidTimestamp = await runCli(
      ['ingest', 'note', 'House Vodka 1L 4 bottles', '--as-of', 'not-a-date'],
      dataDir,
    )
    expect(invalidTimestamp.code).toBe(1)
    expect(invalidTimestamp.output).toContain('--as-of_invalid')

    const unknownRecipeOption = await runCli(
      ['toast', 'map-recipe', 'House Martini', 'House Vodka 1L', '75', 'ml', '--yeild', '2'],
      dataDir,
    )
    expect(unknownRecipeOption.code).toBe(1)
    expect(unknownRecipeOption.output).toContain('Unknown Toast recipe option: --yeild')

    const extraInvoiceArgument = await runCli(
      ['ingest', 'invoice', join(fixturesDir, 'smoke-invoice.csv'), 'unexpected'],
      dataDir,
    )
    expect(extraInvoiceArgument.code).toBe(1)
    expect(extraInvoiceArgument.output).toContain('Missing or invalid invoice path')
  }, 60_000)

  it('runs the full Backbone acceptance drill in fresh isolated environments', async () => {
    await expectCliOk(['setup'], dataDir)

    const output = await expectCliOk(
      ['backbone', 'acceptance', '--env', 'accept-smoke', '--scenario', 'shrink', '--days', '60', '--count-cadence-days', '30'],
      dataDir,
    )
    expect(output).toContain('Backbone acceptance drill')
    expect(output).toContain('fresh prefix: accept-smoke-')
    expect(output).toContain('Validation-day gate')
    expect(output).toContain('Rolling sparse-count gate')
    expect(output).toContain('Learning drift gate')
    expect(output).toContain('Snapshot restore gate')
    expect(output).toContain('Backbone acceptance drill passed 1/1 scenario.')

    const backups = await readdir(join(dataDir, 'backups'))
    expect(backups.some((file) => file.startsWith('accept-smoke-') && file.endsWith('.sqlite'))).toBe(true)
    expect(backups.some((file) => file.startsWith('accept-smoke-') && file.endsWith('.manifest.json'))).toBe(true)

    db = openDatabase(join(dataDir, 'barsbookkeeper.sqlite'))
    expect(scalar(db, "SELECT COUNT(*) AS value FROM backbone_verifications WHERE status = 'passed'")).toBe(1)
    const verificationSummary = JSON.parse(
      String(db.prepare("SELECT summary_json AS value FROM backbone_verifications WHERE status = 'passed'").get()?.value),
    ) as {
      minRollingFeedbackBandCoverage?: number
      scenarios?: Array<{ validation?: { feedbackBandCoverage?: number }; rolling?: { feedbackBandCoverage?: number } }>
    }
    expect(verificationSummary.minRollingFeedbackBandCoverage).toBeGreaterThanOrEqual(0.95)
    expect(verificationSummary.scenarios?.[0]?.validation?.feedbackBandCoverage).toBeGreaterThanOrEqual(0.8)
    expect(verificationSummary.scenarios?.[0]?.rolling?.feedbackBandCoverage).toBeGreaterThanOrEqual(0.95)
    expect(
      scalar(db, "SELECT COUNT(*) AS value FROM backbone_environments WHERE name LIKE 'accept-smoke-%-restore'"),
    ).toBe(1)
    expect(
      scalar(db, "SELECT COUNT(*) AS value FROM backbone_environments WHERE name LIKE 'accept-smoke-%-validation-shrink'"),
    ).toBe(1)
    expect(
      scalar(db, "SELECT COUNT(*) AS value FROM backbone_environments WHERE name LIKE 'accept-smoke-%-rolling-shrink'"),
    ).toBe(1)
  }, 60_000)
})
