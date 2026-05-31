import { brainRun, forecastRun, ingestCount, ingestInvoice, ordersGenerate, review, toastConnect, toastMapRecipe, toastPull } from './workflows.js'
import { doctor, seedDemo, seedFieldDemo, setup } from './system.js'
import { consoleCommand } from './console.js'
import { backboneAcceptance, backboneAccuracy, backboneActions, backboneAudit, backboneBacktest, backboneBacktestMatrix, backboneDrift, backboneEnvPrune, backboneEnvs, backboneExplain, backboneIntake, backboneListen, backboneMatrix, backboneMemory, backbonePlan, backboneRun, backboneService, backboneSimulate, backboneSnapshot, backboneSnapshotRestore, backboneSnapshotVerify, backboneStatus, backboneVerify, backboneVerifyHistory } from './backbone.js'
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
    path: ['toast', 'map-recipe'],
    usage: 'bbk toast map-recipe "<menu item>" "<sku>" <quantity> <unit> [--yield <n>]',
    summary: 'Map a Toast menu item recipe ingredient and backfill missed Toast consumption.',
    handler: toastMapRecipe,
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
    path: ['backbone', 'service'],
    usage: 'bbk backbone service [--interval-ms <ms>] [--label <launchd-label>]',
    summary: 'Write a macOS launchd plist for an unattended Backbone listener.',
    handler: backboneService,
  },
  {
    path: ['backbone', 'snapshot'],
    usage: 'bbk backbone snapshot [--label <name>]',
    summary: 'Create a consistent SQLite backup and Backbone health manifest.',
    handler: backboneSnapshot,
  },
  {
    path: ['backbone', 'snapshot-verify'],
    usage: 'bbk backbone snapshot-verify --label <name>',
    summary: 'Verify a Backbone SQLite snapshot opens cleanly and matches its manifest.',
    handler: backboneSnapshotVerify,
  },
  {
    path: ['backbone', 'snapshot-restore'],
    usage: 'bbk backbone snapshot-restore --label <name> --env <environment> [--force]',
    summary: 'Restore a Backbone snapshot into an isolated environment for inspection.',
    handler: backboneSnapshotRestore,
  },
  {
    path: ['backbone', 'plan'],
    usage: 'bbk backbone plan [--horizons 1,7,14,30]',
    summary: 'Run and compare Backbone predictions across multiple planning horizons.',
    handler: backbonePlan,
  },
  {
    path: ['backbone', 'audit'],
    usage: 'bbk backbone audit [--max-age-minutes <minutes>] [--max-run-age-minutes <minutes>] [--max-count-age-days <days>]',
    summary: 'Check Backbone listener, prediction, feedback, and signal health.',
    handler: backboneAudit,
  },
  {
    path: ['backbone', 'verify'],
    usage: 'bbk backbone verify [--env <prefix>] [--scenario steady|busy|slow|shrink|volatile|price-drift] [--days <days>]',
    summary: 'Run isolated Backbone validation and rolling backtest gates as one acceptance check.',
    handler: backboneVerify,
  },
  {
    path: ['backbone', 'acceptance'],
    usage: 'bbk backbone acceptance [--env <prefix>] [--scenario steady|busy|slow|shrink|volatile|price-drift] [--days <days>]',
    summary: 'Run the full Backbone acceptance drill: isolated predictions, rolling sparse-count backtest, drift, and snapshot restore.',
    handler: backboneAcceptance,
  },
  {
    path: ['backbone', 'verify-history'],
    usage: 'bbk backbone verify-history [--limit <n>]',
    summary: 'Show recent persisted Backbone verification gate results.',
    handler: backboneVerifyHistory,
  },
  {
    path: ['backbone', 'accuracy'],
    usage: 'bbk backbone accuracy [--env <name>] [--min-samples <n>]',
    summary: 'Report scored Backbone prediction accuracy and calibration drift.',
    handler: backboneAccuracy,
  },
  {
    path: ['backbone', 'memory'],
    usage: 'bbk backbone memory [--env <name>] [--limit <n>]',
    summary: 'Show learned Backbone calibration memory and ungrounded current risks.',
    handler: backboneMemory,
  },
  {
    path: ['backbone', 'drift'],
    usage: 'bbk backbone drift [--env <name>] [--min-samples <n>] [--max-bottle-mae <n>] [--max-bias-bottles <n>]',
    summary: 'Check whether scored sparse counts show stale or biased Backbone learning.',
    handler: backboneDrift,
  },
  {
    path: ['backbone', 'intake'],
    usage: 'bbk backbone intake [--env <name>] [--limit <n>]',
    summary: 'Show Toast recipe coverage and consumption entering Backbone learning.',
    handler: backboneIntake,
  },
  {
    path: ['backbone', 'explain'],
    usage: 'bbk backbone explain [--env <name>] [--sku <name>]',
    summary: 'Explain the evidence behind the latest Backbone prediction.',
    handler: backboneExplain,
  },
  {
    path: ['backbone', 'actions'],
    usage: 'bbk backbone actions',
    summary: 'Show actionable low-stock orders and cost-cutting signals from the latest Backbone run.',
    handler: backboneActions,
  },
  {
    path: ['backbone', 'envs'],
    usage: 'bbk backbone envs',
    summary: 'List isolated Backbone simulation environments and latest run state.',
    handler: backboneEnvs,
  },
  {
    path: ['backbone', 'env-prune'],
    usage: 'bbk backbone env-prune [--older-than-days <days>] [--keep <n>] [--force]',
    summary: 'Dry-run or delete old isolated Backbone simulation environments.',
    handler: backboneEnvPrune,
  },
  {
    path: ['backbone', 'listen'],
    usage: 'bbk backbone listen [--cycles <n>] [--interval-ms <ms>] [--skip-openclaw] [--recover-stale-minutes <minutes>] [--lock-ttl-minutes <minutes>]',
    summary: 'Continuously pull Toast, run OpenClaw, and refresh Backbone predictions.',
    handler: backboneListen,
  },
  {
    path: ['backbone', 'simulate'],
    usage: 'bbk backbone simulate [--env <name>] [--days <days>] [--scenario steady|busy|slow|shrink|volatile|price-drift]',
    summary: 'Create an isolated sandbox and test Backbone prediction accuracy.',
    handler: backboneSimulate,
  },
  {
    path: ['backbone', 'backtest'],
    usage: 'bbk backbone backtest [--env <name>] [--days <days>] [--horizon-days <days>] [--count-cadence-days <days>] [--scenario steady|busy|slow|shrink|volatile|price-drift]',
    summary: 'Walk a simulated Toast timeline and verify rolling Backbone accuracy between sparse counts.',
    handler: backboneBacktest,
  },
  {
    path: ['backbone', 'backtest-matrix'],
    usage: 'bbk backbone backtest-matrix [--env <prefix>] [--days <days>] [--horizon-days <days>] [--count-cadence-days <days>]',
    summary: 'Run rolling Backbone backtests across isolated scenario environments in parallel.',
    handler: backboneBacktestMatrix,
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
