import { describe, expect, it } from 'vitest'
import {
  buildDaemonScopeSetPropertyCommand,
  buildDurableDaemonScopeCommand
} from './daemon-cgroup-scope'
import {
  daemonScopePropertyArgs,
  resolveDaemonScopeResourceLimits
} from './daemon-scope-resource-limits'

describe('resolveDaemonScopeResourceLimits', () => {
  it('is empty by default', () => {
    expect(resolveDaemonScopeResourceLimits({})).toEqual({ limits: [], warnings: [] })
  })

  it('accepts systemd-shaped values', () => {
    const { limits, warnings } = resolveDaemonScopeResourceLimits({
      ORCA_TERMINAL_MEMORY_HIGH: '3G',
      ORCA_TERMINAL_MEMORY_MAX: '80%',
      ORCA_TERMINAL_TASKS_MAX: '4096',
      ORCA_TERMINAL_CPU_WEIGHT: '50'
    })
    expect(limits).toEqual(['MemoryHigh=3G', 'MemoryMax=80%', 'TasksMax=4096', 'CPUWeight=50'])
    expect(warnings).toEqual([])
  })

  it('drops values systemd would reject, with a warning, instead of risking the scope', () => {
    const { limits, warnings } = resolveDaemonScopeResourceLimits({
      ORCA_TERMINAL_MEMORY_MAX: '4 gigs',
      ORCA_TERMINAL_CPU_WEIGHT: '0',
      ORCA_TERMINAL_TASKS_MAX: '10;rm -rf'
    })
    expect(limits).toEqual([])
    expect(warnings).toHaveLength(3)
  })
})

describe('daemon scope commands', () => {
  it('adds OOMPolicy=continue and the limits to the systemd-run scope', () => {
    const command = buildDurableDaemonScopeCommand(
      '/usr/bin/node',
      ['/app/daemon-entry.js'],
      'nonce',
      {},
      null,
      daemonScopePropertyArgs(['MemoryMax=4G'])
    )
    const separator = command.args.indexOf('--')
    expect(command.args.slice(0, separator)).toEqual(
      expect.arrayContaining(['--property=OOMPolicy=continue', '--property=MemoryMax=4G'])
    )
    // Properties must precede the command, never leak into the daemon's own argv.
    expect(command.args.slice(separator)).not.toContain('--property=MemoryMax=4G')
  })

  it('keeps the bare scope unchanged when no properties are given', () => {
    const command = buildDurableDaemonScopeCommand('/usr/bin/node', ['/a.js'], 'n', {}, null)
    expect(command.args.filter((arg) => arg.startsWith('--property='))).toEqual([
      '--property=TimeoutStopSec=5s'
    ])
  })

  it('applies runtime-only limits to a live scope over the user bus', () => {
    const command = buildDaemonScopeSetPropertyCommand(
      'orca-daemon-abc.scope',
      ['MemoryMax=4G'],
      { DBUS_SESSION_BUS_ADDRESS: 'disabled:' },
      null
    )
    expect(command.command).toBe('systemctl')
    expect(command.args).toEqual([
      '--user',
      'set-property',
      '--runtime',
      'orca-daemon-abc.scope',
      'MemoryMax=4G'
    ])
    expect(command.env.DBUS_SESSION_BUS_ADDRESS).toBeUndefined()
  })
})
