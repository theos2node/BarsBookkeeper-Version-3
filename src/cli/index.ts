#!/usr/bin/env node
import { getConfig } from '../config.js'
import { createCommands } from '../commands/index.js'
import type { CommandContext } from '../commands/types.js'
import { Terminal } from '../tui/output.js'
import { parseCommand } from './parser.js'
import { renderHelp } from './help.js'
import { version } from '../version.js'

const run = async (argv: string[], context: CommandContext): Promise<number> => {
  const commands = createCommands(run)
  const parsed = parseCommand(argv, commands)

  if (parsed.kind === 'help') {
    context.terminal.line(renderHelp(commands))
    return 0
  }

  if (parsed.kind === 'version') {
    context.terminal.line(`bars-bookkeeper ${version}`)
    return 0
  }

  if (parsed.kind === 'unknown') {
    context.terminal.error(`Unknown command: ${parsed.input.join(' ')}`)
    context.terminal.line('')
    context.terminal.line(renderHelp(commands))
    return 1
  }

  await parsed.command.handler(parsed.args, context)
  return 0
}

const main = async (): Promise<void> => {
  const terminal = new Terminal()
  const context: CommandContext = {
    config: getConfig(),
    terminal,
    cwd: process.cwd(),
  }

  try {
    process.exitCode = await run(process.argv.slice(2), context)
  } catch (error) {
    terminal.error(error instanceof Error ? error.message : String(error))
    if (process.env.BBK_DEBUG === '1' && error instanceof Error && error.stack) {
      terminal.line(error.stack)
    }
    process.exitCode = 1
  }
}

await main()
