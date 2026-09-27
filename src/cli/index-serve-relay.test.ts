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

const REPORT = {
  enabled: true,
  configured: true,
  account: { state: 'connected', persistence: 'host-unsealed', email: 'ops@example.test' },
  relay: { status: 'registered', cellUrl: 'https://cell.example.test' }
}

describe('orca serve relay', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  it('reports the account and relay connection of the local orcad', async () => {
    queueFixtures(callMock, okFixture('req', REPORT))
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['serve', 'relay', 'status'])

    expect(runtimeClientConstructorMock).toHaveBeenLastCalledWith(null, null)
    expect(callMock).toHaveBeenCalledWith('server.relay.status', undefined)
    const output = log.mock.calls.flat().join('\n')
    expect(output).toContain('signed in as ops@example.test')
    expect(output).toContain('owner-only file in the data root')
    expect(output).toContain('registered (https://cell.example.test)')
  })

  it('prints the sign-in URL and the SSH forward, then waits for the outcome', async () => {
    queueFixtures(
      callMock,
      okFixture('req', {
        started: true,
        authorizeUrl: 'https://login.example.test/authorize?x=1',
        callbackPort: 53111
      }),
      okFixture('req', { ...REPORT, lastSignIn: { outcome: 'connected' } })
    )
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['serve', 'relay', 'sign-in'])

    const output = log.mock.calls.flat().join('\n')
    expect(output).toContain('https://login.example.test/authorize?x=1')
    expect(output).toContain('ssh -N -L 53111:127.0.0.1:53111')
    expect(process.exitCode ?? 0).toBe(0)
  })

  it('explains an orcad that predates relay administration (mixed versions)', async () => {
    callMock.mockRejectedValueOnce(
      new RuntimeRpcFailureError({
        id: 'req',
        ok: false,
        error: { code: 'method_not_found', message: 'Unknown method: server.relay.status' },
        _meta: { runtimeId: 'runtime-1' }
      })
    )
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(['serve', 'relay', 'status'])

    expect(process.exitCode).toBe(1)
    expect(error.mock.calls.flat().join('\n')).toContain('an orcad older than this CLI')
    process.exitCode = 0
  })

  it('sends relay only when asked, so an older host still mints direct offers', async () => {
    const offer = {
      available: true,
      deviceId: 'device-1',
      scope: 'mobile',
      pairingUrl: 'orca://pair?code=secret',
      endpoint: 'ws://10.0.0.2:6768',
      webClientUrl: null,
      offerExpiresAt: null,
      serverKeyFingerprint: 'sha256:abc',
      viaRelay: true
    }
    queueFixtures(callMock, okFixture('req', offer), okFixture('req', offer))
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['serve', 'pairing', 'new', '--mobile', '--pairing-address', '10.0.0.2', '--json'])
    expect(callMock).toHaveBeenLastCalledWith(
      'pairing.create',
      expect.not.objectContaining({ relay: expect.anything() })
    )

    await main(['serve', 'pairing', 'new', '--mobile', '--relay'])
    expect(callMock).toHaveBeenLastCalledWith(
      'pairing.create',
      expect.objectContaining({ scope: 'mobile', relay: true })
    )
    expect(log.mock.calls.flat().join('\n')).toContain('Reach: Orca Relay')
  })

  it('refuses --relay without --mobile before contacting the runtime', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(['serve', 'pairing', 'new', '--relay'])

    expect(callMock).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
    expect(error.mock.calls.flat().join('\n')).toContain('--relay pairs phones only')
    process.exitCode = 0
  })
})
