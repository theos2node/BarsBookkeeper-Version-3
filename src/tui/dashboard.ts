import blessed from 'blessed'
import type { AppConfig } from '../config.js'
import { runOpenClawBrain } from '../brain/openclaw.js'
import { getInventoryPositions } from '../db/inventory.js'
import { openDatabase, toNumber, toStringValue, type Db } from '../db/database.js'
import { migrateDatabase } from '../db/migrations.js'
import { seedFieldDemoRun } from '../db/fieldDemo.js'
import { generateForecasts } from '../forecast/index.js'
import { generateVendorGroupedOrderRecommendations } from '../orders/index.js'

type DashboardState = {
  summary: Record<string, string | number>
  inventory: Array<Record<string, string | number>>
  orders: Array<Record<string, string | number>>
  reviews: Array<Record<string, string | number>>
  evidence: Array<Record<string, string | number>>
  sources: Array<Record<string, string | number>>
  recent: Array<Record<string, string | number>>
}

type PanelName = 'Overview' | 'Inventory' | 'Orders' | 'Reviews' | 'Evidence' | 'Sources' | 'Recent'

const panels: PanelName[] = ['Overview', 'Inventory', 'Orders', 'Reviews', 'Evidence', 'Sources', 'Recent']

export const launchDashboard = async (config: AppConfig): Promise<void> => {
  const screen = blessed.screen({
    smartCSR: true,
    fullUnicode: true,
    title: 'Bars Bookkeeper',
  })

  let activePanel: PanelName = 'Overview'
  let currentState: DashboardState | null = null
  let busy = false

  const header = blessed.box({
    top: 0,
    left: 0,
    width: '100%',
    height: 3,
    tags: true,
    style: { fg: 'white', bg: 'blue' },
    content: ' {bold}Bars Bookkeeper{/bold}  Terminal Operations Console',
  })
  const nav = blessed.list({
    top: 3,
    left: 0,
    width: 22,
    bottom: 2,
    keys: true,
    mouse: true,
    tags: true,
    border: { type: 'line' },
    label: ' Views ',
    style: {
      selected: { bg: 'blue', fg: 'white', bold: true },
      item: { fg: 'white' },
      border: { fg: 'gray' },
    },
    items: panels,
  })
  const main = blessed.box({
    top: 3,
    left: 22,
    right: 0,
    height: '62%',
    keys: true,
    mouse: true,
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    border: { type: 'line' },
    label: ' Overview ',
    style: {
      fg: 'white',
      border: { fg: 'gray' },
    },
    content: 'Loading',
  })
  const detail = blessed.box({
    left: 22,
    right: 0,
    top: '65%',
    bottom: 2,
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    keys: true,
    mouse: true,
    border: { type: 'line' },
    label: ' Details ',
    style: { border: { fg: 'gray' } },
    content: '',
  })
  const footer = blessed.box({
    bottom: 0,
    left: 0,
    width: '100%',
    height: 2,
    tags: true,
    style: { fg: 'white', bg: 'black' },
    content: ' q quit  tab view  up/down select  r refresh  w run workflow  s seed simulated run ',
  })

  screen.append(header)
  screen.append(nav)
  screen.append(main)
  screen.append(detail)
  screen.append(footer)
  nav.select(0)
  main.focus()

  const setStatus = (message: string): void => {
    footer.setContent(` ${message}  |  q quit  tab view  r refresh  w workflow  s simulate `)
    screen.render()
  }

  const refresh = async (message = 'refreshing'): Promise<void> => {
    if (busy) return
    busy = true
    setStatus(message)
    try {
      currentState = await readDashboardState(config)
      render()
      setStatus(`updated ${new Date().toLocaleTimeString()}`)
    } catch (error) {
      detail.setContent(`{red-fg}Error{/red-fg}\n${error instanceof Error ? error.message : String(error)}`)
      setStatus('error')
    } finally {
      busy = false
      screen.render()
    }
  }

  const runWorkflow = async (): Promise<void> => {
    if (busy) return
    busy = true
    setStatus('running brain -> forecast -> orders')
    try {
      await withDb(config, async (db) => {
        await runOpenClawBrain(db)
        generateForecasts(db)
        generateVendorGroupedOrderRecommendations(db)
      })
      busy = false
      await refresh('workflow complete, refreshing')
    } catch (error) {
      busy = false
      detail.setContent(`{red-fg}Workflow failed{/red-fg}\n${error instanceof Error ? error.message : String(error)}`)
      setStatus('workflow failed')
    }
  }

  const simulate = async (): Promise<void> => {
    if (busy) return
    busy = true
    setStatus('generating simulated field data')
    try {
      const result = await withDb(config, (db) => seedFieldDemoRun(db))
      busy = false
      await refresh('simulation complete, refreshing')
      detail.setContent(`{bold}Simulated workflow complete{/bold}\n${JSON.stringify(result, null, 2)}`)
    } catch (error) {
      busy = false
      detail.setContent(`{red-fg}Simulation failed{/red-fg}\n${error instanceof Error ? error.message : String(error)}`)
      setStatus('simulation failed')
    }
  }

  const render = (): void => {
    if (!currentState) return
    nav.select(panels.indexOf(activePanel))
    main.setLabel(` ${activePanel} `)
    const rows = tableFor(activePanel, currentState)
    main.setContent(renderTextTable(rows.length > 0 ? rows : [['status', 'none']]))
    detail.setContent(detailFor(activePanel, currentState))
    screen.render()
  }

  nav.on('select', (_item, index) => {
    activePanel = panels[index] ?? 'Overview'
    render()
  })
  screen.key(['tab'], () => {
    activePanel = panels[(panels.indexOf(activePanel) + 1) % panels.length] ?? 'Overview'
    render()
  })
  screen.key(['r'], () => void refresh())
  screen.key(['w'], () => void runWorkflow())
  screen.key(['s'], () => void simulate())
  screen.key(['q', 'C-c', 'escape'], () => {
    screen.destroy()
  })
  screen.key(['1', '2', '3', '4', '5', '6', '7'], (_ch, key) => {
    const index = Number(key.name) - 1
    activePanel = panels[index] ?? activePanel
    render()
  })

  await refresh('loading')
}

