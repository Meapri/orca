import { describe, expect, it, vi } from 'vitest'
import {
  isPinnedPortConfigurationError,
  listenOnPlannedPorts,
  planWebSocketListenPorts,
  WebSocketPinnedPortUnavailableError
} from './ws-transport-port-binding'

function listenError(code: string): Error {
  return Object.assign(new Error(`listen ${code}`), { code, syscall: 'listen' })
}

describe('planWebSocketListenPorts', () => {
  it('pins exactly one port with no fallback when the pin is required', () => {
    expect(
      planWebSocketListenPorts({
        port: 6768,
        fallbackPort: 7000,
        preferPinnedPort: true,
        requirePinnedPort: true
      })
    ).toEqual({ candidates: [6768], persistedFallbackPort: undefined, allowOsAssignedPort: false })
  })

  it('keeps the persisted fallback ahead of the configured port by default', () => {
    expect(
      planWebSocketListenPorts({
        port: 6768,
        fallbackPort: 7000,
        preferPinnedPort: false,
        requirePinnedPort: false
      })
    ).toEqual({ candidates: [7000, 6768], persistedFallbackPort: 7000, allowOsAssignedPort: true })
  })
})

describe('listenOnPlannedPorts', () => {
  const pinnedPlan = planWebSocketListenPorts({
    port: 6768,
    preferPinnedPort: true,
    requirePinnedPort: true
  })

  it('fails closed with a configuration error when a required pin is occupied', async () => {
    const tryListen = vi.fn().mockRejectedValue(listenError('EADDRINUSE'))

    const attempt = listenOnPlannedPorts(pinnedPlan, { host: '127.0.0.1', port: 6768 }, tryListen)

    await expect(attempt).rejects.toBeInstanceOf(WebSocketPinnedPortUnavailableError)
    expect(tryListen).toHaveBeenCalledTimes(1)
    expect(tryListen).toHaveBeenCalledWith(6768)
  })

  it('passes a non-configuration listen failure through unchanged', async () => {
    const failure = listenError('EMFILE')
    const tryListen = vi.fn().mockRejectedValue(failure)

    await expect(
      listenOnPlannedPorts(pinnedPlan, { host: '127.0.0.1', port: 6768 }, tryListen)
    ).rejects.toBe(failure)
  })

  it('falls back to an OS-assigned port when the pin is only preferred', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const tryListen = vi.fn(async (port: number) => {
      if (port !== 0) {
        throw listenError('EADDRINUSE')
      }
    })
    const plan = planWebSocketListenPorts({
      port: 6768,
      preferPinnedPort: true,
      requirePinnedPort: false
    })

    await listenOnPlannedPorts(plan, { host: '127.0.0.1', port: 6768 }, tryListen)

    expect(tryListen.mock.calls.map(([port]) => port)).toEqual([6768, 0])
    warn.mockRestore()
  })
})

describe('isPinnedPortConfigurationError', () => {
  it('treats occupied, denied and foreign-address listens as configuration faults', () => {
    for (const code of ['EADDRINUSE', 'EACCES', 'EADDRNOTAVAIL']) {
      expect(isPinnedPortConfigurationError(listenError(code))).toBe(true)
    }
  })

  it('does not treat resource exhaustion as a configuration fault', () => {
    expect(isPinnedPortConfigurationError(listenError('EMFILE'))).toBe(false)
    expect(isPinnedPortConfigurationError(new Error('no code'))).toBe(false)
  })
})
