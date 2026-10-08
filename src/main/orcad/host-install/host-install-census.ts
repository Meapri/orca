/**
 * What the on-host installer knows about live work before it stops orcad.
 *
 * Two independent facts, both read on the execution host rather than inferred:
 *
 *  - **Isolation.** Whether the live terminal daemon sits in its own `orca-daemon-*.scope`
 *    (read from `/proc/<pid>/cgroup`, the same probe the daemon publishes as `cgroupUnit`).
 *    Only then is a service-unit stop non-destructive to its PTYs.
 *  - **Census.** A fresh `terminal list --json` answer, judged by the rule in
 *    `docs/reference/orcad-operations.md`: untruncated, explicit and complete `hostScope`,
 *    no terminals. Anything short of that is `unverifiable` — never "empty".
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { detectOwnCgroupScopeUnit } from '../../daemon/daemon-cgroup-scope'
import { parseDaemonPidFile } from '../../daemon/daemon-pid-file-parse'
import {
  hostScopeCensusIsComplete,
  type RuntimeListingHostScope
} from '../../../shared/runtime-listing-host-scope'
import { parseExecutionHostId } from '../../../shared/execution-host'
import { remoteInstallVersionDirRegex, ORCAD_INSTALL_MODEL } from '../../ssh/remote-install-model'

export type HostTerminalCensus =
  | { verdict: 'empty'; liveSessions: 0 }
  | { verdict: 'live'; liveSessions: number }
  | { verdict: 'unverifiable'; liveSessions: null; reason: string }

function unverifiable(reason: string): HostTerminalCensus {
  return { verdict: 'unverifiable', liveSessions: null, reason }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readHostScope(value: unknown): RuntimeListingHostScope | undefined {
  if (!isRecord(value) || !Array.isArray(value.hostIds) || !Array.isArray(value.omittedHostIds)) {
    return undefined
  }
  const parse = (id: unknown) => (typeof id === 'string' ? parseExecutionHostId(id) : null)
  const omitted = value.omittedHostIds.map(parse)
  // An omission this installer cannot even name is an unknown gap, never a covered host.
  if (omitted.some((host) => host === null)) {
    return undefined
  }
  return {
    hostIds: value.hostIds.flatMap((id) => {
      const host = parse(id)
      return host ? [host.id] : []
    }),
    omittedHostIds: omitted.flatMap((host) => (host ? [host.id] : []))
  }
}

/** Judge raw `terminal list --json` output. `null` means the census command never answered. */
export function evaluateTerminalCensus(raw: string | null): HostTerminalCensus {
  if (raw === null || raw.trim() === '') {
    return unverifiable('the terminal census command produced no output')
  }
  let envelope: unknown
  try {
    envelope = JSON.parse(raw.trim())
  } catch {
    return unverifiable('the terminal census output is not JSON')
  }
  if (!isRecord(envelope) || envelope.ok !== true || !isRecord(envelope.result)) {
    return unverifiable('the terminal census request failed')
  }
  const { terminals, truncated, hostScope } = envelope.result
  if (!Array.isArray(terminals)) {
    return unverifiable('the terminal census carried no terminal list')
  }
  if (truncated !== false) {
    return unverifiable('the terminal census is truncated')
  }
  if (!hostScopeCensusIsComplete(readHostScope(hostScope))) {
    return unverifiable('the terminal census does not cover every execution host this runtime owns')
  }
  return terminals.length === 0
    ? { verdict: 'empty', liveSessions: 0 }
    : { verdict: 'live', liveSessions: terminals.length }
}

export type DaemonIsolation = {
  state: 'isolated' | 'unscoped' | 'no-daemon' | 'unverifiable'
  pids: number[]
  cgroupUnits: string[]
  /** Full versions of the install dirs live daemons were forked from; GC must keep them. */
  versions: string[]
  /** Protocol of each live daemon, from its `daemon-v<N>.pid` record name. */
  protocolVersions: number[]
  reason: string
}

