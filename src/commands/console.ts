import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { withBackendDb } from './backend.js'
import type { CommandContext, CommandDefinition } from './types.js'

export const consoleCommand = async (
  _args: string[],
  context: CommandContext,
  commands: CommandDefinition[],
  dispatch: (args: string[], context: CommandContext) => Promise<number>,
): Promise<void> => {
  context.terminal.title('Bars Bookkeeper console')
  context.terminal.subtitle('Type `help` for commands. Type `exit` or `quit` to close.')

  if (!input.isTTY) {
    await renderSnapshot(context)
    return
  }

  const rl = createInterface({ input, output })
  try {
    for (;;) {
      const line = (await rl.question('bbk> ')).trim()
      if (!line) continue
      if (line === 'exit' || line === 'quit') break
      if (line === 'help') {
        for (const command of commands) {
          if (command.path.join(' ') === 'console') continue
          context.terminal.line(`  ${command.usage.padEnd(32)} ${command.summary}`)
        }
        continue
      }
      await dispatch(splitShellish(line), context)
    }
  } finally {
    rl.close()
  }
}

const renderSnapshot = async (context: CommandContext) => {
  context.terminal.section('Snapshot')
  await withBackendDb(context.config, async (db: any) => {
    const inventory = db
      .prepare(
        `SELECT s.name, s.unit, COALESCE(SUM(e.quantity), 0) AS on_hand, s.par_level
         FROM skus s
         LEFT JOIN inventory_events e ON e.sku_id = s.id
         GROUP BY s.id
         ORDER BY s.name`,
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
    context.terminal.section('Inventory')
    context.terminal.table(inventory)
    context.terminal.section('Open order recommendations')
    context.terminal.table(orders.length > 0 ? orders : [{ status: 'none', next: 'run `bbk orders generate`' }])
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

  if (current) parts.push(current)
  return parts
}
