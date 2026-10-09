/**
 * orcad's health surface: the facts a supervisor needs to decide whether this deployment
 * is actually serving, as opposed to merely listening.
 *
 * The load-bearing one is the terminal-daemon verdict. orcad answers RPC from its own
 * process, so "the port is open" stays true while the daemon that owns every terminal is
 * dead — a green host that cannot run a single command. The self-test below therefore has
 * to cross the process boundary: orcad drives it, the daemon performs it, and the verdict
 * travels back over the daemon's socket.
 */
import { hashOrcadLauncher } from '../../shared/orcad-build-identity'
import process from 'node:process'
import { checkDaemonHealthWithCoverage } from '../daemon/daemon-health'
import { ptySpawnHealthPlatformCoverage } from '../daemon/daemon-health-identity'
import {
  daemonOwnsFreshPersistentPtys,
  getDaemonEndpointFacts,
  readDaemonPidRecord
} from '../daemon/daemon-init'
import type { OrcadProfileStateAuthoritySelection } from './orcad-profile-state-telemetry'
import { ORCAD_STOP_REQUESTS_CAPABILITY } from '../../shared/orcad-stop-request'
import type { OrcadIdleStopRecord } from '../../shared/orcad-idle-exit'
import type {
  OrcadHealthReport,
  OrcadPtySelfTest,
  OrcadPtySelfTestCoverage,
  OrcadTerminalDaemonHealth
} from '../../shared/orcad-server-health-contract'

export type PtySelfTestCoverage = OrcadPtySelfTestCoverage
export type PtySelfTest = OrcadPtySelfTest
export type TerminalDaemonHealth = OrcadTerminalDaemonHealth
export type OrcadHealth = OrcadHealthReport

/**
 * Launcher identity shared with clients that predate split server bundles.
 *
 * Why hash the entry and not read a version string: `ORCA_VERSION` is whatever the deploy
 * exported, so two different builds can carry one version. A rollback that did not actually
 * replace the file is precisely what this has to catch.
 */
export function computeOrcadBuildHash(entryPath = process.argv[1]): string {
  if (!entryPath) {
    return 'unknown'
  }
  try {
    return hashOrcadLauncher(entryPath)
  } catch {
    return 'unknown'
  }
}

/**
 * Probe the daemon across the process boundary.
 *
 * `checkDaemonHealth` is the cross-process test: it opens the daemon's socket, completes the
 * protocol handshake, and asks the daemon to run `ptySpawnHealth` — a real short-lived PTY
 * spawned inside the daemon. Only a daemon that is alive AND can create terminals answers
 * `healthy`; a wedged one times out to `unreachable`, and one whose node-pty or login session
 * is broken answers `pty-spawn-unhealthy`.
 */
export async function runTerminalDaemonSelfTest(
  now: () => number = () => Date.now()
): Promise<PtySelfTest> {
  const startedAt = now()
  const facts = getDaemonEndpointFacts()
  if (!facts) {
    return {
      ok: false,
      coverage: ptySpawnHealthPlatformCoverage(),
      verdict: 'no-daemon',
      durationMs: now() - startedAt
    }
  }
  // The daemon reports what its probe actually did; an older daemon falls back by platform.
  const { verdict, coverage } = await checkDaemonHealthWithCoverage(
    facts.socketPath,
    facts.tokenPath
  )
  return { ok: verdict === 'healthy', coverage, verdict, durationMs: now() - startedAt }
}

export async function collectTerminalDaemonHealth(): Promise<TerminalDaemonHealth> {
  const facts = getDaemonEndpointFacts()
  const selfTest = await runTerminalDaemonSelfTest()
  if (!facts) {
    return {
      state: 'absent',
      ownsFreshSessions: false,
      pid: null,
      buildVersion: null,
      entryPath: null,
      protocolVersion: null,
      cgroupUnit: null,
      selfTest
    }
  }
  const record = readDaemonPidRecord()
  const ownsFreshSessions = daemonOwnsFreshPersistentPtys()
  return {
    // Why `degraded` and not `absent` on a failed self-test: a daemon that answered its
    // handshake but failed the spawn probe is still holding live sessions. Reporting it gone
    // would invite a caller to treat those terminals as exited, which is the one verdict the
    // execution-boundary vocabulary forbids guessing.
    state:
      selfTest.ok && ownsFreshSessions
        ? 'live'
        : selfTest.verdict === 'no-daemon'
          ? 'absent'
          : 'degraded',
    ownsFreshSessions,
    pid: record?.pid ?? null,
    buildVersion: record?.appVersion ?? null,
    entryPath: record?.entryPath ?? null,
    protocolVersion: facts.protocolVersion,
    cgroupUnit: record?.cgroupUnit ?? null,
    selfTest
  }
}

export async function collectOrcadHealth(
  buildVersion: string,
  profileStateAuthority?: OrcadProfileStateAuthoritySelection,
  previousIdleStop?: OrcadIdleStopRecord | null
): Promise<OrcadHealth> {
  return {
    buildHash: computeOrcadBuildHash(),
    buildVersion,
    nodeVersion: process.versions.node,
    nodeAbi: process.versions.modules ?? 'unknown',
    platform: process.platform,
    arch: process.arch,
    pid: process.pid,
    terminalDaemon: await collectTerminalDaemonHealth(),
    ...(profileStateAuthority ? { profileStateAuthority } : {}),
    stopRequests: ORCAD_STOP_REQUESTS_CAPABILITY,
    ...(previousIdleStop !== undefined ? { previousIdleStop } : {})
  }
}
