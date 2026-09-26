import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createDaemonFileLog,
  createNoopDaemonFileLog,
  DAEMON_LOG_FAILURE_BACKOFF_MS
} from './daemon-file-log'
import { ROTATION_LOCK_STALE_MS, rotationLockPath } from './daemon-file-log-rotation'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'daemon-file-log-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function readLines(filePath: string): Record<string, unknown>[] {
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

describe('createDaemonFileLog', () => {
  it('appends NDJSON lines with src/ts/pid/event and terse details', () => {
    const filePath = join(dir, 'daemon.log')
    const log = createDaemonFileLog(filePath)
    log.log('startup', { protocolVersion: 18 })
    log.log('session-created', { sessionId: 'abc', pid: 42 })

    const lines = readLines(filePath)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({ src: 'daemon', event: 'startup', protocolVersion: 18 })
    expect(typeof lines[0].ts).toBe('string')
    expect(lines[0].pid).toBe(process.pid)
    expect(lines[1]).toMatchObject({ event: 'session-created', sessionId: 'abc', pid: 42 })
  })

  it('rotates at the byte cap and keeps only the configured rotated files', () => {
    const filePath = join(dir, 'daemon.log')
    const log = createDaemonFileLog(filePath, { maxBytes: 150, maxRotatedFiles: 2 })
    for (let i = 0; i < 40; i++) {
      log.log('tick', { i })
    }

    expect(existsSync(filePath)).toBe(true)
    expect(existsSync(`${filePath}.1`)).toBe(true)
    expect(existsSync(`${filePath}.2`)).toBe(true)
    // Only 2 rotated files are retained — the oldest is dropped, not kept.
    expect(existsSync(`${filePath}.3`)).toBe(false)

    // The active file holds the most recent line.
    const active = readLines(filePath)
    expect(active.at(-1)).toMatchObject({ event: 'tick', i: 39 })
  })

  it('is fail-open when the log directory cannot be created', () => {
    // Make the parent a file so mkdir of the logs subdir fails (ENOTDIR).
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'x')
    const filePath = join(blocker, 'logs', 'daemon.log')

    const log = createDaemonFileLog(filePath)
    expect(() => log.log('startup')).not.toThrow()
    expect(() => log.close()).not.toThrow()
    expect(existsSync(filePath)).toBe(false)
  })

  it('never throws from log() even for non-serializable details', () => {
    const filePath = join(dir, 'daemon.log')
    const log = createDaemonFileLog(filePath)
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() => log.log('weird', circular)).not.toThrow()
    // The bad line is dropped; a later good line still lands.
    log.log('ok')
    const lines = readLines(filePath)
    expect(lines.map((l) => l.event)).toEqual(['ok'])
  })

  it('close() writes a terminal marker and stops further writes', () => {
    const filePath = join(dir, 'daemon.log')
    const log = createDaemonFileLog(filePath)
    log.log('startup')
    log.close()
    log.log('after-close')

    const events = readLines(filePath).map((l) => l.event)
    expect(events).toEqual(['startup', 'daemon-log-closed'])
  })
})

describe('createDaemonFileLog across processes', () => {
  function familyBytes(filePath: string): number {
    return [filePath, `${filePath}.1`, `${filePath}.2`, `${filePath}.3`]
      .filter((path) => existsSync(path))
      .reduce((sum, path) => sum + statSync(path).size, 0)
  }

  it('bounds the shared file when two daemon generations append to it', () => {
    const filePath = join(dir, 'daemon.log')
    // Two writers model the current daemon plus a legacy-protocol daemon on one --log-file.
    const current = createDaemonFileLog(filePath, { maxBytes: 400, maxRotatedFiles: 2 })
    const legacy = createDaemonFileLog(filePath, { maxBytes: 400, maxRotatedFiles: 2 })
    for (let i = 0; i < 200; i++) {
      current.log('tick', { i })
      legacy.log('tock', { i })
    }

    expect(statSync(filePath).size).toBeLessThanOrEqual(400)
    expect(existsSync(`${filePath}.3`)).toBe(false)
    // Three files of at most maxBytes each, however many writers share them.
    expect(familyBytes(filePath)).toBeLessThanOrEqual(3 * 400)
    expect(existsSync(rotationLockPath(filePath))).toBe(false)
  })

  it('counts bytes a previous daemon wrote before this one started', () => {
    const filePath = join(dir, 'daemon.log')
    writeFileSync(filePath, `${'x'.repeat(390)}\n`)
    const log = createDaemonFileLog(filePath, { maxBytes: 400, maxRotatedFiles: 2 })
    log.log('startup')

    expect(readFileSync(`${filePath}.1`, 'utf8')).toContain('xxxx')
    expect(readLines(filePath).map((line) => line.event)).toEqual(['startup'])
  })

  it('appends without rotating while another writer holds a fresh rotation lock', () => {
    const filePath = join(dir, 'daemon.log')
    writeFileSync(filePath, `${'x'.repeat(390)}\n`)
    writeFileSync(rotationLockPath(filePath), '')
    const log = createDaemonFileLog(filePath, { maxBytes: 400, maxRotatedFiles: 2 })
    log.log('startup')

    expect(existsSync(`${filePath}.1`)).toBe(false)
    expect(readFileSync(filePath, 'utf8')).toContain('"event":"startup"')
  })

  it('reclaims a rotation lock left by a writer that died mid-rotation', () => {
    const filePath = join(dir, 'daemon.log')
    writeFileSync(filePath, `${'x'.repeat(390)}\n`)
    const lockPath = rotationLockPath(filePath)
    writeFileSync(lockPath, '')
    const staleSeconds = (Date.now() - ROTATION_LOCK_STALE_MS - 1_000) / 1000
    utimesSync(lockPath, staleSeconds, staleSeconds)
    const log = createDaemonFileLog(filePath, { maxBytes: 400, maxRotatedFiles: 2 })
    log.log('startup')

    expect(existsSync(`${filePath}.1`)).toBe(true)
    expect(existsSync(lockPath)).toBe(false)
  })

  it('suspends after a write failure and resumes once the backoff passes', () => {
    const logsDir = join(dir, 'logs')
    const filePath = join(logsDir, 'daemon.log')
    let clock = 1_000_000
    const log = createDaemonFileLog(filePath, { now: () => clock })
    log.log('before')
    // A directory where the file should be makes the append fail (EISDIR).
    rmSync(logsDir, { recursive: true, force: true })
    mkdirSync(filePath, { recursive: true })
    log.log('while-broken')
    rmSync(logsDir, { recursive: true, force: true })

    log.log('during-backoff')
    expect(existsSync(filePath)).toBe(false)

    clock += DAEMON_LOG_FAILURE_BACKOFF_MS
    log.log('recovered')
    expect(readLines(filePath).map((line) => line.event)).toEqual(['recovered'])
  })
})

describe('createNoopDaemonFileLog', () => {
  it('accepts log/close calls without touching the filesystem', () => {
    const log = createNoopDaemonFileLog()
    expect(() => {
      log.log('startup', { x: 1 })
      log.close()
    }).not.toThrow()
  })
})
