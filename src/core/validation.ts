export const boundedText = (
  value: unknown,
  field: string,
  options: { required?: boolean; maxLength?: number } = {},
): string => {
  const text =
    typeof value === 'string'
      ? value.trim()
      : typeof value === 'number' && Number.isFinite(value)
        ? String(value)
        : ''
  if (options.required && !text) throw new Error(`${field}_required`)
  if (text.length > (options.maxLength ?? 500)) throw new Error(`${field}_too_long`)
  return text
}

export const finiteNumber = (
  value: unknown,
  field: string,
  options: { min?: number; max?: number; fallback?: number } = {},
): number => {
  const parsed =
    value === null || value === undefined || value === ''
      ? options.fallback
      : typeof value === 'number'
        ? value
        : Number(value)
  if (parsed === undefined || !Number.isFinite(parsed)) throw new Error(`${field}_invalid`)
  if (options.min !== undefined && parsed < options.min) throw new Error(`${field}_below_minimum`)
  if (options.max !== undefined && parsed > options.max) throw new Error(`${field}_above_maximum`)
  return parsed
}
