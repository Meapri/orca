import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getHistorySessionDirName } from './history-paths'
import { collectExitedTerminalHistory } from './terminal-history-exited-retention'
import {
  EXITED_HISTORY_MIN_AGE_MS,
  resolveExitedHistoryRetentionPolicy,
  selectExitedHistoryForCollection,
  type ExitedHistoryRetentionPolicy
} from './terminal-history-exited-retention-policy'
import { flushPendingSessionTreeRemovals } from './terminal-history-session-tombstone'

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-09-26T12:00:00.000Z')

let basePath: string

beforeEach(() => {
  basePath = mkdtempSync(join(tmpdir(), 'history-retention-'))
})
afterEach(async () => {
  await flushPendingSessionTreeRemovals()
  rmSync(basePath, { recursive: true, force: true })
})

function writeSession(
  sessionId: string,
  meta: { endedAt: string | null; exitCode: number | null },
  logBytes = 100
): string {
  const dir = join(basePath, getHistorySessionDirName(sessionId))
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'meta.json'),
    JSON.stringify({
      cwd: '/w',
      cols: 80,
      rows: 24,
      startedAt: '2026-01-01T00:00:00.000Z',
      ...meta
    })
  )
  writeFileSync(join(dir, 'output.log'), 'x'.repeat(logBytes))
  return dir
}

function endedDaysAgo(days: number): string {
  return new Date(NOW - days * DAY_MS).toISOString()
}

const weekPolicy: ExitedHistoryRetentionPolicy = {
  maxAgeMs: 7 * DAY_MS,
  maxTotalBytes: null,
  minAgeMs: EXITED_HISTORY_MIN_AGE_MS
}

describe('collectExitedTerminalHistory', () => {
  it('collects exited sessions past the age limit and keeps recent ones', async () => {
    const old = writeSession('wt:old@@1', { endedAt: endedDaysAgo(8), exitCode: 0 })
    const recent = writeSession('wt:recent@@2', { endedAt: endedDaysAgo(1), exitCode: 1 })

    const result = await collectExitedTerminalHistory({
      basePath,
      policy: weekPolicy,
      isSessionInUse: () => false,
      now: NOW
    })

    expect(result).toMatchObject({ exited: 2, collected: 1 })
    expect(existsSync(old)).toBe(false)
    expect(existsSync(recent)).toBe(true)
  })

  it('never collects sessions whose exit was not observed, however old', async () => {
    // Running (crash-restorable) and shutdown-marked sessions may be live in another daemon.
    const running = writeSession('wt:running@@1', { endedAt: null, exitCode: null })
    const shutdownMarked = writeSession('wt:dispose@@2', {
      endedAt: endedDaysAgo(90),
      exitCode: null
    })
    const unreadable = join(basePath, getHistorySessionDirName('wt:corrupt@@3'))
    mkdirSync(unreadable)
    writeFileSync(join(unreadable, 'meta.json'), '{not json')

    const result = await collectExitedTerminalHistory({
      basePath,
      policy: { ...weekPolicy, maxAgeMs: 0, maxTotalBytes: 0 },
      isSessionInUse: () => false,
      now: NOW
    })

    expect(result).toMatchObject({ collected: 0, unverifiable: 3 })
    expect(existsSync(running)).toBe(true)
    expect(existsSync(shutdownMarked)).toBe(true)
    expect(existsSync(unreadable)).toBe(true)
  })

  it('skips an exited session that a daemon adapter still writes', async () => {
    const dir = writeSession('wt:reopened@@1', { endedAt: endedDaysAgo(30), exitCode: 0 })

    const result = await collectExitedTerminalHistory({
      basePath,
      policy: weekPolicy,
      isSessionInUse: (id) => id === 'wt:reopened@@1',
      now: NOW
    })

    expect(result.collected).toBe(0)
    expect(existsSync(dir)).toBe(true)
  })

  it('evicts oldest exited sessions first until the byte budget fits', async () => {
    const oldest = writeSession('wt:a@@1', { endedAt: endedDaysAgo(3), exitCode: 0 }, 1_000)
    const middle = writeSession('wt:b@@2', { endedAt: endedDaysAgo(2), exitCode: 0 }, 1_000)
    const newest = writeSession('wt:c@@3', { endedAt: endedDaysAgo(1), exitCode: 0 }, 1_000)

    const result = await collectExitedTerminalHistory({
      basePath,
      policy: { maxAgeMs: null, maxTotalBytes: 2_500, minAgeMs: EXITED_HISTORY_MIN_AGE_MS },
      isSessionInUse: () => false,
      now: NOW
    })

    expect(result.collected).toBe(1)
    expect(existsSync(oldest)).toBe(false)
    expect(existsSync(middle)).toBe(true)
    expect(existsSync(newest)).toBe(true)
  })

  it('leaves the tombstone queue and quarantine alone', async () => {
    mkdirSync(join(basePath, '.pending-delete', 'x'), { recursive: true })
    const result = await collectExitedTerminalHistory({
      basePath,
      policy: weekPolicy,
      isSessionInUse: () => false,
      now: NOW
    })
    expect(result.scanned).toBe(0)
  })
})

describe('selectExitedHistoryForCollection', () => {
  it('never selects a session younger than the minimum age, even over budget', () => {
    const selected = selectExitedHistoryForCollection(
      [{ sessionId: 'fresh', endedAtMs: NOW - 1_000, bytes: 10_000 }],
      { maxAgeMs: 0, maxTotalBytes: 0, minAgeMs: EXITED_HISTORY_MIN_AGE_MS },
      NOW
    )
    expect(selected).toEqual([])
  })
})

describe('resolveExitedHistoryRetentionPolicy', () => {
  it('defaults to a bounded policy', () => {
    const { policy, warnings } = resolveExitedHistoryRetentionPolicy({})
    expect(policy.maxAgeMs).toBe(7 * DAY_MS)
    expect(policy.maxTotalBytes).toBe(2048 * 1024 * 1024)
    expect(warnings).toEqual([])
  })

  it('accepts overrides and "off"', () => {
    const { policy } = resolveExitedHistoryRetentionPolicy({
      ORCA_TERMINAL_HISTORY_RETENTION_DAYS: '1.5',
      ORCA_TERMINAL_HISTORY_MAX_EXITED_MB: 'off'
    })
    expect(policy.maxAgeMs).toBe(1.5 * DAY_MS)
    expect(policy.maxTotalBytes).toBeNull()
  })

  it('rejects malformed values back to the default with a warning', () => {
    const { policy, warnings } = resolveExitedHistoryRetentionPolicy({
      ORCA_TERMINAL_HISTORY_RETENTION_DAYS: '-3'
    })
    expect(policy.maxAgeMs).toBe(7 * DAY_MS)
    expect(warnings).toHaveLength(1)
  })
})
