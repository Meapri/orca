import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  setTerminalResourceLimitsShortfall,
  terminalResourceLimitsDegradation
} from '../daemon/daemon-scope-resource-limit-status'
import type { DurableDaemonScopeCommand } from '../daemon/daemon-cgroup-scope'
import { applyTerminalResourceLimitsToLiveDaemon } from './orcad-terminal-resource-limits'

const LIMITED_ENV = { ORCA_TERMINAL_MEMORY_MAX: '4G' }

afterEach(() => {
  setTerminalResourceLimitsShortfall(null)
  vi.restoreAllMocks()
})

describe('applyTerminalResourceLimitsToLiveDaemon', () => {
  it('does nothing when no limits are configured', async () => {
    const run = vi.fn()
    await expect(
      applyTerminalResourceLimitsToLiveDaemon({
        env: {},
        platform: 'linux',
        readCgroupUnit: () => 'orca-daemon-a.scope',
        run
      })
    ).resolves.toBe('none-configured')
    expect(run).not.toHaveBeenCalled()
    expect(terminalResourceLimitsDegradation()).toBeNull()
  })

  it('applies limits to the adopted daemon scope and clears a launch-time shortfall', async () => {
    setTerminalResourceLimitsShortfall({
      reason: 'scope_properties_rejected',
      limits: ['MemoryMax=4G']
    })
    const run = vi.fn(async (_command: DurableDaemonScopeCommand) => ({ code: 0, timedOut: false }))
    await expect(
      applyTerminalResourceLimitsToLiveDaemon({
        env: LIMITED_ENV,
        platform: 'linux',
        readCgroupUnit: () => 'orca-daemon-a.scope',
        run
      })
    ).resolves.toBe('applied')
    expect(run.mock.calls[0]?.[0]).toMatchObject({
      command: 'systemctl',
      args: ['--user', 'set-property', '--runtime', 'orca-daemon-a.scope', 'MemoryMax=4G']
    })
    expect(terminalResourceLimitsDegradation()).toBeNull()
  })

  it('reports a degradation when the daemon has no scope of its own', async () => {
    const run = vi.fn()
    await applyTerminalResourceLimitsToLiveDaemon({
      env: LIMITED_ENV,
      platform: 'linux',
      // A legacy desktop scope may hold GUI processes; it must never receive the limits.
      readCgroupUnit: () => 'app-orca-1234.scope',
      run
    })
    expect(run).not.toHaveBeenCalled()
    expect(terminalResourceLimitsDegradation()).toMatchObject({
      code: 'terminal_resource_limits_unavailable',
      reason: 'systemd_scope_unavailable'
    })
  })

  it('reports a failed set-property without throwing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(
      applyTerminalResourceLimitsToLiveDaemon({
        env: LIMITED_ENV,
        platform: 'linux',
        readCgroupUnit: () => 'orca-daemon-a.scope',
        run: async () => ({ code: 1, timedOut: false })
      })
    ).resolves.toBe('unavailable')
    expect(terminalResourceLimitsDegradation()).toMatchObject({ reason: 'set_property_failed' })
  })

  it('never probes a cgroup off Linux', async () => {
    const readCgroupUnit = vi.fn(() => 'orca-daemon-a.scope')
    await applyTerminalResourceLimitsToLiveDaemon({
      env: LIMITED_ENV,
      platform: 'darwin',
      readCgroupUnit
    })
    expect(readCgroupUnit).not.toHaveBeenCalled()
    expect(terminalResourceLimitsDegradation()?.reason).toBe('systemd_scope_unavailable')
  })
})
