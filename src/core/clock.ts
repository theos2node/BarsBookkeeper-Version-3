export type Clock = {
  now(): Date
}

export const systemClock: Clock = {
  now: () => new Date(),
}

export const fixedClock = (instant: string | Date): Clock => {
  const date = instant instanceof Date ? new Date(instant) : new Date(instant)
  if (!Number.isFinite(date.getTime())) throw new Error('clock_instant_invalid')
  return {
    now: () => new Date(date),
  }
}

export const nowIso = (clock: Clock = systemClock): string => clock.now().toISOString()

export const parseIsoInstant = (value: string, field = 'timestamp'): string => {
  const clean = value.trim()
  const parsed = new Date(clean)
  if (!clean || !Number.isFinite(parsed.getTime())) throw new Error(`${field}_invalid`)
  return parsed.toISOString()
}

export const optionalIsoInstant = (
  value: string | undefined,
  fallback: string,
  field = 'timestamp',
): string => (value ? parseIsoInstant(value, field) : fallback)

export const millisecondsBetween = (later: string, earlier: string): number =>
  new Date(later).getTime() - new Date(earlier).getTime()
