/**
 * The two things a supervisor reads off a launch: what the arguments mean, and what an exit
 * code means. Both are part of the ops contract in docs/reference/orcad-operations.md.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  ORCAD_EXIT_CONFIGURATION,
  ORCAD_EXIT_FAILED,
  parseArgs,
  resolveOrcadExitCode
} from './orcad-entry'
import { startOrcadWithLifecycle } from './orcad-lifecycle'
import { OrcadBindAddressError } from './orcad-bind-address'
import { OrcadInstanceLockError } from './orcad-instance-lock'
import { ProfileStateAccessError } from '../persistence/profile-state/profile-state-access'
import { OrcadBundledRuntimeError } from './orcad-bundled-runtime'

describe('parseArgs', () => {
  it('accepts --bind and leaves it unset when absent', () => {
    expect(parseArgs(['--bind', '0.0.0.0'])).toEqual({ bind: '0.0.0.0' })
    expect(parseArgs([])).toEqual({})
    expect(parseArgs(['--port', '6768', '--bind', '10.0.0.5', '--json'])).toEqual({
      port: 6768,
      bind: '10.0.0.5',
      json: true
    })
  })

  it('rejects --bind with no value rather than silently binding the default', () => {
    expect(() => parseArgs(['--bind'])).toThrow('--bind expects a value')
    expect(() => parseArgs(['--bind', '--json'])).not.toThrow()
  })

  it('maps repeatable --limit flags onto the resource-governance env vars', () => {
    expect(
      parseArgs(['--limit', 'terminal-memory-max=4G', '--limit', 'browser-max-tabs=4'])
    ).toEqual({
      resourceLimits: { ORCA_TERMINAL_MEMORY_MAX: '4G', ORCA_BROWSER_MAX_TABS: '4' }
    })
  })

  it('refuses an unknown or empty --limit instead of ignoring it', () => {
    expect(() => parseArgs(['--limit', 'memory=4G'])).toThrow('--limit expects <key>=<value>')
    expect(() => parseArgs(['--limit', 'terminal-memory-max='])).toThrow('--limit expects')
    expect(() => parseArgs(['--limit'])).toThrow('--limit expects')
    expect(() => parseArgs(['--limit', 'toString=1'])).toThrow('--limit expects')
  })

  it('accepts every orcad flag together: limits, lifetime, repeated addresses, pinned port', () => {
    expect(
      parseArgs([
        '--port',
        '6768',
        '--bind',
        '0.0.0.0',
        '--limit',
        'terminal-memory-high=3G',
        '--pairing-expires',
        '1h',
        '--pairing-address',
        '100.64.1.20',
        '--pairing-address',
        'wss://orca.example.com',
        '--mobile-pairing',
        '--json'
      ])
    ).toEqual({
      port: 6768,
      bind: '0.0.0.0',
      resourceLimits: { ORCA_TERMINAL_MEMORY_HIGH: '3G' },
      pairingExpiresInMs: 3_600_000,
      pairingAddress: '100.64.1.20',
      pairingAddresses: ['100.64.1.20', 'wss://orca.example.com'],
      mobilePairing: true,
      json: true
    })
  })

  it('parses --pairing-expires and refuses a lifetime outside the supported window', () => {
    expect(parseArgs(['--pairing-expires', '2h'])).toEqual({ pairingExpiresInMs: 7_200_000 })
    expect(() => parseArgs(['--pairing-expires'])).toThrow('--pairing-expires')
    expect(() => parseArgs(['--pairing-expires', '10s'])).toThrow('at least 1 minute')
    expect(() => parseArgs(['--pairing-expires', 'never'])).toThrow('Invalid pairing lifetime')
  })
})

describe('resolveOrcadExitCode', () => {
  it('separates a configuration fault from a generic failure', () => {
    // A supervisor must be able to stop restarting on faults that restarting cannot fix:
    // a data root owned by someone else, held by another instance, or a bad bind address.
    expect(
      resolveOrcadExitCode(new OrcadInstanceLockError('orcad_instance_lock_held', 'held'))
    ).toBe(ORCAD_EXIT_CONFIGURATION)
    expect(resolveOrcadExitCode(new OrcadBindAddressError('bad'))).toBe(ORCAD_EXIT_CONFIGURATION)
    expect(resolveOrcadExitCode(new ProfileStateAccessError('recovery interrupted'))).toBe(
      ORCAD_EXIT_CONFIGURATION
    )
    expect(resolveOrcadExitCode(new Error('port in use'))).toBe(ORCAD_EXIT_FAILED)
    expect(resolveOrcadExitCode(new OrcadBundledRuntimeError('partial installation'))).toBe(
      ORCAD_EXIT_CONFIGURATION
    )
    expect(ORCAD_EXIT_CONFIGURATION).not.toBe(ORCAD_EXIT_FAILED)
  })
})

describe('orcad lifecycle cleanup', () => {
  it('uninstalls registered runtime resources when startup fails', async () => {
    const cleanupRuntime = vi.fn(async () => {})
    const cleanupHost = vi.fn(async () => {})

    await expect(
      startOrcadWithLifecycle(async (registerCleanup) => {
        registerCleanup(cleanupRuntime)
        await Promise.resolve()
        throw new Error('startup failed')
      }, cleanupHost)
    ).rejects.toThrow('startup failed')

    expect(cleanupRuntime).toHaveBeenCalledOnce()
    expect(cleanupHost).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('preserves the startup error when rollback also fails', async () => {
    const startupError = new Error('bind failed')
    const cleanupError = new Error('daemon stop failed')
    const cleanupRuntime = vi.fn(async () => {})
    const cleanupHost = vi.fn(async () => {
      throw cleanupError
    })
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      await expect(
        startOrcadWithLifecycle(async (registerCleanup) => {
          registerCleanup(cleanupRuntime)
          throw startupError
        }, cleanupHost)
      ).rejects.toBe(startupError)
      expect(report).toHaveBeenCalledWith('[orcad] startup cleanup failed:', cleanupError)
    } finally {
      report.mockRestore()
    }
  })

  it('coalesces concurrent and repeated normal stops', async () => {
    const cleanupRuntime = vi.fn(async () => {})
    const cleanupHost = vi.fn(async () => {})
    const handle = await startOrcadWithLifecycle(async (registerCleanup) => {
      registerCleanup(cleanupRuntime)
      return { readiness: 'ready' }
    }, cleanupHost)

    await Promise.all([handle.stop(), handle.stop()])
    await handle.stop()

    expect(cleanupRuntime).toHaveBeenCalledOnce()
    expect(cleanupHost).toHaveBeenCalledOnce()
  })

  it('keeps the host aware of failed runtime teardown so it cannot release profile admission', async () => {
    const failure = new Error('profile writer still running')
    const cleanupHost = vi.fn(async () => {})
    const handle = await startOrcadWithLifecycle(async (registerCleanup) => {
      registerCleanup(async () => {
        throw failure
      })
      return {}
    }, cleanupHost)
    await expect(handle.stop()).rejects.toBe(failure)
    expect(cleanupHost).toHaveBeenCalledExactlyOnceWith(false)
  })
})