const withDb = async <T>(config: AppConfig, work: (db: Db) => T | Promise<T>): Promise<T> => {
  const db = openDatabase(config.dbPath)
  migrateDatabase(db)
  try {
    return await work(db)
  } finally {
    db.close()
  }
}

const readDashboardState = async (config: AppConfig): Promise<DashboardState> =>
  withDb(config, async (db) => {
    const positions = getInventoryPositions(db)
    const reviews = db
      .prepare(
        `SELECT id, risk_level AS risk, title, confidence, created_at
         FROM openclaw_decisions
         WHERE state = 'needs_review'
         ORDER BY CASE risk_level WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, created_at DESC
         LIMIT 30`,
      )
      .all()
    const orders = db
      .prepare(
        `SELECT COALESCE(v.name, 'Unassigned') AS vendor, s.name AS sku, o.recommended_qty, o.unit, o.confidence, o.estimated_cost, o.reason
         FROM order_recommendations o
         JOIN skus s ON s.id = o.sku_id
         LEFT JOIN vendors v ON v.id = o.vendor_id
         WHERE o.status = 'open'
         ORDER BY vendor, sku`,
      )
      .all()
    const evidence = db
      .prepare(
        `SELECT evidence_type AS type, summary, confidence, created_at
         FROM evidence_items
         ORDER BY created_at DESC
         LIMIT 30`,
      )
      .all()
    const sources = db
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
    const recent = db
      .prepare(
        `SELECT id, state, risk_level AS risk, title, confidence, created_at
         FROM openclaw_decisions
         ORDER BY created_at DESC
         LIMIT 30`,
      )
      .all()

    const atRisk = positions.filter((position) => position.warningState === 'critical' || position.warningState === 'low').length
    return {
      summary: {
        inventory: positions.length,
        at_risk: atRisk,
        review_tasks: reviews.length,
        open_orders: orders.length,
        evidence_items: evidence.length,
        sources: sources.length,
      },
      inventory: positions.map((position) => ({
        state: position.warningState,
        sku: position.name,
        on_hand: `${position.onHand} ${position.unit}`,
        par: position.parLevel ?? '',
        days: position.daysRemaining ?? '',
        confidence: position.confidence,
      })),
      orders: orders.map((row: any) => ({
        vendor: row.vendor,
        sku: row.sku,
        qty: `${row.recommended_qty} ${row.unit}`,
        cost: row.estimated_cost === null ? '' : `$${toNumber(row.estimated_cost).toFixed(2)}`,
        confidence: row.confidence,
      })),
      reviews: reviews.map((row: any) => ({
        id: row.id,
        risk: row.risk,
        confidence: row.confidence,
        task: row.title,
      })),
      evidence: evidence.map((row: any) => ({
        type: row.type,
        confidence: row.confidence,
        evidence: row.summary,
      })),
      sources: sources.map((row: any) => ({
        kind: row.kind,
        source: row.name,
        last_run: row.last_run ?? 'never',
        failures: toNumber(row.failures),
      })),
      recent: recent.map((row: any) => ({
        id: row.id,
        state: row.state,
        risk: row.risk,
        confidence: row.confidence,
        decision: row.title,
      })),
    }
  })

