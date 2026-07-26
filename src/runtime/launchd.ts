import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

type LaunchdInput = {
  label: string
  workingDirectory: string
  dataDir: string
  envFile?: string
  intervalMs: number
  stdoutPath: string
  stderrPath: string
}

type MaintenanceLaunchdInput = LaunchdInput & {
  maintainArgs: string[]
}

export const resolveCliInvocation = (): string[] => {
  const modulePath = fileURLToPath(import.meta.url)
  const projectRoot = resolve(dirname(modulePath), '..', '..')

  if (modulePath.endsWith('.ts')) {
    const tsx = resolve(projectRoot, 'node_modules', '.bin', 'tsx')
    const sourceCli = resolve(projectRoot, 'src', 'cli', 'index.ts')
    if (existsSync(tsx) && existsSync(sourceCli)) return [tsx, sourceCli]
  }

  const compiledCli = resolve(projectRoot, 'dist', 'cli', 'index.js')
  if (existsSync(compiledCli)) return [process.execPath, compiledCli]
  throw new Error('bars_bookkeeper_cli_entrypoint_not_found:run_npm_build')
}

const environmentXml = (dataDir: string, envFile?: string): string => `
    <key>BBK_DATA_DIR</key>
    <string>${xmlEscape(dataDir)}</string>
${envFile ? `    <key>BBK_ENV_FILE</key>
    <string>${xmlEscape(envFile)}</string>
` : ''}
    <key>OPENCLAW_USE_CODEX</key>
    <string>${xmlEscape(process.env.OPENCLAW_USE_CODEX ?? '0')}</string>
    <key>PATH</key>
    <string>${xmlEscape(process.env.PATH ?? '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin')}</string>`

export const renderLaunchdPlist = (input: LaunchdInput): string => {
  const intervalMs = Math.max(1000, input.intervalMs)
  const args = [
    ...resolveCliInvocation(),
    'backbone',
    'listen',
    '--interval-ms',
    String(intervalMs),
  ]
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(input.label)}</string>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(input.workingDirectory)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((arg) => `    <string>${xmlEscape(arg)}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>${environmentXml(input.dataDir, input.envFile)}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(input.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(input.stderrPath)}</string>
</dict>
</plist>
`
}

export const renderMaintenanceLaunchdPlist = (input: MaintenanceLaunchdInput): string => {
  const intervalSeconds = Math.max(60, Math.round(input.intervalMs / 1000))
  const args = [
    ...resolveCliInvocation(),
    'backbone',
    'maintain',
    ...input.maintainArgs,
  ]
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(input.label)}</string>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(input.workingDirectory)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((arg) => `    <string>${xmlEscape(arg)}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>${environmentXml(input.dataDir, input.envFile)}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>${intervalSeconds}</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(input.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(input.stderrPath)}</string>
</dict>
</plist>
`
}

const xmlEscape = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
