import type { CommandDefinition } from '../commands/types.js'

export type ParsedCommand =
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'command'; command: CommandDefinition; args: string[] }
  | { kind: 'unknown'; input: string[] }

export const parseCommand = (argv: string[], commands: CommandDefinition[]): ParsedCommand => {
  const args = argv.filter(Boolean)
  if (args.length === 0 || args[0] === 'help' || args[0] === '--help' || args[0] === '-h') {
    return { kind: 'help' }
  }
  if (args[0] === '--version' || args[0] === '-v') return { kind: 'version' }

  const command = [...commands]
    .sort((left, right) => right.path.length - left.path.length)
    .find((candidate) => candidate.path.every((part, index) => args[index] === part))

  if (!command) return { kind: 'unknown', input: args }
  return { kind: 'command', command, args: args.slice(command.path.length) }
}