/** The one protocol the live sessions' daemon speaks; null when none or several are live. */
export function daemonProtocolForCensus(isolation: DaemonIsolation): number | null {
  const distinct = [...new Set(isolation.protocolVersions)]
  return distinct.length === 1 ? distinct[0]! : null
}

type ProcessProbe = (pid: number) => 'alive' | 'dead' | 'unknown'

/** `kill(pid, 0)`: ESRCH is host evidence of absence; EPERM means someone holds the PID. */
export function probeProcess(pid: number): 'alive' | 'dead' | 'unknown' {
  try {
    process.kill(pid, 0)
    return 'alive'
  } catch (error) {
    const code = isRecord(error) ? error.code : undefined
    if (code === 'ESRCH') {
      return 'dead'
    }
    return code === 'EPERM' ? 'alive' : 'unknown'
  }
}

/** The `orcad-<version>` directory a daemon entry path lives in, when it is one. */
export function daemonEntryInstallVersion(entryPath: string | null): string | null {
  if (!entryPath) {
    return null
  }
  const match = remoteInstallVersionDirRegex(ORCAD_INSTALL_MODEL).exec(basename(dirname(entryPath)))
  return match ? match[1] : null
}

/**
 * Inspect every daemon PID record under `<dataRoot>/daemon` (one per protocol version).
 *
 * Any live daemon outside a scope makes the whole root `unscoped`, because one combined-unit
 * stop reaches all of them. Off Linux there is no cgroup to read, so a live daemon is
 * `unverifiable` rather than assumed either way.
 */
export function inspectDaemonIsolation(options: {
  dataRoot: string
  platform?: NodeJS.Platform
  procRoot?: string
  probe?: ProcessProbe
}): DaemonIsolation {
  const platform = options.platform ?? process.platform
  const procRoot = options.procRoot ?? '/proc'
  const probe = options.probe ?? probeProcess
  const daemonDir = join(options.dataRoot, 'daemon')
  const result: DaemonIsolation = {
    state: 'no-daemon',
    pids: [],
    cgroupUnits: [],
    versions: [],
    protocolVersions: [],
    reason: 'no live terminal daemon is recorded under this data root'
  }
  if (!existsSync(daemonDir)) {
    return result
  }
  let unscoped = false
  let unknown = false
  const records = readdirSync(daemonDir).filter((name) => /^daemon-v\d+\.pid$/.test(name))
  for (const name of records) {
    let parsed: ReturnType<typeof parseDaemonPidFile> = null
    try {
      parsed = parseDaemonPidFile(readFileSync(join(daemonDir, name), 'utf8'))
    } catch {
      unknown = true
      continue
    }
    if (!parsed || !Number.isSafeInteger(parsed.pid) || parsed.pid <= 1) {
      // A torn record may still name a running daemon; it is not evidence of absence.
      unknown = true
      continue
    }
    const liveness = probe(parsed.pid)
    if (liveness === 'dead') {
      continue
    }
    if (liveness === 'unknown') {
      unknown = true
    }
    result.pids.push(parsed.pid)
    result.protocolVersions.push(Number(/^daemon-v(\d+)\.pid$/.exec(name)![1]))
    const version = daemonEntryInstallVersion(parsed.entryPath)
    if (version) {
      result.versions.push(version)
    }
    const unit =
      platform === 'linux'
        ? detectOwnCgroupScopeUnit('linux', join(procRoot, String(parsed.pid), 'cgroup'))
        : null
    if (unit) {
      result.cgroupUnits.push(unit)
    } else if (platform === 'linux') {
      unscoped = true
    } else {
      unknown = true
    }
  }
  if (unscoped) {
    return {
      ...result,
      state: 'unscoped',
      reason: 'a live terminal daemon shares the service cgroup, so stopping the unit would kill it'
    }
  }
  if (unknown) {
    return {
      ...result,
      state: 'unverifiable',
      reason: 'the terminal daemon cgroup could not be verified on this host'
    }
  }
  return result.pids.length > 0
    ? {
        ...result,
        state: 'isolated',
        reason: 'every live terminal daemon runs in its own systemd scope'
      }
    : result
}
