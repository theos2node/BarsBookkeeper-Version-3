import { brainRun, forecastRun, ingestCount, ingestInvoice, ordersGenerate, review, toastConnect, toastPull } from './workflows.js'
import { doctor, seedDemo, seedFieldDemo, setup } from './system.js'
import { consoleCommand } from './console.js'
import { backboneAudit, backboneListen, backboneMatrix, backboneRun, backboneSimulate, backboneStatus } from './backbone.js'
import type { CommandContext, CommandDefinition } from './types.js'

export const createCommands = (
  dispatch: (args: string[], context: CommandContext) => Promise<number>,
): CommandDefinition[] => [
  {
    path: ['setup'],
    usage: 'bbk setup',
    summary: 'Create local data directories and run database setup when available.',
    handler: setup,
  },
  {
    path: ['doctor'],
    usage: 'bbk doctor',
    summary: 'Check local paths, Codex login status, and model provider smoke hooks.',
    handler: doctor,
  },
  {
    path: ['seed-demo'],
    usage: 'bbk seed-demo',
    summary: 'Seed demo data through the backend seed service.',
    handler: seedDemo,
  },
  {
    path: ['seed-field-demo'],
    usage: 'bbk seed-field-demo',
    summary: 'Generate realistic sample operating data and run the workflow.',
    handler: seedFieldDemo,
  },
  {
    path: ['ingest', 'invoice'],
    usage: 'bbk ingest invoice <path>',
    summary: 'Import a vendor invoice file.',
    handler: ingestInvoice,
  },
  {
    path: ['ingest', 'count'],
    usage: 'bbk ingest count <path>',
    summary: 'Import an inventory count file.',
    handler: ingestCount,
  },
  {
    path: ['toast', 'connect'],
    usage: 'bbk toast connect',
    summary: 'Start the Toast connection flow.',
    handler: toastConnect,
  },
  {
    path: ['toast', 'pull'],
    usage: 'bbk toast pull',
    summary: 'Pull Toast sales data.',
    handler: toastPull,
  },
  {
    path: ['brain', 'run'],
    usage: 'bbk brain run',
    summary: 'Run the inventory reasoning pass.',
    handler: brainRun,
  },
  {
    path: ['backbone', 'run'],
    usage: 'bbk backbone run [--as-of <iso>] [--horizon-days <days>]',
    summary: 'Run the continuously learned inventory prediction model.',
    handler: backboneRun,
  },
  {
    path: ['backbone', 'status'],
    usage: 'bbk backbone status',
    summary: 'Show the latest Backbone prediction run.',
    handler: backboneStatus,
  },
  {
    path: ['backbone', 'audit'],
    usage: 'bbk backbone audit [--max-age-minutes <minutes>]',
    summary: 'Check Backbone listener, prediction, feedback, and signal health.',
    handler: backboneAudit,
  },
  {
    path: ['backbone', 'listen'],
    usage: 'bbk backbone listen [--cycles <n>] [--interval-ms <ms>]',
    summary: 'Continuously pull Toast, run OpenClaw, and refresh Backbone predictions.',
    handler: backboneListen,
  },
  {
    path: ['backbone', 'simulate'],
    usage: 'bbk backbone simulate [--env <name>] [--days <days>] [--scenario steady|busy|slow|shrink]',
    summary: 'Create an isolated sandbox and test Backbone prediction accuracy.',
    handler: backboneSimulate,
  },
  {
    path: ['backbone', 'matrix'],
    usage: 'bbk backbone matrix [--env <prefix>] [--days <days>]',
    summary: 'Run multiple isolated Backbone simulation scenarios in parallel.',
    handler: backboneMatrix,
  },
  {
    path: ['forecast', 'run'],
    usage: 'bbk forecast run',
    summary: 'Generate demand and depletion forecasts.',
    handler: forecastRun,
  },
  {
    path: ['orders', 'generate'],
    usage: 'bbk orders generate',
    summary: 'Generate order recommendations.',
    handler: ordersGenerate,
  },
  {
    path: ['review'],
    usage: 'bbk review [apply|dismiss|reverse <id>]',
    summary: 'Show or act on decisions needing review.',
    handler: review,
  },
  {
    path: ['console'],
    usage: 'bbk console [--snapshot|--shell]',
    summary: 'Open the full-screen terminal operations dashboard.',
    handler: (args, context) => consoleCommand(args, context, createCommands(dispatch), dispatch),
  },
]
