import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readUsageLedger } from '../src/openclaw/usage.js'

const execFileAsync = promisify(execFile)

describe('OpenClaw usage ledger concurrency', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('retains records from concurrent writers', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'bbk-usage-concurrency-'))
    vi.stubEnv('BBK_DATA_DIR', dataDir)
    const script = [
      "import { recordOpenClawUsage } from './src/openclaw/usage.ts'",
      "recordOpenClawUsage({ model: 'test-model', prompt: 'input', output: 'output' })",
    ].join(';')

    try {
      await Promise.all(
        Array.from({ length: 12 }, () =>
          execFileAsync(
            process.execPath,
            ['--import', 'tsx/esm', '--input-type=module', '--eval', script],
            {
              cwd: process.cwd(),
              env: { ...process.env, BBK_DATA_DIR: dataDir },
              timeout: 30_000,
            },
          ),
        ),
      )

      expect(readUsageLedger().records).toHaveLength(12)
    } finally {
      await rm(dataDir, { force: true, recursive: true })
    }
  }, 40_000)
})
