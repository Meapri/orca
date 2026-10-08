import { describe, expect, it } from 'vitest'
import { deriveOrcadDegradations, hasCriticalDegradation } from './orcad-degradations'
import type { TerminalDaemonHealth } from './orcad-health'
import type { OrcadWatchdogSnapshot } from './orcad-runtime-watchdog'

function daemon(overrides: Partial<TerminalDaemonHealth> = {}): TerminalDaemonHealth {
  return {
    state: 'live',
    ownsFreshSessions: true,
    pid: 42,
    buildVersion: '1.0.0',
    entryPath: '/opt/orcad/daemon-entry.js',
    protocolVersion: 5,
    cgroupUnit: 'orca-daemon-abc.scope',
    selfTest: { ok: true, coverage: 'pty-spawn', verdict: 'healthy', durationMs: 12 },
    ...overrides
  }
}

function watchdog(overrides: Partial<OrcadWatchdogSnapshot> = {}): OrcadWatchdogSnapshot {
  const probe = {
    state: 'ok' as const,
    consecutiveFailures: 0,
    lastOkAt: 1,
    lastDurationMs: 2,
    lastError: null
  }
  return {
    verdict: 'responsive',
    eventLoop: { lagMs: 0, maxLagMs: 0, windowMs: 60_000, warnMs: 1_000 },
    runtimeProbe: probe,
    threadpoolProbe: probe,
    wedgeAfterFailures: 3,
    ...overrides
  }
}

const base = {
  runtimeDegradations: [],
  platform: 'linux' as const,
  underSystemdService: true
}

describe('deriveOrcadDegradations', () => {
  it('reports nothing for a live, scoped daemon and a responsive runtime', () => {
    const found = deriveOrcadDegradations({
      ...base,
      terminalDaemon: daemon(),
      watchdog: watchdog()
    })
    expect(found).toEqual([])
    expect(hasCriticalDegradation(found)).toBe(false)
  })

  it('makes a failed daemon self-test critical without calling its sessions exited', () => {
    const found = deriveOrcadDegradations({
      ...base,
      terminalDaemon: daemon({
        state: 'degraded',
        selfTest: { ok: false, coverage: 'pty-spawn', verdict: 'unreachable', durationMs: 5_000 }
      }),
      watchdog: null
    })
    expect(found).toMatchObject([
      { code: 'terminal_daemon_unhealthy', severity: 'critical', reason: 'unreachable' }
    ])
    expect(found[0].message).toContain('unverifiable')
    expect(found[0].message).not.toContain('exited')
  })

  it('warns, but stays ready, when the daemon is absent', () => {
    const found = deriveOrcadDegradations({
      ...base,
      terminalDaemon: daemon({
        state: 'absent',
        ownsFreshSessions: false,
        cgroupUnit: null,
        selfTest: { ok: false, coverage: 'pty-spawn', verdict: 'no-daemon', durationMs: 0 }
      }),
      watchdog: null
    })
    expect(found.map((entry) => entry.code)).toEqual(['terminal_daemon_absent'])
    expect(hasCriticalDegradation(found)).toBe(false)
  })

  it('flags an unscoped daemon only under a systemd service on Linux', () => {
    const unscoped = daemon({ cgroupUnit: null })
    expect(
      deriveOrcadDegradations({ ...base, terminalDaemon: unscoped, watchdog: null }).map(
        (entry) => entry.code
      )
    ).toEqual(['terminal_daemon_unscoped'])
    expect(
      deriveOrcadDegradations({
        ...base,
        underSystemdService: false,
        terminalDaemon: unscoped,
        watchdog: null
      })
    ).toEqual([])
    expect(
      deriveOrcadDegradations({
        ...base,
        platform: 'darwin',
        terminalDaemon: unscoped,
        watchdog: null
      })
    ).toEqual([])
  })

  it('turns a wedged runtime probe into a critical degradation and lag into a warning', () => {
    const found = deriveOrcadDegradations({
      ...base,
      terminalDaemon: daemon(),
      watchdog: watchdog({
        verdict: 'wedged',
        eventLoop: { lagMs: 10, maxLagMs: 4_000, windowMs: 60_000, warnMs: 1_000 },
        runtimeProbe: {
          state: 'failing',
          consecutiveFailures: 3,
          lastOkAt: 1,
          lastDurationMs: 5_000,
          lastError: 'runtime self-probe timeout'
        }
      })
    })
    expect(found.map((entry) => [entry.code, entry.severity])).toEqual([
      ['runtime_unresponsive', 'critical'],
      ['event_loop_lagging', 'warning']
    ])
  })

  it('reports a probe that never succeeded as unavailable, not as a critical wedge', () => {
    const found = deriveOrcadDegradations({
      ...base,
      terminalDaemon: daemon(),
      watchdog: watchdog({
        threadpoolProbe: {
          state: 'failing',
          consecutiveFailures: 5,
          lastOkAt: null,
          lastDurationMs: 5_000,
          lastError: 'probe exceeded 5000ms'
        }
      })
    })
    expect(found.map((entry) => [entry.code, entry.severity])).toEqual([
      ['watchdog_probe_unavailable', 'warning']
    ])
    expect(hasCriticalDegradation(found)).toBe(false)
  })

  it('maps runtime status degradations, making only terminal loss critical', () => {
    const found = deriveOrcadDegradations({
      ...base,
      terminalDaemon: daemon(),
      watchdog: null,
      runtimeDegradations: [
        {
          code: 'browser_unavailable',
          capability: 'browser.headless.v1',
          message: 'no browser',
          reason: 'unconfigured'
        },
        {
          code: 'browser_unavailable',
          capability: 'browser.headless.v1',
          message: 'browser stopped answering',
          reason: 'provider_unhealthy'
        },
        {
          code: 'terminal_unavailable',
          capability: 'terminal.pty.v1',
          message: 'no pty',
          reason: 'abi_mismatch'
        },
        {
          code: 'terminal_resource_limits_unavailable',
          capability: 'terminal.resource-limits.v1',
          message: 'limits not enforced',
          reason: 'systemd_scope_unavailable'
        }
      ]
    })
    expect(
      found.map((entry) => [entry.code, entry.severity, entry.component, entry.reason])
    ).toEqual([
      ['browser_unavailable', 'warning', 'browser', 'unconfigured'],
      ['browser_unavailable', 'warning', 'browser', 'provider_unhealthy'],
      ['terminal_unavailable', 'critical', 'terminal', 'abi_mismatch'],
      ['terminal_resource_limits_unavailable', 'warning', 'terminal', 'systemd_scope_unavailable']
    ])
  })
})
