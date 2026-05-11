import { readFile } from 'node:fs/promises'
import { runServiceCommand, requirePathArg } from './service-command.js'
import type { CommandContext } from './types.js'

export const ingestInvoice = async (args: string[], context: CommandContext): Promise<void> =>
  runServiceCommand(args, context, {
    title: 'Ingest invoice',
    started: `Preparing invoice import for ${args[0] ?? '(missing path)'}`,
    done: 'Invoice import completed.',
    missing: 'Invoice ingest service is not present yet.',
    modules: ['../ingest/invoices.js', '../ingest/invoice.js', '../ingest/index.js'],
    exports: ['ingestInvoices', 'ingestInvoice', 'ingestInvoiceFile', 'importInvoice'],
    withDb: true,
    args: async (rawArgs, ctx, { db }) => [db, await readFile(requirePathArg(rawArgs, 'invoice', ctx), 'utf8')],
  })

export const ingestCount = async (args: string[], context: CommandContext): Promise<void> =>
  runServiceCommand(args, context, {
    title: 'Ingest count',
    started: `Preparing count import for ${args[0] ?? '(missing path)'}`,
    done: 'Count import completed.',
    missing: 'Count ingest service is not present yet.',
    modules: ['../ingest/counts.js', '../ingest/count.js', '../ingest/index.js'],
    exports: ['ingestCounts', 'ingestCount', 'ingestCountFile', 'importCount'],
    withDb: true,
    args: async (rawArgs, ctx, { db }) => [db, await readFile(requirePathArg(rawArgs, 'count', ctx), 'utf8')],
  })

export const toastConnect = async (args: string[], context: CommandContext): Promise<void> =>
  runServiceCommand(args, context, {
    title: 'Toast connect',
    started: 'Looking for Toast connection service...',
    done: 'Toast connection flow completed.',
    missing: 'Toast connection service is not present yet.',
    modules: ['../ingest/toast.js', '../ingest/toast/index.js'],
    exports: ['connectToast', 'toastConnect', 'startToastConnect'],
    args: (_rawArgs, ctx) => [ctx.config],
  })

export const toastPull = async (args: string[], context: CommandContext): Promise<void> =>
  runServiceCommand(args, context, {
    title: 'Toast pull',
    started: 'Looking for Toast pull service...',
    done: 'Toast data pull completed.',
    missing: 'Toast pull service is not present yet.',
    modules: ['../ingest/toast.js', '../ingest/toast/index.js'],
    exports: ['pullToast', 'toastPull', 'syncToastSales'],
    args: (_rawArgs, ctx) => [ctx.config],
  })

export const brainRun = async (args: string[], context: CommandContext): Promise<void> =>
  runServiceCommand(args, context, {
    title: 'Brain run',
    started: 'Looking for reasoning service...',
    done: 'Brain run completed.',
    missing: 'Brain service is not present yet.',
    modules: ['../brain/index.js', '../brain/run.js'],
    exports: ['runBrain', 'reconcileInventory', 'runOpenClawBrain'],
    args: (_rawArgs, ctx) => [ctx.config],
  })

export const forecastRun = async (args: string[], context: CommandContext): Promise<void> =>
  runServiceCommand(args, context, {
    title: 'Forecast run',
    started: 'Looking for forecast service...',
    done: 'Forecast run completed.',
    missing: 'Forecast service is not present yet.',
    modules: ['../forecast/index.js', '../forecast/run.js'],
    exports: ['generateForecasts', 'runForecast', 'buildForecast', 'forecastInventory'],
    withDb: true,
    args: (_rawArgs, _ctx, { db }) => [db],
  })

export const ordersGenerate = async (args: string[], context: CommandContext): Promise<void> =>
  runServiceCommand(args, context, {
    title: 'Generate orders',
    started: 'Looking for order recommendation service...',
    done: 'Order generation completed.',
    missing: 'Order generation service is not present yet.',
    modules: ['../orders/index.js', '../orders/generate.js'],
    exports: ['generateVendorGroupedOrderRecommendations', 'generateOrders', 'generateOrderRecommendations', 'buildOrderRecommendations'],
    withDb: true,
    args: (_rawArgs, _ctx, { db }) => [db],
  })

export const review = async (args: string[], context: CommandContext): Promise<void> =>
  runServiceCommand(args, context, {
    title: 'Review queue',
    started: 'Looking for review service...',
    done: 'Review queue loaded.',
    missing: 'Review service is not present yet.',
    modules: ['../brain/review.js', '../brain/index.js'],
    exports: ['reviewDecisions', 'getReviewQueue', 'listReviewItems'],
    args: (_rawArgs, ctx) => [ctx.config],
  })
