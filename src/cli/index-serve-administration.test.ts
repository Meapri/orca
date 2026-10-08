import { describe, expect, it, vi } from 'vitest'

const {
  callMock,
  runtimeClientConstructorMock,
  serveOrcaAppMock,
  getDefaultUserDataPathMock,
  addEnvironmentFromPairingCodeMock,
  listEnvironmentsMock,
  spawnMock
} = vi.hoisted(() => ({
  callMock: vi.fn(),
  runtimeClientConstructorMock: vi.fn(),
  serveOrcaAppMock: vi.fn(),
  getDefaultUserDataPathMock: vi.fn(() => '/tmp/orca-user-data'),
  addEnvironmentFromPairingCodeMock: vi.fn(),
  listEnvironmentsMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('./runtime-client', async () => {
  const { createRuntimeClientModuleMock } = await import('./index-test-harness.js')
  return createRuntimeClientModuleMock({
    callMock,
    runtimeClientConstructorMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock
  })
})

vi.mock('./runtime/environments', () => ({
  addEnvironmentFromPairingCode: addEnvironmentFromPairingCodeMock,
  listEnvironments: listEnvironmentsMock,
  removeEnvironment: vi.fn(),
  resolveEnvironment: vi.fn()
}))

vi.mock('child_process', async () => {
  const { createChildProcessModuleMock } = await import('./index-test-harness.js')
  return createChildProcessModuleMock(spawnMock)
})

import { main } from './index'
import { useWorktreeAwarenessEnvironment } from './index-test-harness'
import { okFixture, queueFixtures } from './test-fixtures'
import { RuntimeRpcFailureError } from './runtime/types'

const OFFER = {
  available: true,
  deviceId: 'device-1',
  scope: 'runtime',
  pairingUrl: 'orca://pair?code=secret',
  endpoint: 'ws://100.64.1.20:6768',
  webClientUrl: null,
  offerExpiresAt: Date.UTC(2026, 0, 1, 0, 15),
  serverKeyFingerprint: 'sha256:abc'
}

describe('orca serve devices / pairing', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  it('mints a runtime offer on the local runtime, never a paired one', async () => {
    queueFixtures(callMock, okFixture('req', OFFER))
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    process.env.ORCA_ENVIRONMENT = 'stale-env'

    await main(
      ['serve', 'pairing', 'new', '--pairing-address', '100.64.1.20', '--expires', '1h'],
      '/tmp'
    )

    expect(serveOrcaAppMock).not.toHaveBeenCalled()
    expect(runtimeClientConstructorMock).toHaveBeenLastCalledWith(null, null)
    expect(callMock).toHaveBeenCalledWith('pairing.create', {
      scope: 'runtime',
      address: '100.64.1.20',
      name: undefined,
      expiresInMs: 3_600_000
    })
    expect(log.mock.calls.flat().join('\n')).toContain('Expires: 2026-01-01T00:15:00.000Z')
    delete process.env.ORCA_ENVIRONMENT
  })

  it('mints a mobile offer with --mobile', async () => {
    queueFixtures(callMock, okFixture('req', { ...OFFER, scope: 'mobile' }))
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['serve', 'pairing', 'new', '--mobile', '--pairing-address', '10.0.0.2', '--json'])

    expect(callMock).toHaveBeenCalledWith(
      'pairing.create',
      expect.objectContaining({ scope: 'mobile', address: '10.0.0.2' })
    )
  })

  it.each([
    [['serve', 'pairing', 'new', '--mobile', '--runtime'], 'not both'],
    [['serve', 'pairing', 'new', '--expires', '10s'], 'at least 1 minute'],
    [['serve', 'pairing', 'new', '--environment', 'work'], 'does not retarget']
  ])('refuses %j before contacting the runtime', async (argv, message) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(argv)

    expect(callMock).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
    expect(error.mock.calls.flat().join('\n')).toContain(message)
    process.exitCode = 0
  })

  it('exits non-zero when the runtime refuses to mint', async () => {
    queueFixtures(
      callMock,
      okFixture('req', {
        available: false,
        reason: 'invalid_advertised_endpoint',
        guidance: 'Pass --pairing-address.'
      })
    )
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(['serve', 'pairing', 'new', '--mobile'])

    expect(process.exitCode).toBe(1)
    expect(error.mock.calls.flat().join('\n')).toContain('Pass --pairing-address.')
    process.exitCode = 0
  })

  it('revokes by positional id and fails when nothing matched', async () => {
    queueFixtures(
      callMock,
      okFixture('req', { revoked: false, deviceId: 'missing', closedConnections: 0 })
    )
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['serve', 'devices', 'revoke', 'missing'])

    expect(callMock).toHaveBeenCalledWith('devices.revoke', { deviceId: 'missing' })
    expect(process.exitCode).toBe(1)
    expect(log.mock.calls.flat().join('\n')).toContain('No device missing')
    process.exitCode = 0
  })

  it('lists devices without credentials', async () => {
    queueFixtures(
      callMock,
      okFixture('req', {
        serverKeyFingerprint: 'sha256:abc',
        devices: [
          {
            deviceId: 'device-1',
            name: 'CLI',
            scope: 'runtime',
            state: 'pending',
            pairedAt: 1,
            lastSeenAt: null,
            offerExpiresAt: null,
            connections: 0
          }
        ]
      })
    )
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['serve', 'devices', 'list'])

    expect(callMock).toHaveBeenCalledWith('devices.list', undefined)
    const output = log.mock.calls.flat().join('\n')
    expect(output).toContain('device-1')
    expect(output).toContain('pending, expires never')
  })

  it('explains an older runtime that has no administration methods', async () => {
    callMock.mockRejectedValueOnce(
      new RuntimeRpcFailureError({
        id: 'req',
        ok: false,
        error: { code: 'method_not_found', message: 'Unknown method: devices.list' },
        _meta: { runtimeId: 'runtime-1' }
      })
    )
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(['serve', 'devices', 'list'])

    expect(process.exitCode).toBe(1)
    expect(error.mock.calls.flat().join('\n')).toContain('does not support device administration')
    process.exitCode = 0
  })
})
