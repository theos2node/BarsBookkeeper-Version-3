export const parseCsv = (text: string): Array<Record<string, string>> => {
  const rows: string[][] = []
  let cell = ''
  let row: string[] = []
  let quoted = false

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    const next = text[i + 1]
    if (quoted && char === '"' && next === '"') {
      cell += '"'
      i += 1
    } else if (char === '"') {
      quoted = !quoted
    } else if (!quoted && char === ',') {
      row.push(cell.trim())
      cell = ''
    } else if (!quoted && (char === '\n' || char === '\r')) {
      if (char === '\r' && next === '\n') i += 1
      row.push(cell.trim())
      if (row.some(Boolean)) rows.push(row)
      row = []
      cell = ''
    } else {
      cell += char
    }
  }
  row.push(cell.trim())
  if (row.some(Boolean)) rows.push(row)

  const [headersRaw, ...data] = rows
  if (!headersRaw) return []
  const headers = headersRaw.map((header) => header.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_'))
  return data.map((values) => {
    const record: Record<string, string> = {}
    headers.forEach((header, index) => {
      record[header] = values[index] || ''
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
  if (trimmed.startsWith('[')) return JSON.parse(trimmed) as T[]
  if (trimmed.startsWith('{')) return [JSON.parse(trimmed) as T]
  return parseCsv(trimmed) as T[]
}
