import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { getInventoryPositions } from '../db/inventory.js'
import { toNumber, toStringValue } from '../db/database.js'
import { launchDashboard } from '../tui/dashboard.js'
import { readUsageSummary } from '../openclaw/usage.js'
import { OperatorInputError } from './service-command.js'
import { withBackendDb } from './backend.js'
import type { CommandContext, CommandDefinition } from './types.js'

export const consoleCommand = async (
  args: string[],
  context: CommandContext,
  commands: CommandDefinition[],
  dispatch: (args: string[], context: CommandContext) => Promise<number>,
): Promise<void> => {
  if (args.includes('--snapshot')) {
    context.terminal.title('Bars Bookkeeper console')
    await renderSnapshot(context)
    return
  }

  context.terminal.title('Bars Bookkeeper console')
  context.terminal.subtitle('Full-screen mode. Press `q` to close, `s` to generate simulated data, `w` to run workflow.')

  if (!input.isTTY) {
    await renderSnapshot(context)
    return
  }

  if (!args.includes('--shell')) {
    await launchDashboard(context.config)
    return
  }

  context.terminal.subtitle('Shell mode. Type `help` for commands. Type `exit` or `quit` to close.')
  const rl = createInterface({ input, output })
  try {
    for (;;) {
      const line = (await rl.question('bbk> ')).trim()
      if (!line) continue
      if (line === 'exit' || line === 'quit') break
      if (line === 'help') {
        context.terminal.line('Available commands:')
        for (const command of commands) {
          if (command.path.join(' ') === 'console') continue
          context.terminal.line(`  ${command.usage.padEnd(32)} ${command.summary}`)
        }
        continue
      }
      try {
        const args = splitShellish(line)
        const exitCode = await dispatch(args, context)
        if (exitCode !== 0) context.terminal.warn(`Command exited with code ${exitCode}.`)
      } catch (error) {
        context.terminal.error(error instanceof Error ? error.message : String(error))
        if (error instanceof OperatorInputError && error.hint) context.terminal.subtitle(error.hint)
      }
    }
  } finally {
    rl.close()
  }
}

const renderSnapshot = async (context: CommandContext) => {
  context.terminal.section('Snapshot')
  await withBackendDb(context.config, async (db: any) => {
    const positions = getInventoryPositions(db)
    const reviewCount = toNumber(
      db.prepare("SELECT COUNT(*) AS count FROM openclaw_decisions WHERE state = 'needs_review'").get()?.count,
    )
    const sourceRows = db
      .prepare(
        `SELECT s.kind,
                s.name,
                MAX(COALESCE(r.completed_at, r.started_at)) AS last_run,
                COALESCE(SUM(CASE WHEN r.status = 'failed' THEN 1 ELSE 0 END), 0) AS failures
         FROM sources s
         LEFT JOIN ingest_runs r ON r.source_id = s.id
         WHERE s.is_active = 1
         GROUP BY s.id
         ORDER BY s.kind, s.name`,
      )
      .all()
    const orders = db
      .prepare(
        `SELECT COALESCE(v.name, 'Unassigned') AS vendor, s.name AS sku, o.recommended_qty, o.unit, o.confidence
         FROM order_recommendations o
         JOIN skus s ON s.id = o.sku_id
         LEFT JOIN vendors v ON v.id = o.vendor_id
         WHERE o.status = 'open'
         ORDER BY vendor, sku`,
      )
      .all()
    const decisions = db
      .prepare(
        `SELECT id, state, risk_level AS risk, title, confidence, created_at
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
         LIMIT 8`,
      )
      .all()
    const recentApplied = db
      .prepare(
        `SELECT id, title, confidence, created_at
         FROM openclaw_decisions
         WHERE state = 'auto_applied'
         ORDER BY created_at DESC
         LIMIT 5`,
      )
      .all()
    const evidence = db
      .prepare(
        `SELECT evidence_type AS type, summary, confidence, created_at
         FROM evidence_items
         ORDER BY created_at DESC
         LIMIT 8`,
      )
      .all()

    const atRisk = positions.filter((position) => position.warningState === 'critical' || position.warningState === 'low').length
    const openOrders = orders.length
    const usage = readUsageSummary()
    context.terminal.table([
      {
        inventory_items: positions.length,
        at_risk: atRisk,
        review_tasks: reviewCount,
        open_orders: openOrders,
        data_sources: sourceRows.length,
        openclaw_est: `$${usage.estimatedUsd.toFixed(4)}`,
        tokens: usage.totalTokens,
      },
    ])

    context.terminal.section('Source freshness')
    context.terminal.table(
      sourceRows.length > 0
        ? sourceRows.map((row: any) => ({
            kind: row.kind,
            source: row.name,
            last_run: row.last_run ?? 'never',
            failures: toNumber(row.failures),
          }))
        : [{ status: 'none', next: 'run `bbk seed-demo`, `bbk ingest`, or `bbk toast connect`' }],
    )

    context.terminal.section('Inventory')
    context.terminal.table(
      positions.map((position) => ({
        state: position.warningState,
        sku: position.name,
        on_hand: `${position.onHand} ${position.unit}`,
        par: position.parLevel ?? '',
        days_left: position.daysRemaining ?? '',
        confidence: position.confidence,
      })),
    )

    context.terminal.section('Review tasks')
    context.terminal.table(
      decisions.length > 0
        ? decisions.map((row: any) => ({
            id: row.id,
            state: row.state,
            risk: row.risk,
            confidence: row.confidence,
            task: row.title,
          }))
        : [{ status: 'none', next: 'run `bbk brain run` after ingesting data' }],
    )

    context.terminal.section('Recently applied decisions')
    context.terminal.table(
      recentApplied.length > 0
        ? recentApplied.map((row: any) => ({
            id: row.id,
            confidence: row.confidence,
            decision: row.title,
          }))
        : [{ status: 'none', next: 'ingest data or apply a reviewed decision' }],
    )

    context.terminal.section('Open order recommendations')
    context.terminal.table(
      orders.length > 0
        ? orders.map((row: any) => ({
            vendor: row.vendor,
            sku: row.sku,
            qty: `${row.recommended_qty} ${row.unit}`,
            confidence: row.confidence,
          }))
        : [{ status: 'none', next: 'run `bbk forecast run` then `bbk orders generate`' }],
    )

    context.terminal.section('Latest evidence')
    context.terminal.table(
      evidence.length > 0
        ? evidence.map((row: any) => ({
            type: row.type,
            confidence: row.confidence,
            evidence: toStringValue(row.summary),
          }))
        : [{ status: 'none', next: 'ingest invoices, counts, or Toast sales' }],
    )
  })
}

const splitShellish = (line: string): string[] => {
  const parts: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (quote) {
      if (char === quote) quote = null
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current) {
        parts.push(current)
        current = ''
      }
      continue
    }
    current += char
  }

  if (quote) throw new OperatorInputError('Unclosed quote in console command.', 'close the quote or remove it')
  if (current) parts.push(current)
  return parts
}