const tableFor = (panel: PanelName, state: DashboardState): string[][] => {
  if (panel === 'Overview') {
    return [
      ['metric', 'value'],
      ...Object.entries(state.summary).map(([key, value]) => [key, String(value)]),
    ]
  }
  const rows = state[panel.toLowerCase() as keyof Omit<DashboardState, 'summary'>] as Array<Record<string, string | number>>
  return rowsToTable(rows)
}

const rowsToTable = (rows: Array<Record<string, string | number>>): string[][] => {
  if (rows.length === 0) return [['status', 'next'], ['none', 'press s to generate simulated data or w to run workflow']]
  const headers = Object.keys(rows[0] ?? {})
  return [headers, ...rows.map((row) => headers.map((header) => toStringValue(row[header])))]
}

const renderTextTable = (rows: string[][]): string => {
  const widths = rows[0]?.map((_, column) =>
    Math.min(
      36,
      Math.max(
        3,
        ...rows.map((row) => plain(row[column] ?? '').length),
      ),
    ),
  ) ?? []
  return rows
    .map((row, index) =>
      row
        .map((cell, column) => pad(truncate(plain(cell), widths[column] ?? 12), widths[column] ?? 12))
        .join(' | ')
        .replace(/^(.+)$/, index === 0 ? '{cyan-fg}{bold}$1{/bold}{/cyan-fg}' : '$1'),
    )
    .join('\n')
}

const plain = (value: string): string => String(value ?? '').replace(/\s+/g, ' ').trim()

const truncate = (value: string, width: number): string => {
  if (value.length <= width) return value
  if (width <= 3) return value.slice(0, width)
  return `${value.slice(0, width - 3)}...`
}

const pad = (value: string, width: number): string => value.padEnd(width)

const detailFor = (panel: PanelName, state: DashboardState): string => {
  if (panel === 'Overview') {
    return [
      '{bold}Workflow{/bold}',
      'Press {cyan-fg}s{/cyan-fg} to generate a realistic simulated operating run.',
      'Press {cyan-fg}w{/cyan-fg} to run OpenClaw brain -> forecast -> orders on current data.',
      '',
      '{bold}Current posture{/bold}',
      `Inventory items: ${state.summary.inventory}`,
      `Review tasks: ${state.summary.review_tasks}`,
      `Open order recommendations: ${state.summary.open_orders}`,
    ].join('\n')
  }
  const rows = state[panel.toLowerCase() as keyof Omit<DashboardState, 'summary'>] as Array<Record<string, string | number>>
  return rows.length > 0 ? JSON.stringify(rows[0], null, 2) : 'No rows.'
}
