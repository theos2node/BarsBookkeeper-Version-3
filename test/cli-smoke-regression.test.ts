import { execFile } from 'node:child_process'
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
    await expectCliOk(['doctor'], dataDir)
    await expectCliOk(['seed-demo'], dataDir)
    await expectCliOk(['ingest', 'invoice', join(fixturesDir, 'smoke-invoice.csv')], dataDir)
    await expectCliOk(['ingest', 'count', join(fixturesDir, 'smoke-count.csv')], dataDir)
    await expectCliOk(['toast', 'pull', '--file', join(fixturesDir, 'smoke-toast.json')], dataDir)
    await expectCliOk(['brain', 'run'], dataDir)
    await expectCliOk(['backbone', 'run'], dataDir)
    const listenOutput = await expectCliOk(
      ['backbone', 'listen', '--cycles', '2', '--interval-ms', '0', '--toast-file', join(fixturesDir, 'smoke-toast.json')],
      dataDir,
    )
    const backboneSimulation = await expectCliOk(['backbone', 'simulate', '--env', 'smoke', '--days', '30'], dataDir)
    const backboneMatrix = await expectCliOk(['backbone', 'matrix', '--env', 'smoke-matrix', '--days', '30'], dataDir)
    await expectCliOk(['forecast', 'run'], dataDir)
    await expectCliOk(['orders', 'generate'], dataDir)
    const consoleOutput = await expectCliOk(['console'], dataDir)
    const backboneStatus = await expectCliOk(['backbone', 'status'], dataDir)

    expect(consoleOutput).toContain('Snapshot')
    expect(consoleOutput).toContain('Inventory')
    expect(consoleOutput).toContain('Open order recommendations')
    expect(listenOutput).toContain('Backbone listener stopped after 2 cycles')
    expect(listenOutput).toContain('file:')
    expect(backboneSimulation).toContain('bottleMae')
    expect(backboneSimulation).toContain('lowStockRecall')
    expect(backboneMatrix).toContain('Backbone scenario matrix passed 3/3 scenarios')
    expect(backboneStatus).toContain('Listener health')

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
    expect(scalar(db, 'SELECT COUNT(*) AS value FROM backbone_listener_cycles')).toBe(2)
    expect(scalar(db, "SELECT COUNT(*) AS value FROM backbone_listener_cycles WHERE status = 'completed'")).toBe(2)

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
})
