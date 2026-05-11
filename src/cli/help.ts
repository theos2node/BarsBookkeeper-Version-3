import { ansi } from '../tui/ansi.js'
import type { CommandDefinition } from '../commands/types.js'

export const renderHelp = (commands: CommandDefinition[]): string => {
  const width = Math.max(...commands.map((command) => command.usage.length))
  const lines = [
    ansi.bold('Bars Bookkeeper CLI'),
    '',
    'Usage:',
    `  ${ansi.cyan('bbk')} ${ansi.gray('<command>')}`,
    '',
    'Commands:',
    ...commands.map((command) => `  ${ansi.cyan(command.usage.padEnd(width))}  ${command.summary}`),
    '',
    'Run with npm:',
    `  ${ansi.cyan('npm run bbk -- doctor')}`,
  ]
  return lines.join('\n')
}

