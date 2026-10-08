import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  emptyOrcadActivationRecord,
  type OrcadActivationRecord
} from '../../ssh/orcad-activation-record'
import {
  captureHostSnapshot,
  readActivationRecord,
  readPendingActivation,
  restoreHostSnapshot,
  stateUnchangedSinceSnapshot,
  writeActivationRecord
} from './host-install-state'
import { planHostRollback, pruneHostInstall } from './host-install-rollback'
import type { DaemonIsolation } from './host-install-census'
import { CURRENT_ORCAD_DAEMON_PROTOCOL } from '../../ssh/orcad-daemon-protocol-crossing'

const NO_DAEMON: DaemonIsolation = {
  state: 'no-daemon',
  pids: [],
  cgroupUnits: [],
  versions: [],
  protocolVersions: [],
  reason: ''
}

describe.skipIf(process.platform === 'win32')('host install state', () => {
  let root: string
  let base: string
  let dataRoot: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'host-install-state-'))
    base = join(root, 'base')
    dataRoot = join(root, 'data')
    mkdirSync(base)
    mkdirSync(join(dataRoot, 'profiles'), { recursive: true })
    writeFileSync(join(dataRoot, 'orca-profile-index.json'), '{"v":1}')
    mkdirSync(join(dataRoot, 'daemon'))
    writeFileSync(join(dataRoot, 'daemon', 'daemon-v36.token'), 'live-token')
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('round-trips the SSH deploy activation record and refuses an unreadable one', () => {
    expect(readActivationRecord(base)).toEqual(emptyOrcadActivationRecord())
    writeActivationRecord(base, { ...emptyOrcadActivationRecord(), active: '0.1.0+aa' })
    expect(readActivationRecord(base).active).toBe('0.1.0+aa')
    writeFileSync(join(base, 'orcad-active.json'), '{"schemaVersion":99}')
    expect(() => readActivationRecord(base)).toThrow(/cannot safely interpret/)
  })

  it('snapshots profile state, detects later writes, and restores without touching the daemon', () => {
    const pending = captureHostSnapshot({
      base,
      dataRoot,
      candidate: '0.1.0+bb',
      outgoing: '0.1.0+aa',
      now: new Date(1_000)
    })
    expect(pending.snapshot).toMatchObject({
      takenBeforeVersion: '0.1.0+bb',
      readableByVersion: '0.1.0+aa'
    })
    expect(readPendingActivation(base)).toEqual(pending)
    expect(stateUnchangedSinceSnapshot({ base, dataRoot, snapshot: pending.snapshot })).toBe(true)

    writeFileSync(join(dataRoot, 'orca-profile-index.json'), '{"v":2}')
    writeFileSync(join(dataRoot, 'daemon', 'daemon-v36.token'), 'rotated-token')
    expect(stateUnchangedSinceSnapshot({ base, dataRoot, snapshot: pending.snapshot })).toBe(false)

    expect(restoreHostSnapshot({ base, dataRoot, snapshot: pending.snapshot! })).toBe('restored')
    expect(readFileSync(join(dataRoot, 'orca-profile-index.json'), 'utf8')).toBe('{"v":1}')
    expect(readFileSync(join(dataRoot, 'daemon', 'daemon-v36.token'), 'utf8')).toBe('rotated-token')
  })

  it('records no snapshot for an empty root, and then treats any new state as a change', () => {
    rmSync(join(dataRoot, 'orca-profile-index.json'))
    rmSync(join(dataRoot, 'profiles'), { recursive: true })
    const pending = captureHostSnapshot({
      base,
      dataRoot,
      candidate: '0.1.0+bb',
      outgoing: null,
      now: new Date()
    })
    expect(pending.snapshot).toBeNull()
    expect(stateUnchangedSinceSnapshot({ base, dataRoot, snapshot: null })).toBe(true)
    writeFileSync(join(dataRoot, 'orca-profile-index.json'), '{}')
    expect(stateUnchangedSinceSnapshot({ base, dataRoot, snapshot: null })).toBe(false)
  })

  it('rolls back only with a target, a snapshot, and no terminals the snapshot cannot describe', () => {
    const pending = captureHostSnapshot({
      base,
      dataRoot,
      candidate: '0.1.0+bb',
      outgoing: '0.1.0+aa',
      now: new Date()
    })
    const record: OrcadActivationRecord = {
      ...emptyOrcadActivationRecord(),
      active: '0.1.0+bb',
      previous: '0.1.0+aa',
      activatedAt: new Date().toISOString(),
      snapshot: pending.snapshot
    }
    const plan = (
      census: Parameters<typeof planHostRollback>[0]['census'],
      rec = record,
      targetDaemonProtocol: Parameters<
        typeof planHostRollback
      >[0]['targetDaemonProtocol'] = CURRENT_ORCAD_DAEMON_PROTOCOL
    ) =>
      planHostRollback({
        base,
        dataRoot,
        record: rec,
        isolation: {
          ...NO_DAEMON,
          state: 'isolated',
          protocolVersions: [CURRENT_ORCAD_DAEMON_PROTOCOL.protocolVersion]
        },
        census,
        targetDaemonProtocol
      })
    expect(plan({ verdict: 'empty', liveSessions: 0 }).safety).not.toBe('unsafe')
    expect(plan({ verdict: 'live', liveSessions: 1 })).toMatchObject({
      code: 'orcad_rollback_orphans_live_terminals'
    })
    expect(plan({ verdict: 'unverifiable', liveSessions: null, reason: 'x' })).toMatchObject({
      code: 'orcad_rollback_census_unavailable'
    })
    expect(
      plan({ verdict: 'empty', liveSessions: 0 }, { ...record, previous: null })
    ).toMatchObject({
      code: 'orcad_rollback_no_target'
    })
    // A target that could not report its daemon protocol is planned as unable to attach.
    expect(plan({ verdict: 'live', liveSessions: 1 }, record, null).safety).toBe('unsafe')
  })

  it('prunes only unpinned, complete orcad versions', () => {
    const make = (name: string, complete = true) => {
      mkdirSync(join(base, name))
      if (complete) {
        writeFileSync(join(base, name, '.install-complete'), '')
      }
    }
    for (const version of ['1.0.0+a1', '1.0.0+b2', '1.0.0+c3', '1.0.0+d4', '1.0.0+e5']) {
      make(`orcad-${version}`)
    }
    make('orcad-1.0.0+f6', false)
    make('relay-1.0.0+a1')
    symlinkSync('orcad-1.0.0+e5', join(base, 'orcad-current'))
    const record = { ...emptyOrcadActivationRecord(), active: '1.0.0+a1', previous: '1.0.0+b2' }
    const result = pruneHostInstall({
      base,
      record,
      isolation: { ...NO_DAEMON, state: 'isolated', versions: ['1.0.0+c3'] }
    })
    expect(result.removed).toEqual(['orcad-1.0.0+d4'])
    for (const kept of ['a1', 'b2', 'c3', 'e5', 'f6']) {
      expect(existsSync(join(base, `orcad-1.0.0+${kept}`))).toBe(true)
    }
    expect(existsSync(join(base, 'relay-1.0.0+a1'))).toBe(true)
    expect(existsSync(join(base, 'orcad-current'))).toBe(true)
  })

  it('keeps every version while the daemon origin is unverifiable', () => {
    mkdirSync(join(base, 'orcad-1.0.0+d4'))
    writeFileSync(join(base, 'orcad-1.0.0+d4', '.install-complete'), '')
    const result = pruneHostInstall({
      base,
      record: emptyOrcadActivationRecord(),
      isolation: { ...NO_DAEMON, state: 'unverifiable' }
    })
    expect(result.removed).toEqual([])
  })
})
