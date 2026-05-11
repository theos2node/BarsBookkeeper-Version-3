import type { AppConfig } from '../config.js'
import type { Terminal } from '../tui/output.js'

export type CommandContext = {
  config: AppConfig
  terminal: Terminal
  cwd: string
}

export type CommandResult = {
  exitCode?: number
}

export type CommandHandler = (args: string[], context: CommandContext) => Promise<CommandResult | void>

export type CommandDefinition = {
  path: string[]
  usage: string
  summary: string
  handler: CommandHandler
}

