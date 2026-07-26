import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import type { AppConfig, ModelEffort } from '../config.js'
import { recordOpenClawUsage } from './usage.js'

const execFileAsync = promisify(execFile)

export type CodexStatus = {
  installed: boolean
  loggedIn: boolean
  statusText: string
}

export type CodexJsonRequest = {
  model: string
  reasoningEffort: ModelEffort
  system: string
  task: string
  fallback?: unknown
}

const stripFence = (value: string) => {
  const trimmed = value.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  return fenced ? fenced[1].trim() : trimmed
}

export const readCodexStatus = async (): Promise<CodexStatus> => {
  try {
    const { stdout, stderr } = await execFileAsync('codex', ['login', 'status'], {
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    })
    const statusText = `${stdout}${stderr}`.trim()
    return {
      installed: true,
      loggedIn: /Logged in using ChatGPT/i.test(statusText),
      statusText,
    }
  } catch (err: any) {
    return {
      installed: false,
      loggedIn: false,
      statusText: err?.code === 'ENOENT' ? 'codex_not_available' : 'codex_login_not_confirmed',
    }
  }
}

export const runCodexJson = async <T>(request: CodexJsonRequest): Promise<T> => {
  const prompt = [
    request.system,
    '',
    'Return only strict JSON. Do not include Markdown fences, commentary, or trailing prose.',
    '',
    request.task,
  ].join('\n')

  try {
    const { stdout } = await runCodexWithPrivateStdin(
      [
        'exec',
        '--ephemeral',
        '--ignore-rules',
        '--ignore-user-config',
        '--skip-git-repo-check',
        '--sandbox',
        'read-only',
        '--model',
        request.model,
        '-c',
        `model_reasoning_effort="${request.reasoningEffort}"`,
        '-',
      ],
      prompt,
    )
    recordOpenClawUsage({
      model: request.model,
      prompt,
      output: stdout,
      source: 'codex',
    })
    return JSON.parse(stripFence(stdout)) as T
  } catch (err) {
    if (request.fallback !== undefined) return request.fallback as T
    throw err
  }
}

const runCodexWithPrivateStdin = (
  args: string[],
  input: string,
  options: { timeoutMs?: number; maxBufferBytes?: number } = {},
): Promise<{ stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    const timeoutMs = options.timeoutMs ?? 180_000
    const maxBufferBytes = options.maxBufferBytes ?? 8 * 1024 * 1024
    const child = spawn('codex', args, {
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false

    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (error) reject(error)
      else resolve({ stdout, stderr })
    }
    const append = (current: string, chunk: Buffer): string => {
      const next = current + chunk.toString('utf8')
      if (Buffer.byteLength(next, 'utf8') > maxBufferBytes) {
        child.kill('SIGKILL')
        finish(new Error('codex_output_limit_exceeded'))
      }
      return next
    }

    child.stdout.on('data', (chunk: Buffer) => {
      stdout = append(stdout, chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = append(stderr, chunk)
    })
    child.on('error', (error) => finish(error))
    child.on('close', (code, signal) => {
      if (code === 0) finish()
      else finish(new Error(`codex_execution_failed:${code ?? signal ?? 'unknown'}`))
    })
    child.stdin.on('error', () => undefined)
    child.stdin.end(input)

    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      finish(new Error('codex_execution_timed_out'))
    }, timeoutMs)
    timeout.unref()
  })

export const smokeTestCodexModel = async (model: string, reasoningEffort: ModelEffort) => {
  return runCodexJson<{ ok: boolean; model: string }>({
    model,
    reasoningEffort,
    system: 'You are a model availability smoke test.',
    task: `Return {"ok":true,"model":"${model}"}.`,
  })
}

export const smokeTestConfiguredModels = async (config: AppConfig) => {
  const logic = await smokeTestCodexModel(config.logicModel, config.logicReasoningEffort)
  const fast = await smokeTestCodexModel(config.fastModel, config.fastReasoningEffort)
  return { logic, fast }
}
