import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

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

vi.mock('child_process', async (importOriginal) => {
  const { createChildProcessModuleMock } = await import('./index-test-harness.js')
  // Why the original too: doctor's lock inspection reads process start times via execFile.
  return { ...(await importOriginal()), ...(await createChildProcessModuleMock(spawnMock)) }
})

import { main } from './index'
import { RuntimeClientError } from './runtime/types'
import { okFixture } from './test-fixtures'
import { pairRuntimeEnvironment, useWorktreeAwarenessEnvironment } from './index-test-harness'

function serverHealth(state: 'ready' | 'not_ready', live = true) {
  return {
    state,
    live,
    boundEndpoint: 'ws://127.0.0.1:6768',
    checkedAt: '2026-09-26T00:00:00.000Z',
    health: {
      buildHash: 'abc123',
      buildVersion: '1.2.3',
      nodeVersion: '24.1.0',
      nodeAbi: '137',
      platform: 'linux',
      arch: 'x64',
      pid: 10,
      terminalDaemon: {
        state: 'live',
        ownsFreshSessions: true,
        pid: 11,
        buildVersion: '1.2.3',
        entryPath: '/d.js',
        protocolVersion: 5,
        cgroupUnit: null,
        selfTest: { ok: true, coverage: 'pty-spawn', verdict: 'healthy', durationMs: 9 }
      },
      degradations:
        state === 'ready'
          ? []
          : [
              {
                code: 'runtime_unresponsive',
                severity: 'critical',
                component: 'runtime',
                message: 'The runtime did not answer.'
              }
            ]
    },
    stats: {
      startedAt: '2026-09-26T00:00:00.000Z',
      uptimeSeconds: 3_700,
      memory: { rssBytes: 200 * 1024 ** 2, heapUsedBytes: 1, heapTotalBytes: 2 },
      cpu: { userMs: 1_000, systemMs: 500 },
      connectedClients: 2,
      pairedDevices: 3,
      localTerminals: null
    }
  }
}

afterEach(() => {
  process.exitCode = undefined
  delete process.env.ORCA_USER_DATA
})

describe('orca serve status | doctor | pairing', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  it('reads server.health from the local orcad and exits 0 when ready', async () => {
    callMock.mockResolvedValueOnce(okFixture('req_health', serverHealth('ready')))
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['serve', 'status', '--fresh'], '/tmp/repo')

    expect(callMock).toHaveBeenCalledWith('server.health', { fresh: true })
    const printed = String(log.mock.calls[0]?.[0])
    expect(printed).toContain('orcad: ready, live')
    expect(printed).toContain('Uptime: 1h 1m')
    expect(printed).toContain('local terminals: unverifiable')
    expect(process.exitCode).toBeUndefined()
  })

  it('exits 1 and lists the critical degradation when the server is not ready', async () => {
    callMock.mockResolvedValueOnce(okFixture('req_health', serverHealth('not_ready')))
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['serve', 'status'], '/tmp/repo')

    expect(String(log.mock.calls[0]?.[0])).toContain('[critical] runtime_unresponsive')
    expect(process.exitCode).toBe(1)
  })

  it('explains an older runtime instead of calling it down', async () => {
    callMock.mockRejectedValueOnce(new RuntimeClientError('method_not_found', 'Unknown method'))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['serve', 'status'], '/tmp/repo')

    expect(error.mock.calls.flat().join(' ')).toContain('does not publish server health')
    expect(process.exitCode).toBe(1)
  })

  it('names the data root instead of suggesting `orca open` when no orcad answers', async () => {
    callMock.mockRejectedValueOnce(new RuntimeClientError('runtime_unavailable', 'no metadata'))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['serve', 'status', '--data-root', '/srv/orcad'], '/tmp/repo')

    const printed = error.mock.calls.flat().join(' ')
    expect(printed).toContain('No Orca runtime answered on data root /srv/orcad')
    expect(printed).not.toContain('orca open')
    expect(process.exitCode).toBe(1)
  })

  it('asks a paired server when --environment is given', async () => {
    pairRuntimeEnvironment(listEnvironmentsMock, 'env-vps', 'vps')
    callMock.mockResolvedValueOnce(okFixture('req_health', serverHealth('ready')))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    runtimeClientConstructorMock.mockClear()

    await main(['serve', 'status', '--environment', 'vps', '--json'], '/tmp/repo')

    expect(runtimeClientConstructorMock).toHaveBeenCalledWith(undefined, 'vps')
    expect(runtimeClientConstructorMock).not.toHaveBeenCalledWith(null, null)
  })

  it('refuses to mint a pairing offer through a paired server', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['serve', 'pairing', '--environment', 'vps'], '/tmp/repo')

    expect(callMock).not.toHaveBeenCalled()
    expect(error.mock.calls.flat().join(' ')).toContain('does not retarget serve pairing')
    expect(process.exitCode).toBe(1)
  })

  it('prints the pairing link and forwards --rotate', async () => {
    callMock.mockResolvedValueOnce(
      okFixture('req_pair', {
        available: true,
        url: 'orca://pair?code=abc',
        endpoint: 'ws://127.0.0.1:6768',
        deviceId: 'device-1',
        webClientUrl: null,
        scope: 'runtime',
        qr: null
      })
    )
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['serve', 'pairing', '--rotate'], '/tmp/repo')

    expect(callMock).toHaveBeenCalledWith('server.pairingOffer', { rotate: true })
    expect(String(log.mock.calls[0]?.[0])).toContain('Pairing URL: orca://pair?code=abc')
  })

  it('treats `serve pairing show` as the reprint and prints the offer expiry', async () => {
    callMock.mockResolvedValueOnce(
      okFixture('req_pair', {
        available: true,
        url: 'orca://pair?code=abc',
        endpoint: 'ws://127.0.0.1:6768',
        deviceId: 'device-1',
        webClientUrl: null,
        scope: 'runtime',
        qr: null,
        expiresAt: Date.UTC(2026, 0, 1, 0, 15)
      })
    )
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['serve', 'pairing', 'show', '--data-root', '/srv/orcad'], '/tmp/repo')

    expect(runtimeClientConstructorMock).toHaveBeenCalledWith(null, null)
    expect(callMock).toHaveBeenCalledWith('server.pairingOffer', { rotate: false })
    expect(String(log.mock.calls[0]?.[0])).toContain('Expires: 2026-01-01T00:15:00.000Z')
  })

  it('runs doctor against the data root and exits 1 on a failed check', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'orca-doctor-cli-'))
    process.env.ORCA_USER_DATA = join(dataRoot, 'absent')
    callMock.mockRejectedValue(new RuntimeClientError('runtime_unavailable', 'not running'))
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['serve', 'doctor', '--bind', '203.0.113.9', '--port', '1', '--json'], '/tmp/repo')

    const report = JSON.parse(String(log.mock.calls[0]?.[0])).result
    expect(report.dataRoot).toBe(join(dataRoot, 'absent'))
    expect(report.checks.find((check: { id: string }) => check.id === 'runtime').status).toBe(
      'skip'
    )
    expect(report.checks.find((check: { id: string }) => check.id === 'bind').status).toBe('fail')
    expect(process.exitCode).toBe(1)
  })
})
