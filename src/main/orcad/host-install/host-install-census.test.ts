import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  daemonEntryInstallVersion,
  evaluateTerminalCensus,
  inspectDaemonIsolation
} from './host-install-census'

function census(result: Record<string, unknown>, ok = true): string {
  return JSON.stringify({ id: 'x', ok, result })
}

const COMPLETE_SCOPE = { hostIds: ['local'], omittedHostIds: [] }

describe('evaluateTerminalCensus', () => {
  it('reads an untruncated, fully scoped, empty listing as empty', () => {
    expect(
      evaluateTerminalCensus(census({ terminals: [], truncated: false, hostScope: COMPLETE_SCOPE }))
    ).toEqual({ verdict: 'empty', liveSessions: 0 })
  })

  it('counts live terminals', () => {
    expect(
      evaluateTerminalCensus(
        census({ terminals: [{}, {}], truncated: false, hostScope: COMPLETE_SCOPE })
      )
    ).toEqual({ verdict: 'live', liveSessions: 2 })
  })

  it('treats a paired-runtime omission as outside the boundary', () => {
    const hostScope = { hostIds: ['local'], omittedHostIds: ['runtime:peer-1'] }
    expect(evaluateTerminalCensus(census({ terminals: [], truncated: false, hostScope }))).toEqual({
      verdict: 'empty',
      liveSessions: 0
    })
  })

  it.each([
    ['no output', null],
    ['blank output', '  '],
    ['non-JSON output', 'Could not connect'],
    ['a failed request', census({ terminals: [] }, false)],
    ['a truncated listing', census({ terminals: [], truncated: true, hostScope: COMPLETE_SCOPE })],
    ['a missing truncation flag', census({ terminals: [], hostScope: COMPLETE_SCOPE })],
    ['a missing host scope', census({ terminals: [], truncated: false })],
    [
      'an omitted SSH host',
      census({
        terminals: [],
        truncated: false,
        hostScope: { hostIds: ['local'], omittedHostIds: ['ssh:box'] }
      })
    ],
    ['no terminal list', census({ truncated: false, hostScope: COMPLETE_SCOPE })]
  ])('never reads %s as empty', (_label, raw) => {
    expect(evaluateTerminalCensus(raw)).toMatchObject({
      verdict: 'unverifiable',
      liveSessions: null
    })
  })
})

describe('daemonEntryInstallVersion', () => {
  it('reads the version of the install dir a daemon was forked from', () => {
    expect(daemonEntryInstallVersion('/h/.orca-remote/orcad-0.1.0+ab12/daemon-entry.js')).toBe(
      '0.1.0+ab12'
    )
  })

  it('ignores the unversioned link and non-install paths', () => {
    expect(daemonEntryInstallVersion('/h/.orca-remote/orcad-current/daemon-entry.js')).toBeNull()
    expect(daemonEntryInstallVersion('/repo/out/orcad/daemon-entry.js')).toBeNull()
    expect(daemonEntryInstallVersion(null)).toBeNull()
  })
})

describe('inspectDaemonIsolation', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  function fixture(records: Record<string, string>, cgroups: Record<number, string> = {}) {
    const root = mkdtempSync(join(tmpdir(), 'host-install-isolation-'))
    roots.push(root)
    const dataRoot = join(root, 'data')
    const procRoot = join(root, 'proc')
    mkdirSync(join(dataRoot, 'daemon'), { recursive: true })
    for (const [name, contents] of Object.entries(records)) {
      writeFileSync(join(dataRoot, 'daemon', name), contents)
    }
    for (const [pid, contents] of Object.entries(cgroups)) {
      mkdirSync(join(procRoot, pid), { recursive: true })
      writeFileSync(join(procRoot, pid, 'cgroup'), contents)
    }
    return { dataRoot, procRoot }
  }

  const record = (pid: number) =>
    JSON.stringify({ pid, entryPath: '/h/.orca-remote/orcad-0.1.0+ab12/daemon-entry.js' })
  const alive = () => 'alive' as const

  it('reports isolation when every live daemon sits in its own scope', () => {
    const paths = fixture(
      { 'daemon-v36.pid': record(900) },
      { 900: '0::/user.slice/user-1000.slice/user@1000.service/app.slice/orca-daemon-n1.scope\n' }
    )
    expect(inspectDaemonIsolation({ ...paths, platform: 'linux', probe: alive })).toMatchObject({
      state: 'isolated',
      pids: [900],
      cgroupUnits: ['orca-daemon-n1.scope'],
      versions: ['0.1.0+ab12']
    })
  })

  it('reports unscoped when a live daemon shares the service cgroup', () => {
    const paths = fixture(
      { 'daemon-v36.pid': record(901) },
      { 901: '0::/system.slice/orcad.service\n' }
    )
    expect(inspectDaemonIsolation({ ...paths, platform: 'linux', probe: alive }).state).toBe(
      'unscoped'
    )
  })

  it('reports no daemon only when the host confirms the recorded PID is gone', () => {
    const paths = fixture({ 'daemon-v36.pid': record(902) })
    expect(inspectDaemonIsolation({ ...paths, platform: 'linux', probe: () => 'dead' }).state).toBe(
      'no-daemon'
    )
  })

  it('never guesses isolation off Linux or from a torn record', () => {
    const live = fixture({ 'daemon-v36.pid': record(903) })
    expect(inspectDaemonIsolation({ ...live, platform: 'darwin', probe: alive }).state).toBe(
      'unverifiable'
    )
    const torn = fixture({ 'daemon-v36.pid': '{"pid":' })
    expect(inspectDaemonIsolation({ ...torn, platform: 'linux', probe: alive }).state).toBe(
      'unverifiable'
    )
  })
})
