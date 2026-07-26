import { createHash } from 'node:crypto'

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (typeof value !== 'object' || value === null) return value

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]),
  )
}

export const stableJson = (value: unknown): string => JSON.stringify(canonicalize(value))

export const contentDigest = (value: unknown): string =>
  createHash('sha256').update(stableJson(value)).digest('hex')

export const contentDerivedId = (kind: string, value: unknown): string =>
  `auto-${kind}-${contentDigest(value).slice(0, 24)}`
