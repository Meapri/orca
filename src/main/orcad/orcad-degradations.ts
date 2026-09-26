/**
 * orcad's `degradations[]`: every reason this host is serving less than it should, in one list a
 * supervisor, `orca serve status` and `/readyz` all read.
 *
 * `critical` means the host cannot do its job (readiness fails); `warning` means it serves, but
 * something an operator relies on — restart survival, a browser — is missing.
 */
import type { RuntimeDegradation } from '../../shared/runtime-types'
import type { TerminalDaemonHealth } from './orcad-health'
import type { OrcadWatchdogSnapshot } from './orcad-runtime-watchdog'

export type OrcadDegradationSeverity = 'critical' | 'warning'

export type OrcadDegradationComponent = 'terminal-daemon' | 'runtime' | 'terminal' | 'browser'

export type OrcadDegradation = {
  /** Open vocabulary: new codes ship without a schema bump, so render `message`. */
  code: string
  severity: OrcadDegradationSeverity
  component: OrcadDegradationComponent
  message: string
  /** The underlying reason word when one exists (daemon verdict, runtime reason). */
  reason?: string
}

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

function watchdogDegradations(watchdog: OrcadWatchdogSnapshot | null): OrcadDegradation[] {
  if (!watchdog) {
    return []
  }
  const found: OrcadDegradation[] = []
  if (watchdog.verdict === 'wedged' && watchdog.runtimeProbe.state === 'failing') {
    found.push({
      code: 'runtime_unresponsive',
      severity: 'critical',
      component: 'runtime',
      message: `The runtime did not answer ${watchdog.runtimeProbe.consecutiveFailures} consecutive self-probes over its own socket.`,
      ...(watchdog.runtimeProbe.lastError ? { reason: watchdog.runtimeProbe.lastError } : {})
    })
  }
  if (watchdog.verdict === 'wedged' && watchdog.threadpoolProbe.state === 'failing') {
    found.push({
      code: 'threadpool_stalled',
      severity: 'critical',
      component: 'runtime',
      message: `Filesystem calls did not complete for ${watchdog.threadpoolProbe.consecutiveFailures} consecutive probes; a hung mount or saturated I/O pool stalls git and persistence.`,
      ...(watchdog.threadpoolProbe.lastError ? { reason: watchdog.threadpoolProbe.lastError } : {})
    })
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
    // Why terminals are critical and browsers not: a host that cannot spawn a PTY cannot run work.
    severity: degradation.code === 'terminal_unavailable' ? 'critical' : 'warning',
    component: degradation.code === 'terminal_unavailable' ? 'terminal' : 'browser',
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
