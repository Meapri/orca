import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { SecurityEventLog } from './security-event-log'

function readEvents(path: string): Record<string, unknown>[] {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line): Record<string, unknown> => JSON.parse(line))
}

describe('SecurityEventLog', () => {
  it('writes one timestamped NDJSON record per event, creating the logs dir lazily', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-security-log-'))
    const path = join(root, 'logs', 'security.log')
    const log = new SecurityEventLog(path, { now: () => Date.UTC(2026, 0, 2) })
    expect(existsSync(path)).toBe(false)

    log.record({ event: 'device.revoked', deviceId: 'd1', scope: 'runtime', closedConnections: 2 })
    log.close()

    expect(readEvents(path)).toEqual([
      {
        ts: '2026-01-02T00:00:00.000Z',
        type: 'orca.security',
        event: 'device.revoked',
        deviceId: 'd1',
        scope: 'runtime',
        closedConnections: 2
      }
    ])
  })

  it('rate-limits auth failures and reports how many it dropped', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-security-log-'))
    const path = join(root, 'security.log')
    const clock = { now: 0 }
    const log = new SecurityEventLog(path, { now: () => clock.now, authFailuresPerWindow: 2 })

    for (let index = 0; index < 5; index += 1) {
      log.record({ event: 'auth.failed', transport: 'direct', reason: 'Unauthorized' })
    }
    // Why: non-auth events are never throttled, even inside a saturated window.
    log.record({ event: 'pairing.offered', deviceId: 'd2' })
    clock.now = 60_000
    log.record({ event: 'auth.failed', transport: 'direct', reason: 'Unauthorized' })
    log.close()

    expect(readEvents(path).map((entry) => [entry.event, entry.suppressed])).toEqual([
      ['auth.failed', undefined],
      ['auth.failed', undefined],
      ['pairing.offered', undefined],
      ['auth.failed.suppressed', 3],
      ['auth.failed', undefined]
    ])
  })

  it('rotates by size into a bounded file family', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-security-log-'))
    const path = join(root, 'security.log')
    const log = new SecurityEventLog(path, { maxBytes: 200, maxFiles: 2 })

    for (let index = 0; index < 10; index += 1) {
      log.record({ event: 'pairing.offered', deviceId: `device-${index}` })
    }
    log.close()

    expect(existsSync(`${path}.1`)).toBe(true)
    expect(existsSync(`${path}.2`)).toBe(false)
    expect(readFileSync(path, 'utf8').length).toBeLessThanOrEqual(200)
  })

  it('degrades to a no-op when the log path is unusable', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-security-log-'))
    const blocker = join(root, 'not-a-dir')
    writeFileSync(blocker, '')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const log = new SecurityEventLog(join(blocker, 'security.log'))

    expect(() => log.record({ event: 'pairing.offered' })).not.toThrow()
    expect(() => log.record({ event: 'pairing.offered' })).not.toThrow()
    expect(errorSpy).toHaveBeenCalledTimes(1)
    errorSpy.mockRestore()
  })
})
