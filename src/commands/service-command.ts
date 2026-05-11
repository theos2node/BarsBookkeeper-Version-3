import { resolve } from 'node:path'
import { BackendUnavailableError, callBackend, withBackendDb } from './backend.js'
import type { CommandContext } from './types.js'

export type ServiceCommandOptions = {
  title: string
  started: string
  done: string
  missing: string
  modules: string[]
  exports: string[]
  withDb?: boolean
  args?: (rawArgs: string[], context: CommandContext, services: { db?: unknown }) => unknown[] | Promise<unknown[]>
}

export const runServiceCommand = async (
  rawArgs: string[],
  context: CommandContext,
  options: ServiceCommandOptions,
): Promise<void> => {
  context.terminal.title(options.title)
  context.terminal.info(options.started)

  try {
    const invoke = async (db?: unknown) => {
      const backendArgs = options.args ? await options.args(rawArgs, context, { db }) : [context.config]
      return callBackend(options.modules, options.exports, backendArgs)
    }
    const call = options.withDb
      ? await withBackendDb(context.config, async (db) => invoke(db))
      : await invoke()
    context.terminal.success(options.done)
    context.terminal.subtitle(`backend: ${call.module} -> ${call.exportName}`)
    context.terminal.dump(call.result)
  } catch (error) {
    if (error instanceof BackendUnavailableError) {
      context.terminal.warn(options.missing)
      context.terminal.subtitle(`expected exports: ${error.missing.exportCandidates.join(', ')}`)
      context.terminal.subtitle(`expected modules: ${error.missing.moduleCandidates.join(', ')}`)
      return
    }
    throw error
  }
}

export const requirePathArg = (args: string[], noun: string, context: CommandContext): string => {
  const value = args[0]
  if (!value) throw new Error(`Missing ${noun} path.`)
  return resolve(context.cwd, value)
}
