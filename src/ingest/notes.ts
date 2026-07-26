import { createHash } from 'node:crypto'
import { toNumber, type Db } from '../db/database.js'
import { ingestCounts, type CountRow, type IngestResult } from './index.js'

export type InventoryNoteParseResult = {
  rows: CountRow[]
  skipped: Array<{
    text: string
    reason: string
  }>
}

type NoteOptions = {
  occurredAt?: string
  sourceName?: string
}

type SkuCandidate = {
  id: number
  name: string
  unit: string
  packSize: number
  bottleSize: number | null
  tokens: Set<string>
}

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 12)

const noteParts = (text: string): string[] =>
  text
    .split(/[\n;]+/g)
    .map((line) => line.replace(/^\s*[-*]\s*/, '').trim())
    .flatMap((line) => line.split(/\s*,\s*(?=[A-Za-z0-9])/g))
    .map((line) => line.trim())
    .filter(Boolean)

const tokensFor = (value: string): Set<string> =>
  new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(/\s+/)
      .filter((token) => token.length > 1 && !/^\d+$/.test(token) && !['left', 'counted', 'count', 'about', 'around', 'on', 'hand'].includes(token)),
  )

const normalizeUnit = (value: string): string => {
  const unit = value.toLowerCase().replace(/\./g, '')
  if (unit === 'bottle' || unit === 'bottles' || unit === 'btl' || unit === 'btls') return 'bottle'
  if (unit === 'ea' || unit === 'unit' || unit === 'units') return 'each'
  return unit
}

const bottleSizeFromSkuName = (name: string, unit: string): number | null => {
  const cleanUnit = unit.toLowerCase()
  const liter = name.match(/(\d+(?:\.\d+)?)\s*l\b/i)
  if (liter && cleanUnit === 'ml') return Number(liter[1]) * 1000
  const milliliter = name.match(/(\d+(?:\.\d+)?)\s*ml\b/i)
  if (milliliter && cleanUnit === 'ml') return Number(milliliter[1])
  return null
}

const readSkuCandidates = (db: Db): SkuCandidate[] =>
  db
    .prepare(
      `SELECT s.id,
              s.name,
              s.unit,
              COALESCE(
                (
                  SELECT vi.pack_size
                  FROM vendor_items vi
                  WHERE vi.sku_id = s.id
                    AND vi.active = 1
                  ORDER BY vi.pack_size ASC
                  LIMIT 1
                ),
                1
              ) AS pack_size
       FROM skus s
       ORDER BY s.name`,
    )
    .all()
    .map((row: any) => {
      const name = String(row.name)
      const unit = String(row.unit || 'unit')
      return {
        id: toNumber(row.id),
        name,
        unit,
        packSize: Math.max(1, toNumber(row.pack_size, 1)),
        bottleSize: bottleSizeFromSkuName(name, unit),
        tokens: tokensFor(name),
      }
    })

const parseQuantity = (text: string): { skuText: string; quantity: number; unit: string } | null => {
  const cleaned = text
    .replace(/\b(on\s+hand|left|remaining|counted|count|approx(?:imately)?|about|around)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const unitPattern = '(bottles?|btls?|ml|oz|each|ea|units?)'
  const suffix = cleaned.match(new RegExp(`^(.+?)\\s+(\\d+(?:\\.\\d+)?)\\s*${unitPattern}$`, 'i'))
  if (suffix) {
    return {
      skuText: suffix[1]?.trim() ?? '',
      quantity: Number(suffix[2]),
      unit: normalizeUnit(suffix[3] ?? ''),
    }
  }
  const prefix = cleaned.match(new RegExp(`^(\\d+(?:\\.\\d+)?)\\s*${unitPattern}\\s+(.+)$`, 'i'))
  if (prefix) {
    return {
      skuText: prefix[3]?.trim() ?? '',
      quantity: Number(prefix[1]),
      unit: normalizeUnit(prefix[2] ?? ''),
    }
  }
  return null
}

const bestSkuMatch = (candidates: SkuCandidate[], skuText: string): SkuCandidate | null => {
  const clean = skuText.toLowerCase().trim()
  const exact = candidates.find((candidate) => candidate.name.toLowerCase() === clean)
  if (exact) return exact

  const contains = candidates.find((candidate) => candidate.name.toLowerCase().includes(clean) || clean.includes(candidate.name.toLowerCase()))
  if (contains) return contains

  const noteTokens = tokensFor(skuText)
  let best: { candidate: SkuCandidate; score: number } | null = null
  for (const candidate of candidates) {
    const intersection = Array.from(noteTokens).filter((token) => candidate.tokens.has(token)).length
    const score = intersection / Math.max(1, Math.min(noteTokens.size, candidate.tokens.size))
    if (score > (best?.score ?? 0)) best = { candidate, score }
  }
  return best && best.score >= 0.5 ? best.candidate : null
}

const toSkuQuantity = (candidate: SkuCandidate, quantity: number, unit: string): { quantity: number; unit: string } => {
  if (unit === 'bottle' && candidate.unit !== 'bottle') {
    return { quantity: quantity * (candidate.bottleSize ?? candidate.packSize), unit: candidate.unit }
  }
  return { quantity, unit: candidate.unit === unit ? candidate.unit : unit }
}

export const parseInventoryNotes = (db: Db, text: string, options: NoteOptions = {}): InventoryNoteParseResult => {
  const candidates = readSkuCandidates(db)
  const occurredAt = options.occurredAt ?? new Date().toISOString()
  const rows: CountRow[] = []
  const skipped: InventoryNoteParseResult['skipped'] = []

  for (const part of noteParts(text)) {
    const parsed = parseQuantity(part)
    if (!parsed || !Number.isFinite(parsed.quantity) || parsed.quantity < 0) {
      skipped.push({ text: part, reason: 'could not parse quantity/unit' })
      continue
    }
    const sku = bestSkuMatch(candidates, parsed.skuText)
    if (!sku) {
      skipped.push({ text: part, reason: 'no known SKU matched note text' })
      continue
    }
    const converted = toSkuQuantity(sku, parsed.quantity, parsed.unit)
    rows.push({
      countId: `NOTE-${digest({ part, occurredAt, sku: sku.name })}`,
      occurredAt,
      sku: sku.name,
      countedQuantity: Number(converted.quantity.toFixed(3)),
      unit: converted.unit,
    })
  }

  return { rows, skipped }
}

export const ingestInventoryNotes = (
  db: Db,
  text: string,
  options: NoteOptions & { dryRun?: boolean } = {},
): InventoryNoteParseResult & { ingest?: IngestResult } => {
  const parsed = parseInventoryNotes(db, text, options)
  if (options.dryRun || parsed.rows.length === 0) return parsed
  return {
    ...parsed,
    ingest: ingestCounts(db, parsed.rows, options.sourceName ?? 'Inventory notes'),
  }
}
