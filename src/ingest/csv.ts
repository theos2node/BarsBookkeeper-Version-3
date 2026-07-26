export const parseCsv = (text: string): Array<Record<string, string>> => {
  const rows: Array<{ values: string[]; line: number }> = []
  let cell = ''
  let row: string[] = []
  let quoted = false
  let quoteClosed = false
  let line = 1
  let rowLine = 1

  const pushCell = (): void => {
    row.push(cell.trim())
    cell = ''
    quoteClosed = false
  }

  const pushRow = (): void => {
    pushCell()
    if (row.some(Boolean)) rows.push({ values: row, line: rowLine })
    row = []
    rowLine = line + 1
  }

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    const next = text[i + 1]
    if (quoted && char === '"' && next === '"') {
      cell += '"'
      i += 1
    } else if (quoted && char === '"') {
      quoted = false
      quoteClosed = true
    } else if (quoted) {
      cell += char
      if (char === '\n') line += 1
    } else if (quoteClosed && (char === ' ' || char === '\t')) {
      continue
    } else if (quoteClosed && char !== ',' && char !== '\n' && char !== '\r') {
      throw new Error(`csv_unexpected_character_after_quote:line:${line}`)
    } else if (char === '"') {
      if (cell.trim() !== '') throw new Error(`csv_unexpected_quote:line:${line}`)
      cell = ''
      quoted = true
    } else if (!quoted && char === ',') {
      pushCell()
    } else if (!quoted && (char === '\n' || char === '\r')) {
      if (char === '\r' && next === '\n') i += 1
      pushRow()
      line += 1
    } else {
      cell += char
    }
  }
  if (quoted) throw new Error(`csv_unterminated_quote:line:${rowLine}`)
  if (cell !== '' || row.length > 0) pushRow()

  const [headersRaw, ...data] = rows
  if (!headersRaw) return []
  const headers = headersRaw.values.map((header, index) => {
    const normalized = header
      .replace(/^\uFEFF/, '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
    if (!normalized) throw new Error(`csv_header_invalid:column:${index + 1}`)
    return normalized
  })
  const duplicate = headers.find((header, index) => headers.indexOf(header) !== index)
  if (duplicate) throw new Error(`csv_duplicate_header:${duplicate}`)

  return data.map(({ values, line: dataLine }) => {
    if (values.length !== headers.length) {
      throw new Error(
        `csv_column_count_mismatch:line:${dataLine}:expected:${headers.length}:actual:${values.length}`,
      )
    }
    const record: Record<string, string> = {}
    headers.forEach((header, index) => {
      record[header] = values[index] ?? ''
    })
    return record
  })
}

export const toNumber = (value: unknown, fallback = 0) => {
  if (value === null || value === undefined || value === '') return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export const parseJsonOrCsv = <T extends Record<string, unknown>>(input: string | T[]): T[] => {
  if (Array.isArray(input)) return input
  const trimmed = input.trim()
  if (!trimmed) return []
  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed) as unknown
    if (!Array.isArray(parsed) || !parsed.every(isRecord)) throw new Error('json_rows_invalid')
    return parsed as T[]
  }
  if (trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed) as unknown
    if (!isRecord(parsed)) throw new Error('json_row_invalid')
    return [parsed as T]
  }
  return parseCsv(trimmed) as T[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
