/**
 * orcad's `degradations[]`: every reason this host is serving less than it should, in one list a
 * supervisor, `orca serve status` and `/readyz` all read.
 *
 * `critical` means the host cannot do its job (readiness fails); `warning` means it serves, but
 * something an operator relies on — restart survival, a browser — is missing.
 */
import type { RuntimeDegradation } from '../../shared/runtime-types'
import type { TerminalDaemonHealth } from './orcad-health'
import type {
  OrcadDegradation,
  OrcadWatchdogSnapshot
} from '../../shared/orcad-server-health-contract'

export type {
  OrcadDegradation,
  OrcadDegradationComponent,
  OrcadDegradationSeverity
} from '../../shared/orcad-server-health-contract'

export type OrcadDegradationInputs = {
  terminalDaemon: TerminalDaemonHealth
  watchdog: OrcadWatchdogSnapshot | null
  runtimeDegradations: readonly RuntimeDegradation[]
  platform: NodeJS.Platform
  /** Whether a systemd service manages this process (`INVOCATION_ID` is set). */
  underSystemdService: boolean
}

function daemonDegradations(inputs: OrcadDegradationInputs): OrcadDegradation[] {
  const daemon = inputs.terminalDaemon
  if (daemon.state === 'absent') {
    return [
      {
        code: 'terminal_daemon_absent',
        severity: 'warning',
        component: 'terminal-daemon',
        message:
          'No terminal daemon is running, so terminals run inside orcad and end when it restarts.',
        reason: daemon.selfTest.verdict
      }
    ]
  }
  const found: OrcadDegradation[] = []
  if (!daemon.selfTest.ok) {
    found.push({
      code: 'terminal_daemon_unhealthy',
      severity: 'critical',
      component: 'terminal-daemon',
      // Why "unverifiable": a daemon that did not answer may still hold live sessions.
      message: `The terminal daemon failed its self-test (${daemon.selfTest.verdict}); new terminals may fail and its existing sessions are unverifiable.`,
      reason: daemon.selfTest.verdict
    })
  } else if (!daemon.ownsFreshSessions) {
    found.push({
      code: 'terminal_daemon_not_durable',
      severity: 'warning',
      component: 'terminal-daemon',
      message: 'New terminals are not daemon-owned, so they end when orcad restarts.'
    })
  }
  if (inputs.platform === 'linux' && inputs.underSystemdService && daemon.cgroupUnit === null) {
    found.push({
      code: 'terminal_daemon_unscoped',
      severity: 'warning',
      component: 'terminal-daemon',
      message:
        'The terminal daemon shares the service cgroup, so stopping or restarting the service unit kills every live terminal. Run `orca serve doctor` for the user-bus and linger fix.'
    })
  }
  return found
}

const WATCHDOG_PROBES = [
  {
    key: 'runtimeProbe',
    code: 'runtime_unresponsive',
    subject: 'runtime',
    describe: (failures: number) =>
      `The runtime did not answer ${failures} consecutive self-probes over its own socket.`
  },
  {
    key: 'threadpoolProbe',
    code: 'threadpool_stalled',
    subject: 'filesystem',
    describe: (failures: number) =>
      `Filesystem calls did not complete for ${failures} consecutive probes; a hung mount or saturated I/O pool stalls every repository and persistence call.`
  }
] as const

function watchdogDegradations(watchdog: OrcadWatchdogSnapshot | null): OrcadDegradation[] {
  if (!watchdog) {
    return []
  }
  const found: OrcadDegradation[] = []
  for (const { key, code, subject, describe } of WATCHDOG_PROBES) {
    const probe = watchdog[key]
    if (probe.consecutiveFailures < watchdog.wedgeAfterFailures) {
      continue
    }
    const reason = probe.lastError ? { reason: probe.lastError } : {}
    // Why split on a prior success: only a probe that used to answer proves the runtime stopped.
    found.push(
      probe.lastOkAt === null
        ? {
            code: 'watchdog_probe_unavailable',
            severity: 'warning',
            component: 'runtime',
            message: `The self-watchdog's ${subject} probe has never succeeded, so a wedge there cannot be detected.`,
            ...reason
          }
        : {
            code,
            severity: 'critical',
            component: 'runtime',
            message: describe(probe.consecutiveFailures),
            ...reason
          }
    )
  }
  if (watchdog.eventLoop.maxLagMs >= watchdog.eventLoop.warnMs) {
    found.push({
      code: 'event_loop_lagging',
      severity: 'warning',
      component: 'runtime',
      message: `The event loop stalled for up to ${Math.round(watchdog.eventLoop.maxLagMs)}ms in the last ${Math.round(watchdog.eventLoop.windowMs / 1000)}s, delaying every RPC.`
    })
  }
  return found
}

function runtimeStatusDegradations(
  degradations: readonly RuntimeDegradation[]
): OrcadDegradation[] {
  return degradations.map((degradation) => ({
    code: degradation.code,
    // Why only a PTY outage is critical: a host that cannot spawn one cannot run work, while
    // unenforced resource limits or a missing browser leave terminals working.
    severity: degradation.code === 'terminal_unavailable' ? 'critical' : 'warning',
    component: degradation.capability.startsWith('terminal.') ? 'terminal' : 'browser',
    message: degradation.message,
    ...(degradation.reason ? { reason: degradation.reason } : {})
  }))
}

export function deriveOrcadDegradations(inputs: OrcadDegradationInputs): OrcadDegradation[] {
  return [
    ...daemonDegradations(inputs),
    ...watchdogDegradations(inputs.watchdog),
    ...runtimeStatusDegradations(inputs.runtimeDegradations)
  ]
}

export function hasCriticalDegradation(degradations: readonly OrcadDegradation[]): boolean {
  return degradations.some((degradation) => degradation.severity === 'critical')
}
