import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, toNumber, type Db } from '../src/db/database.js'

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
      timeout: 20_000,
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
    await expectCliOk(['toast', 'pull', '--file', join(fixturesDir, 'smoke-toast.json')], dataDir)
    await expectCliOk(['brain', 'run'], dataDir)
    await expectCliOk(['backbone', 'run'], dataDir)
    const backbonePlan = await expectCliOk(['backbone', 'plan', '--horizons', '1,7,14'], dataDir)
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
        '--cycles',
        '1',
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
    const backboneIntake = await expectCliOk(['backbone', 'intake', '--limit', '5'], dataDir)
    const recipeMap = await expectCliOk(['toast', 'map-recipe', 'Smoke Test Martini', 'House Vodka 1L', '75', 'ml'], dataDir)
    const remappedIntake = await expectCliOk(['backbone', 'intake', '--limit', '5'], dataDir)
    const backboneExplain = await expectCliOk(['backbone', 'explain', '--env', 'smoke', '--sku', 'Backbone Vodka 1L'], dataDir)
    const backboneBacktest = await expectCliOk(['backbone', 'backtest', '--env', 'smoke-rolling', '--days', '60', '--count-cadence-days', '30', '--limit', '5'], dataDir)
    const backboneBacktestMatrix = await expectCliOk(['backbone', 'backtest-matrix', '--env', 'smoke-rolling-matrix', '--days', '60', '--count-cadence-days', '30'], dataDir)
    const backboneMatrix = await expectCliOk(['backbone', 'matrix', '--env', 'smoke-matrix', '--days', '30'], dataDir)
    await expectCliOk(['forecast', 'run'], dataDir)
    await expectCliOk(['orders', 'generate'], dataDir)
    const consoleOutput = await expectCliOk(['console'], dataDir)
    const backboneStatus = await expectCliOk(['backbone', 'status'], dataDir)
    const backboneAudit = await expectCliOk(['backbone', 'audit'], dataDir)
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
    expect(listenOutput).toContain('Backbone listener stopped after 2 cycles')
    expect(listenOutput).toContain('file:')
    expect(resilientListenOutput).toContain('OpenClaw skipped this cycle: simulated_openclaw_failure')
    expect(resilientListenOutput).toContain('Backbone listener stopped after 1 cycle')
    expect(backboneSimulation).toContain('bottleMae')
    expect(backboneSimulation).toContain('lowStockRecall')
    expect(backboneAccuracy).toContain('Backbone accuracy')
    expect(backboneAccuracy).toContain('feedbackSamples: 3')
    expect(backboneAccuracy).toContain('SKU accuracy')
    expect(backboneAccuracy).toContain('Backbone Vodka 1L')
    expect(backboneMemory).toContain('Backbone memory')
    expect(backboneMemory).toContain('Learned SKU corrections')
    expect(backboneMemory).toContain('Recent feedback')
    expect(backboneMemory).toContain('Ungrounded current risks')
    expect(backboneIntake).toContain('Backbone Toast intake')
    expect(backboneIntake).toContain('Toast recipe coverage')
    expect(backboneIntake).toContain('Missing recipe backlog')
    expect(backboneIntake).toContain('Smoke Test Martini')
    expect(backboneIntake).toContain('Recent mapped Toast consumption')
    expect(recipeMap).toContain('Toast recipe map')
    expect(recipeMap).toContain('backfilledEvents: 1')
    expect(recipeMap).toContain('suppressedReviews: 1')
    expect(remappedIntake).toContain('recipeCoveragePct: 100')
    expect(remappedIntake).toContain('openMissingRecipeReviews: 0')
    expect(remappedIntake).toContain('House Vodka 1L')
    expect(backboneExplain).toContain('Backbone explanation')
    expect(backboneExplain).toContain('Projection evidence')
    expect(backboneExplain).toContain('Cost evidence')
    expect(backboneExplain).toContain('Calibration evidence')
    expect(backboneExplain).toContain('Backbone Vodka 1L')
    expect(backboneBacktest).toContain('Backbone rolling backtest')
    expect(backboneBacktest).toContain('Rolling backtest smoke-rolling passed')
    expect(backboneBacktest).toContain('Worst prediction errors')
    expect(backboneBacktestMatrix).toContain('Backbone rolling backtest matrix')
    expect(backboneBacktestMatrix).toContain('Backbone rolling backtest matrix passed 6/6 scenarios')
    expect(backboneMatrix).toContain('Backbone scenario matrix passed 6/6 scenarios')
    expect(backboneStatus).toContain('Listener health')
    expect(backboneAudit).toContain('Backbone audit passed')
    expect(backboneAudit).toContain('listener heartbeat')
    expect(backboneAudit).toContain('prediction freshness')
    expect(backboneAudit).toContain('count grounding')
    expect(backboneAudit).toContain('toast recipe coverage')
    expect(backboneAudit).toContain('listener prediction link')
    expect(backboneActions).toContain('Order now')
    expect(backboneActions).toContain('Cost cuts')
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
    expect(scalar(db, 'SELECT COUNT(*) AS value FROM backbone_listener_cycles')).toBe(3)
    expect(scalar(db, "SELECT COUNT(*) AS value FROM backbone_listener_cycles WHERE status = 'completed'")).toBe(3)
    expect(
      scalar(db, "SELECT COUNT(*) AS value FROM backbone_listener_cycles WHERE error_message LIKE 'openclaw:%'"),
    ).toBe(1)
    expect(scalar(db, "SELECT COUNT(*) AS value FROM backbone_toast_cursor WHERE last_end = '2026-05-11T00:00:00.000Z'")).toBe(1)

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
  }, 20_000)

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
  })

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
  })

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
  })
})
