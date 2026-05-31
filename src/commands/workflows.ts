import { readFile } from 'node:fs/promises'
import { parseJson, toNumber, toStringValue } from '../db/database.js'
import { mapToastRecipeAndBackfill } from '../ingest/recipes.js'
import { OperatorInputError, runServiceCommand, requirePathArg } from './service-command.js'
import { BackendUnavailableError, callBackend, withBackendDb } from './backend.js'
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
    args: (rawArgs, ctx) => [ctx.config, rawArgs],
  })

export const toastPull = async (args: string[], context: CommandContext): Promise<void> =>
  runServiceCommand(args, context, {
    title: 'Toast pull',
    started: 'Looking for Toast pull service...',
    done: 'Toast data pull completed.',
    missing: 'Toast pull service is not present yet.',
    modules: ['../ingest/toast.js', '../ingest/toast/index.js'],
    exports: ['pullToast', 'toastPull', 'syncToastSales'],
    withDb: true,
    args: (rawArgs, ctx, { db }) => [db, ctx.config, rawArgs],
  })

export const toastMapRecipe = async (args: string[], context: CommandContext): Promise<void> => {
  const parsed = parseRecipeMapArgs(args)
  context.terminal.title('Toast recipe map')

  await withBackendDb(context.config, async (db: any) => {
    const result = mapToastRecipeAndBackfill(db, parsed)
    context.terminal.success(`Mapped ${result.menuItemName} to ${result.skuName}.`)
    context.terminal.dump(result)
  })
}

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

export const review = async (args: string[], context: CommandContext): Promise<void> => {
  context.terminal.title('Review queue')

  const action = args[0]
  if (action === 'apply' || action === 'dismiss' || action === 'reverse') {
    await reviewAction(action, args.slice(1), context)
    return
  }
  if (action) {
    throw new OperatorInputError(
      `Unknown review action: ${action}`,
      'usage: bbk review OR bbk review apply|dismiss|reverse <id>',
    )
  }

  try {
    const call = await callBackend(
      ['../brain/review.js', '../brain/index.js'],
      ['reviewDecisions', 'getReviewQueue', 'listReviewItems'],
      [context.config],
    )
    context.terminal.success('Review queue loaded.')
    context.terminal.subtitle(`backend: ${call.module} -> ${call.exportName}`)
    renderReviewRows(call.result, context)
    return
  } catch (error) {
    if (!(error instanceof BackendUnavailableError)) throw error
    context.terminal.info('Dedicated review service not found; reading open decisions from the local database.')
  }

  await withBackendDb(context.config, async (db: any) => {
    const rows = db
      .prepare(
        `SELECT id, state, risk_level AS risk, title, confidence, payload_json, created_at
         FROM openclaw_decisions
         WHERE state = 'needs_review'
         ORDER BY
           CASE risk_level
             WHEN 'critical' THEN 0
             WHEN 'high' THEN 1
             WHEN 'medium' THEN 2
             WHEN 'low' THEN 3
             ELSE 4
           END,
           created_at DESC
         LIMIT 20`,
      )
      .all()

    if (rows.length === 0) {
      context.terminal.success('No open review tasks.')
      context.terminal.subtitle('run `bbk brain run` after ingesting fresh data to create new decisions')
      return
    }

    context.terminal.warn(`${rows.length} decision${rows.length === 1 ? '' : 's'} need review.`)
    context.terminal.table(
      rows.map((row: any) => ({
        id: row.id,
        risk: row.risk,
        confidence: row.confidence,
        action: reviewActionHint(row),
        created: row.created_at,
        task: row.title,
      })),
    )
  })
}

const reviewAction = async (
  action: 'apply' | 'dismiss' | 'reverse',
  args: string[],
  context: CommandContext,
): Promise<void> => {
  const decisionId = Number(args[0])
  if (!Number.isInteger(decisionId) || decisionId <= 0) {
    throw new OperatorInputError(`Missing or invalid decision id.`, `usage: bbk review ${action} <id>`)
  }
  const reason = args.slice(1).join(' ').trim() || undefined
  const exports =
    action === 'apply'
      ? ['applyReviewDecision']
      : action === 'dismiss'
        ? ['dismissReviewDecision']
        : ['reverseAppliedDecision']
  const call = await callBackend(['../brain/review.js', '../brain/index.js'], exports, [context.config, decisionId, reason])
  const result = call.result as { applied?: boolean } | undefined
  if (action === 'apply' && result?.applied === false) {
    context.terminal.warn('Review apply skipped.')
  } else {
    context.terminal.success(`Review ${action} completed.`)
  }
  context.terminal.subtitle(`backend: ${call.module} -> ${call.exportName}`)
  context.terminal.dump(call.result)
}

const renderReviewRows = (result: unknown, context: CommandContext): void => {
  if (!Array.isArray(result)) {
    context.terminal.dump(result)
    return
  }
  if (result.length === 0) {
    context.terminal.success('No open review tasks.')
    context.terminal.subtitle('run `bbk brain run` after ingesting fresh data to create new decisions')
    return
  }

  context.terminal.warn(`${result.length} decision${result.length === 1 ? '' : 's'} need review.`)
  context.terminal.table(
    result.map((row: any) => ({
      id: row.id,
      risk: row.risk_level ?? row.risk,
      confidence: row.confidence,
      action: reviewActionHint(row),
      created: row.created_at,
      task: row.title,
    })),
  )
}

const reviewActionHint = (row: Record<string, unknown>): string => {
  const payload = parseJson<Record<string, unknown>>(row.payload_json, {})
  if (toStringValue(payload.eventType) && toStringValue(payload.skuName) && toNumber(payload.quantity) !== 0) {
    return 'apply/dismiss'
  }

  const kind = toStringValue(payload.kind)
  if (kind === 'missing_recipe' || kind === 'missing_recipe_review') return 'map recipe, then dismiss'
  if (kind === 'source_freshness_review') return 'refresh, then dismiss'
  if (kind === 'inventory_risk_review') return 'resolve, then dismiss'
  return 'dismiss'
}

const parseRecipeMapArgs = (args: string[]) => {
  const values: string[] = []
  let yieldQuantity: number | undefined
  let category: string | undefined

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    const next = args[index + 1]
    if (arg === '--yield' && next) {
      yieldQuantity = toNumber(next)
      index += 1
    } else if (arg === '--category' && next) {
      category = next
      index += 1
    } else {
      values.push(arg)
    }
  }

  const [menuItemName, skuName, quantityRaw, unit] = values
  const quantity = toNumber(quantityRaw)
  if (!menuItemName || !skuName || !quantityRaw || !unit || quantity <= 0) {
    throw new OperatorInputError(
      'Missing or invalid Toast recipe map arguments.',
      'usage: bbk toast map-recipe "<menu item>" "<sku>" <quantity> <unit> [--yield <n>] [--category <name>]',
    )
  }

  return {
    menuItemName,
    skuName,
    quantity,
    unit,
    yieldQuantity,
    category,
  }
}
