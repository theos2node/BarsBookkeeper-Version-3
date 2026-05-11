import { inspect } from 'node:util'
import { ansi } from './ansi.js'

export type Status = 'ok' | 'warn' | 'fail' | 'skip' | 'info'

const labels: Record<Status, string> = {
  ok: ansi.green('OK'),
  warn: ansi.yellow('WARN'),
  fail: ansi.red('FAIL'),
  skip: ansi.gray('SKIP'),
  info: ansi.cyan('INFO'),
}

export class Terminal {
  constructor(private readonly stream: NodeJS.WriteStream = process.stdout) {}

  title(value: string): void {
    this.write(`${ansi.bold(value)}\n`)
  }

  subtitle(value: string): void {
    this.write(`${ansi.dim(value)}\n`)
  }

  line(value = ''): void {
    this.write(`${value}\n`)
  }

  success(value: string): void {
    this.status('ok', value)
  }

  warn(value: string): void {
    this.status('warn', value)
  }

  error(value: string): void {
    this.status('fail', value)
  }

  info(value: string): void {
    this.status('info', value)
  }

  status(status: Status, message: string, detail?: string): void {
    const suffix = detail ? ` ${ansi.gray(detail)}` : ''
    this.write(`${labels[status].padEnd(13)} ${message}${suffix}\n`)
  }

  section(value: string): void {
    this.write(`\n${ansi.bold(value)}\n`)
  }

  table(rows: Array<Record<string, unknown>>): void {
    if (rows.length === 0) {
      this.line(ansi.dim('No rows.'))
      return
    }

    const headers = Object.keys(rows[0] ?? {})
    const widths = headers.map((header) =>
      Math.max(header.length, ...rows.map((row) => formatCell(row[header]).length)),
    )

    this.line(headers.map((header, index) => ansi.bold(header.padEnd(widths[index] ?? 0))).join('  '))
    this.line(headers.map((_, index) => ansi.dim('-'.repeat(widths[index] ?? 0))).join('  '))
    for (const row of rows) {
      this.line(headers.map((header, index) => formatCell(row[header]).padEnd(widths[index] ?? 0)).join('  '))
    }
  }

  dump(value: unknown): void {
    if (value === undefined || value === null || value === '') return
    if (Array.isArray(value) && value.every(isFlatObject)) {
      this.table(value as Array<Record<string, unknown>>)
      return
    }
    if (isFlatObject(value)) {
      for (const [key, item] of Object.entries(value)) {
        this.line(`${ansi.dim(`${key}:`)} ${formatCell(item)}`)
      }
      return
    }
    this.line(inspect(value, { colors: ansi.enabled, depth: 5, compact: false }))
  }

  private write(value: string): void {
    this.stream.write(value)
  }
}

const isFlatObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every((item) => item === null || typeof item !== 'object')

const formatCell = (value: unknown): string => {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value)
  }
  if (value instanceof Date) return value.toISOString()
  return JSON.stringify(value)
}

