import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runCodexJson } from '../src/openclaw/codexProvider.js'

describe('Codex provider security', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('passes business context over stdin and keeps the usage ledger private', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bbk-codex-provider-'))
    const fakeCodex = join(directory, 'codex')
    const marker = 'sensitive-task-marker'
    const secret = 'must-not-reach-codex'

    try {
      await writeFile(
        fakeCodex,
        `#!/usr/bin/env node
const args = process.argv.slice(2)
let input = ''
for await (const chunk of process.stdin) input += chunk
console.log(JSON.stringify({
  markerInArgs: args.some((arg) => arg.includes('${marker}')),
  markerInStdin: input.includes('${marker}'),
  ephemeral: args.includes('--ephemeral'),
  readOnly: args.includes('--sandbox') && args.includes('read-only'),
  secretPresent: process.env.TOAST_CLIENT_SECRET === '${secret}',
  apiKeyPresent: process.env.OPENAI_API_KEY === '${secret}',
  dataDirPresent: process.env.BBK_DATA_DIR === '${directory}'
}))
`,
        'utf8',
      )
      await chmod(fakeCodex, 0o755)
      vi.stubEnv('PATH', `${directory}:${process.env.PATH ?? ''}`)
      vi.stubEnv('BBK_DATA_DIR', directory)
      vi.stubEnv('TOAST_CLIENT_SECRET', secret)
      vi.stubEnv('OPENAI_API_KEY', secret)

      const result = await runCodexJson<{
        markerInArgs: boolean
        markerInStdin: boolean
        ephemeral: boolean
        readOnly: boolean
        secretPresent: boolean
        apiKeyPresent: boolean
        dataDirPresent: boolean
      }>({
        model: 'test-model',
        reasoningEffort: 'low',
        system: 'Test system',
        task: marker,
      })

      expect(result).toEqual({
        markerInArgs: false,
        markerInStdin: true,
        ephemeral: true,
        readOnly: true,
        secretPresent: false,
        apiKeyPresent: false,
        dataDirPresent: false,
      })

      const ledgerPath = join(directory, 'openclaw-usage.json')
      expect((await stat(ledgerPath)).mode & 0o777).toBe(0o600)
      expect(await readFile(ledgerPath, 'utf8')).not.toContain(marker)
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })
})
