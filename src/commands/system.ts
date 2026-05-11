import { execFile } from 'node:child_process'
import { mkdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { callBackend, BackendUnavailableError, withBackendDb } from './backend.js'
import { runServiceCommand } from './service-command.js'
import type { CommandContext } from './types.js'

const execFileAsync = promisify(execFile)

export const setup = async (_args: string[], context: CommandContext): Promise<void> => {
  const { terminal, config } = context
  terminal.title('Bars Bookkeeper setup')
  await mkdir(config.dataDir, { recursive: true })
  await mkdir(config.filesDir, { recursive: true })
  terminal.success(`Data directory ready: ${config.dataDir}`)
  terminal.success(`File store ready: ${config.filesDir}`)

  await withBackendDb(config, async () => undefined)
  terminal.success('Database ready.')
}

export const seedDemo = async (args: string[], context: CommandContext): Promise<void> =>
  runServiceCommand(args, context, {
    title: 'Seed demo data',
    started: 'Looking for demo seed service...',
    done: 'Demo data seed completed.',
    missing: 'Demo seed service is not present yet.',
    modules: ['../db/seed.js', '../ingest/seed-demo.js', '../ingest/demo.js'],
    exports: ['seedDemo', 'seedDemoData', 'seedDemoTenant'],
    withDb: true,
    args: (_rawArgs, _context, { db }) => [db],
  })

export const seedFieldDemo = async (args: string[], context: CommandContext): Promise<void> =>
  runServiceCommand(args, context, {
    title: 'Seed field demo',
    started: 'Generating field-style invoices, Toast sales, counts, forecasts, and orders...',
    done: 'Field demo workflow completed.',
    missing: 'Field demo service is not present yet.',
    modules: ['../db/fieldDemo.js'],
    exports: ['seedFieldDemoRun'],
    withDb: true,
    args: (_rawArgs, _context, { db }) => [db],
  })

export const doctor = async (_args: string[], context: CommandContext): Promise<void> => {
  const { terminal, config } = context
  terminal.title('Bars Bookkeeper doctor')

  terminal.section('Project')
  await checkPath('data directory', config.dataDir, terminal)
  await checkPath('file store', config.filesDir, terminal)
  terminal.status('info', `database path: ${config.dbPath}`)
  terminal.status('info', `logic model: ${config.logicModel}`, `effort=${config.logicReasoningEffort}`)
  terminal.status('info', `fast model: ${config.fastModel}`, `effort=${config.fastReasoningEffort}`)

  terminal.section('Codex')
  await checkCodex(terminal)

  terminal.section('Model smoke')
  if (process.env.BBK_SKIP_MODEL_SMOKE === '1') {
    terminal.status('skip', 'model smoke check skipped', 'BBK_SKIP_MODEL_SMOKE=1')
    return
  }
  await checkModelSmoke(context)
}

const checkPath = async (
  label: string,
  path: string,
  terminal: CommandContext['terminal'],
): Promise<void> => {
  try {
    const info = await stat(path)
    terminal.status(info.isDirectory() ? 'ok' : 'warn', `${label}: ${path}`)
  } catch {
    terminal.status('warn', `${label} missing: ${path}`, 'run `bbk setup`')
  }
}

const checkCodex = async (terminal: CommandContext['terminal']): Promise<void> => {
  try {
    const call = await callBackend(
      ['../openclaw/codexProvider.js'],
      ['readCodexStatus'],
      [],
    )
    const status = call.result as { installed?: boolean; loggedIn?: boolean; statusText?: string }
    terminal.status(status.installed ? 'ok' : 'warn', 'codex CLI availability', status.statusText)
    terminal.status(status.loggedIn ? 'ok' : 'warn', 'codex login status', status.loggedIn ? 'logged in' : 'not confirmed')
    return
  } catch (error) {
    if (!(error instanceof BackendUnavailableError)) throw error
  }

  const version = await runCommand('codex', ['--version'])
  if (version.ok) terminal.status('ok', 'codex CLI available', firstLine(version.output))
  else terminal.status('warn', 'codex CLI not found on PATH')

  const authStatus = await runCommand('codex', ['login', 'status'])
  if (authStatus.ok) {
    terminal.status('ok', 'codex login status', firstLine(authStatus.output))
    return
  }

  const authFile = resolve(homedir(), '.codex', 'auth.json')
  try {
    await stat(authFile)
    terminal.status('ok', 'codex login file present', authFile)
  } catch {
    terminal.status('warn', 'codex login was not confirmed', 'run `codex login` if model calls fail')
  }
}

const checkModelSmoke = async (context: CommandContext): Promise<void> => {
  try {
    const call = await callBackend(
      ['../openclaw/codexProvider.js', '../brain/provider.js', '../brain/model-provider.js', '../brain/openclaw.js', '../brain/index.js'],
      ['smokeTestConfiguredModels', 'smokeTestModel', 'runModelSmokeCheck', 'smokeCheckModel', 'checkModelProvider'],
      [context.config],
    )
    context.terminal.status('ok', 'provider smoke check passed')
    context.terminal.subtitle(`backend: ${call.module} -> ${call.exportName}`)
    context.terminal.dump(call.result)
  } catch (error) {
    if (error instanceof BackendUnavailableError) {
      context.terminal.status('skip', 'model smoke provider is not present yet')
      context.terminal.subtitle('expected exports: smokeTestConfiguredModels, smokeTestModel, runModelSmokeCheck, smokeCheckModel, checkModelProvider')
      return
    }
    context.terminal.status('fail', 'model smoke check failed')
    throw error
  }
}

const runCommand = async (
  command: string,
  args: string[],
): Promise<{ ok: true; output: string } | { ok: false; output: string }> => {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { timeout: 5000 })
    return { ok: true, output: `${stdout}${stderr}`.trim() }
  } catch (error) {
    const output =
      typeof error === 'object' && error !== null && 'stderr' in error ? String(error.stderr).trim() : ''
    return { ok: false, output }
  }
}

const firstLine = (value: string): string | undefined => value.split(/\r?\n/).find(Boolean)
