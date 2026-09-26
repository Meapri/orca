import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { emptyOrcadActivationRecord } from '../../ssh/orcad-activation-record'
import {
  assessServiceStop,
  gateHostActivation,
  planHostActivation
} from './host-install-activation'
import type { DaemonIsolation, HostTerminalCensus } from './host-install-census'

function isolation(state: DaemonIsolation['state']): DaemonIsolation {
  return {
    state,
    pids: state === 'no-daemon' ? [] : [42],
    cgroupUnits: [],
    versions: [],
    reason: state
  }
}

const EMPTY: HostTerminalCensus = { verdict: 'empty', liveSessions: 0 }
const LIVE: HostTerminalCensus = { verdict: 'live', liveSessions: 3 }
const UNKNOWN: HostTerminalCensus = { verdict: 'unverifiable', liveSessions: null, reason: 'x' }
const RECORD = { ...emptyOrcadActivationRecord(), active: '0.1.0+aa' }

describe('assessServiceStop', () => {
  it('allows the stop when the daemon holds its own scope, whatever the census says', () => {
    expect(assessServiceStop(isolation('isolated'), UNKNOWN).safe).toBe(true)
  })

  it('requires an empty census for an unscoped or unverifiable daemon', () => {
    expect(assessServiceStop(isolation('unscoped'), EMPTY).safe).toBe(true)
    expect(assessServiceStop(isolation('unscoped'), LIVE).safe).toBe(false)
    expect(assessServiceStop(isolation('unverifiable'), UNKNOWN).safe).toBe(false)
  })

  it('does not read a missing daemon record plus a failed census as safe', () => {
    expect(assessServiceStop(isolation('no-daemon'), UNKNOWN).safe).toBe(false)
    expect(assessServiceStop(isolation('no-daemon'), EMPTY).safe).toBe(true)
  })
})

describe('planHostActivation', () => {
  const plan = (overrides: Partial<Parameters<typeof planHostActivation>[0]>) =>
    planHostActivation({
      record: RECORD,
      candidateVersion: '0.1.0+bb',
      isolation: isolation('isolated'),
      census: EMPTY,
      ...overrides
    })

  it('proceeds on an idle isolated host', () => {
    expect(plan({}).action).toBe('proceed')
  })

  it('is a no-op for the already active version', () => {
    expect(plan({ candidateVersion: RECORD.active }).action).toBe('noop')
  })

  it('defers on live terminals unless forced, when the daemon survives the restart', () => {
    expect(plan({ census: LIVE })).toMatchObject({
      action: 'refuse',
      code: 'orcad_update_terminals_running'
    })
    expect(plan({ census: LIVE, force: true }).action).toBe('proceed')
    expect(plan({ census: UNKNOWN })).toMatchObject({
      code: 'orcad_update_terminal_census_unavailable'
    })
  })

  it('never lets --force stop an unscoped daemon that owns live work', () => {
    expect(plan({ isolation: isolation('unscoped'), census: LIVE, force: true })).toMatchObject({
      action: 'refuse',
      code: 'orcad_install_stop_destructive'
    })
    expect(
      plan({ isolation: isolation('unverifiable'), census: UNKNOWN, force: true }).action
    ).toBe('refuse')
  })

  it('skips the stop check when no service is running', () => {
    expect(
      plan({ isolation: isolation('no-daemon'), census: UNKNOWN, serviceStopped: true }).action
    ).toBe('proceed')
  })
})

describe('gateHostActivation', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function versionDir(): { dir: string; buildHash: string } {
    const dir = mkdtempSync(join(tmpdir(), 'host-install-gate-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'orcad.js'), 'orcad bytes')
    const buildHash = createHash('sha256').update('orcad bytes').digest('hex').slice(0, 16)
    return { dir, buildHash }
  }

  function readinessLine(buildHash: string, pid: number, state = 'live'): string {
    return `${JSON.stringify({
      type: 'orca_server_ready',
      runtimeId: 'r',
      boundEndpoint: 'ws://127.0.0.1:6768',
      advertisedEndpoint: 'ws://127.0.0.1:6768',
      pairing: { available: false, reason: 'disabled_by_operator', guidance: '' },
      health: {
        buildHash,
        buildVersion: '0.1.0+bb',
        pid,
        terminalDaemon: {
          state,
          ownsFreshSessions: true,
          selfTest: { ok: true, coverage: 'pty-spawn', verdict: 'healthy', durationMs: 1 }
        }
      }
    })}\n`
  }

  it('activates the unit main process that proved its daemon', () => {
    const { dir, buildHash } = versionDir()
    expect(
      gateHostActivation({
        readinessRaw: readinessLine(buildHash, 77),
        versionDir: dir,
        fullVersion: '0.1.0+bb',
        mainPid: 77
      })
    ).toMatchObject({ decision: 'activate', coverage: 'pty-spawn' })
  })

  it('rejects readiness published by a process other than the unit main PID', () => {
    const { dir, buildHash } = versionDir()
    expect(
      gateHostActivation({
        readinessRaw: readinessLine(buildHash, 77),
        versionDir: dir,
        fullVersion: '0.1.0+bb',
        mainPid: 78
      })
    ).toMatchObject({ decision: 'reject', code: 'orcad_activation_build_mismatch' })
  })

  it('rejects other bytes, silence and a degraded daemon', () => {
    const { dir, buildHash } = versionDir()
    const gate = (readinessRaw: string) =>
      gateHostActivation({ readinessRaw, versionDir: dir, fullVersion: '0.1.0+bb', mainPid: null })
    expect(gate(readinessLine('0000000000000000', 77))).toMatchObject({
      code: 'orcad_activation_build_mismatch'
    })
    expect(gate('')).toMatchObject({ code: 'orcad_activation_no_readiness' })
    expect(gate(readinessLine(buildHash, 77, 'degraded'))).toMatchObject({
      code: 'orcad_activation_daemon_degraded'
    })
  })
})
