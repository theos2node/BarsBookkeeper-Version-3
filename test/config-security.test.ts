import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getConfig } from '../src/config.js'

const originalCwd = process.cwd()
const managedEnvironment = [
  'BBK_DATA_DIR',
  'BBK_ENV_FILE',
  'OPENCLAW_LOGIC_MODEL',
  'OPENCLAW_LOGIC_REASONING_EFFORT',
] as const
const originalEnvironment = Object.fromEntries(
  managedEnvironment.map((key) => [key, process.env[key]]),
) as Record<(typeof managedEnvironment)[number], string | undefined>

describe('configuration security', () => {
  afterEach(() => {
    process.chdir(originalCwd)
    vi.unstubAllEnvs()
    for (const key of managedEnvironment) {
      const value = originalEnvironment[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it('loads local environment files without overriding exported values', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bbk-config-'))
    try {
      await writeFile(
        join(directory, '.env'),
        'OPENCLAW_LOGIC_MODEL=base-file-model\nBBK_DATA_DIR=./from-env\n',
        'utf8',
      )
      await writeFile(join(directory, '.env.local'), 'OPENCLAW_LOGIC_MODEL=local-file-model\n', 'utf8')
      for (const key of managedEnvironment) delete process.env[key]
      process.chdir(directory)

      const config = getConfig()
      const canonicalDirectory = process.cwd()

      expect(config.logicModel).toBe('local-file-model')
      expect(config.dataDir).toBe(join(canonicalDirectory, 'from-env'))
      expect(config.envFiles).toEqual([
        join(canonicalDirectory, '.env.local'),
        join(canonicalDirectory, '.env'),
      ])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects an unsafe filesystem-root data directory', () => {
    vi.stubEnv('BBK_DATA_DIR', '/')
    expect(() => getConfig()).toThrow('unsafe_data_directory:/')
  })

  it('rejects misspelled model effort instead of silently changing behavior', () => {
    vi.stubEnv('OPENCLAW_LOGIC_REASONING_EFFORT', 'extreme')
    expect(() => getConfig()).toThrow('invalid_model_reasoning_effort:extreme')
  })
})
