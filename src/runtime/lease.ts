import { systemClock, type Clock } from '../core/clock.js'
import { toNumber, type Db } from '../db/database.js'

export type RuntimeLeaseState = {
  present: boolean
  name: string
  owner: string
  acquiredAt: string
  heartbeatAt: string
  expiresAt: string
  state: 'active' | 'stale' | 'absent'
  ageMinutes: number
}

export type RuntimeLeaseInput = {
  name: string
  owner: string
  ttlMinutes: number
}

const expiresAt = (now: Date, ttlMinutes: number): string =>
  new Date(now.getTime() + Math.max(1, ttlMinutes) * 60_000).toISOString()

export const acquireRuntimeLease = (
  db: Db,
  input: RuntimeLeaseInput,
  clock: Clock = systemClock,
): void => {
  const now = clock.now()
  const acquiredAt = now.toISOString()
  const result = db
    .prepare(
      `INSERT INTO backbone_runtime_locks (name, owner, acquired_at, heartbeat_at, expires_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         owner = excluded.owner,
         acquired_at = excluded.acquired_at,
         heartbeat_at = excluded.heartbeat_at,
         expires_at = excluded.expires_at
       WHERE backbone_runtime_locks.owner = excluded.owner
          OR backbone_runtime_locks.expires_at <= excluded.acquired_at`,
    )
    .run(input.name, input.owner, acquiredAt, acquiredAt, expiresAt(now, input.ttlMinutes))

  if (toNumber(result.changes) > 0) return
  const existing = db
    .prepare('SELECT owner, expires_at FROM backbone_runtime_locks WHERE name = ?')
    .get(input.name)
  throw new Error(
    `backbone_listener_lock_held:${String(existing?.owner ?? 'unknown')}:expires:${String(existing?.expires_at ?? 'unknown')}`,
  )
}

export const heartbeatRuntimeLease = (
  db: Db,
  input: RuntimeLeaseInput,
  clock: Clock = systemClock,
): void => {
  const now = clock.now()
  const result = db
    .prepare(
      `UPDATE backbone_runtime_locks
       SET heartbeat_at = ?, expires_at = ?
       WHERE name = ? AND owner = ?`,
    )
    .run(now.toISOString(), expiresAt(now, input.ttlMinutes), input.name, input.owner)
  if (toNumber(result.changes) === 0) throw new Error(`backbone_listener_lock_lost:${input.name}`)
}

export const releaseRuntimeLease = (
  db: Db,
  input: Pick<RuntimeLeaseInput, 'name' | 'owner'>,
): boolean =>
  toNumber(
    db
      .prepare('DELETE FROM backbone_runtime_locks WHERE name = ? AND owner = ?')
      .run(input.name, input.owner).changes,
  ) > 0

export const readRuntimeLease = (
  db: Db,
  name = 'backbone-listener',
  clock: Clock = systemClock,
): RuntimeLeaseState => {
  const row = db.prepare('SELECT * FROM backbone_runtime_locks WHERE name = ?').get(name)
  if (!row) {
    return {
      present: false,
      name,
      owner: '',
      acquiredAt: '',
      heartbeatAt: '',
      expiresAt: '',
      state: 'absent',
      ageMinutes: Number.POSITIVE_INFINITY,
    }
  }

  const expires = String(row.expires_at)
  const heartbeat = String(row.heartbeat_at)
  return {
    present: true,
    name,
    owner: String(row.owner),
    acquiredAt: String(row.acquired_at),
    heartbeatAt: heartbeat,
    expiresAt: expires,
    state: new Date(expires).getTime() > clock.now().getTime() ? 'active' : 'stale',
    ageMinutes: Math.max(0, clock.now().getTime() - new Date(heartbeat).getTime()) / 60_000,
  }
}
