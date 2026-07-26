import { isAbsolute } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cleanEnvName, parseOptions } from '../src/commands/backbone/options.js'
import { renderLaunchdPlist, resolveCliInvocation } from '../src/runtime/launchd.js'

describe('backbone option parsing', () => {
  it('supports equals syntax and strictly validates numeric inputs', () => {
    expect(parseOptions(['--cycles=3', '--interval-ms', '0', '--once'])).toMatchObject({
      cycles: 1,
      intervalMs: 0,
      once: true,
    })
    expect(() => parseOptions(['--cycles', '1.5'])).toThrow('--cycles_must_be_an_integer')
    expect(() => parseOptions(['--limit', 'Infinity'])).toThrow('--limit_invalid')
  })

  it('rejects missing, unknown, and unsafe path-like values', () => {
    expect(() => parseOptions(['--env'])).toThrow('--env_value_required')
    expect(() => parseOptions(['--definitely-not-real'])).toThrow(
      'unknown_backbone_option:--definitely-not-real',
    )
    expect(() => cleanEnvName('..')).toThrow('unsafe_restore_environment_path')
  })
})

describe('launchd deployment rendering', () => {
  it('uses an absolute CLI invocation and escapes untrusted XML values', () => {
    const invocation = resolveCliInvocation()
    expect(invocation.length).toBe(2)
    expect(invocation.every(isAbsolute)).toBe(true)

    const plist = renderLaunchdPlist({
      label: 'com.example.<bars>',
      workingDirectory: '/tmp/bars & books',
      dataDir: '/tmp/bars',
      envFile: '/tmp/bars & books/service.env',
      intervalMs: 500,
      stdoutPath: '/tmp/out.log',
      stderrPath: '/tmp/error.log',
    })

    expect(plist).toContain('com.example.&lt;bars&gt;')
    expect(plist).toContain('/tmp/bars &amp; books')
    expect(plist).toContain('<key>BBK_ENV_FILE</key>')
    expect(plist).toContain('/tmp/bars &amp; books/service.env')
    expect(plist).toContain('<string>1000</string>')
    for (const part of invocation) expect(plist).toContain(part)
  })
})
