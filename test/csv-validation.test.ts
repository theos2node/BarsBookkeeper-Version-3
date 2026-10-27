import { describe, expect, it } from 'vitest'
import { parseCsv, parseJsonOrCsv } from '../src/ingest/csv.js'

describe('structured ingest parsing', () => {
  it('parses quoted CSV fields and normalized headers', () => {
    expect(parseCsv('SKU Name,Note\nVodka,"case, twelve"\n')).toEqual([
      { sku_name: 'Vodka', note: 'case, twelve' },
    ])
  })

  it('rejects malformed quotes, duplicate headers, and uneven rows', () => {
    expect(() => parseCsv('sku,note\nVodka,"unterminated')).toThrow('csv_unterminated_quote')
    expect(() => parseCsv('SKU Name,sku-name\nVodka,Gin')).toThrow(
      'csv_duplicate_header:sku_name',
    )
    expect(() => parseCsv('sku,quantity\nVodka')).toThrow('csv_column_count_mismatch')
  })

  it('requires JSON imports to contain object rows', () => {
    expect(() => parseJsonOrCsv('[{"sku":"Vodka"},42]')).toThrow('json_rows_invalid')
    expect(() => parseJsonOrCsv('["bad"]')).toThrow('json_rows_invalid')
  })

  it('validates direct array imports just like JSON imports', () => {
    for (const row of [null, 42, 'bad', []]) {
      expect(() => parseJsonOrCsv([row] as unknown as Record<string, unknown>[])).toThrow(
        'json_rows_invalid',
      )
    }
    const rows = [{ sku: 'Vodka', quantity: 2 }]
    expect(parseJsonOrCsv(rows)).toBe(rows)
    expect(parseJsonOrCsv([])).toEqual([])
  })
})
