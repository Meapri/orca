import { describe, expect, it, vi } from 'vitest'
import type { OrcadHealth, TerminalDaemonHealth } from './orcad-health'
import { OrcadHealthMonitor } from './orcad-health-monitor'

function health(terminalDaemon: Partial<TerminalDaemonHealth> = {}): OrcadHealth {
  return {
    buildHash: 'abc',
    buildVersion: '1.0.0',
    nodeVersion: '24.0.0',
    nodeAbi: '137',
    platform: 'linux',
    arch: 'x64',
    pid: 1,
    terminalDaemon: {
      state: 'live',
      ownsFreshSessions: true,
      pid: 2,
      buildVersion: '1.0.0',
      entryPath: '/d.js',
      protocolVersion: 5,
      cgroupUnit: 'orca-daemon-x.scope',
      selfTest: { ok: true, coverage: 'pty-spawn', verdict: 'healthy', durationMs: 1 },
      ...terminalDaemon
    }
  }
}

function monitorFor(collectBase: () => Promise<OrcadHealth>) {
  return new OrcadHealthMonitor({
    collectBase,
    runtimeDegradations: () => [],
    collectStats: async () => ({ connectedClients: 1, pairedDevices: 1, localTerminals: null }),
    watchdog: null,
    platform: 'linux',
    underSystemdService: true
  })
}

describe('OrcadHealthMonitor', () => {
  it('is not ready while a critical degradation stands', async () => {
    const monitor = monitorFor(async () =>
      health({
        state: 'degraded',
        selfTest: {
          ok: false,
          coverage: 'pty-spawn',
          verdict: 'pty-spawn-unhealthy',
          durationMs: 3
        }
      })
    )
    await monitor.collectInitial()
    monitor.start()

    expect(monitor.readiness().state).toBe('not_ready')
    expect(monitor.liveness().live).toBe(true)
    monitor.stop()
  })

  it('is ready with only warnings, and reports unverifiable terminal counts as null', async () => {
    const monitor = monitorFor(async () => health({ cgroupUnit: null }))
    await monitor.collectInitial()
    monitor.start()

    expect(monitor.readiness()).toMatchObject({
      state: 'ready',
      degradations: [{ code: 'terminal_daemon_unscoped', severity: 'warning' }]
    })
    const snapshot = await monitor.serverHealth({ fresh: false })
    expect(snapshot.stats.localTerminals).toBeNull()
    expect(snapshot.health.degradations?.[0]?.code).toBe('terminal_daemon_unscoped')
    monitor.stop()
  })

  it('shares one daemon self-test between concurrent fresh requests', async () => {
    const collectBase = vi.fn(async () => health())
    const monitor = monitorFor(collectBase)

    await Promise.all([
      monitor.serverHealth({ fresh: true }),
      monitor.serverHealth({ fresh: true })
    ])

    expect(collectBase).toHaveBeenCalledOnce()
  })
})
