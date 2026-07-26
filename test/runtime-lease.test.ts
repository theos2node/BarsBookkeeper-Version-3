import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fixedClock } from '../src/core/clock.js'
import { openDatabase, type Db } from '../src/db/database.js'
import { migrateDatabase } from '../src/db/migrations.js'
import {
  acquireRuntimeLease,
  heartbeatRuntimeLease,
  readRuntimeLease,
  releaseRuntimeLease,
} from '../src/runtime/lease.js'

describe('runtime lease', () => {
  let directory: string
  let first: Db
  let second: Db

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'bbk-lease-'))
    const path = join(directory, 'barsbookkeeper.sqlite')
    first = openDatabase(path)
    migrateDatabase(first)
    second = openDatabase(path)
  })

  afterEach(async () => {
    first.close()
    second.close()
    await rm(directory, { recursive: true, force: true })
  })

  it('atomically rejects an active competing owner and permits takeover after expiry', () => {
    const initial = fixedClock('2026-05-11T12:00:00.000Z')
    acquireRuntimeLease(first, { name: 'listener', owner: 'owner-a', ttlMinutes: 5 }, initial)

    expect(() =>
      acquireRuntimeLease(second, { name: 'listener', owner: 'owner-b', ttlMinutes: 5 }, initial),
    ).toThrow('backbone_listener_lock_held:owner-a')
    expect(() =>
      heartbeatRuntimeLease(second, { name: 'listener', owner: 'owner-b', ttlMinutes: 5 }, initial),
    ).toThrow('backbone_listener_lock_lost:listener')

    const afterExpiry = fixedClock('2026-05-11T12:06:00.000Z')
    acquireRuntimeLease(second, { name: 'listener', owner: 'owner-b', ttlMinutes: 5 }, afterExpiry)

    expect(readRuntimeLease(first, 'listener', afterExpiry)).toEqual(
      expect.objectContaining({ owner: 'owner-b', state: 'active' }),
    )
    expect(releaseRuntimeLease(first, { name: 'listener', owner: 'owner-a' })).toBe(false)
    expect(releaseRuntimeLease(second, { name: 'listener', owner: 'owner-b' })).toBe(true)
  })
})
