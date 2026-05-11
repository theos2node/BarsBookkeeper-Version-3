import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { AppConfig, ModelEffort } from '../config.js'

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
      statusText: err?.message || 'codex_not_available',
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
    const { stdout } = await execFileAsync(
      'codex',
      [
        'exec',
        '--model',
        request.model,
        '-c',
        `model_reasoning_effort="${request.reasoningEffort}"`,
        prompt,
      ],
      {
        timeout: 180000,
        maxBuffer: 8 * 1024 * 1024,
      }
    )
    return JSON.parse(stripFence(stdout)) as T
  } catch (err) {
    if (request.fallback !== undefined) return request.fallback as T
    throw err
  }
}

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
