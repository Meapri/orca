import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { parsePairingCode } from '../../shared/pairing'
import { failOverRuntimeEnvironmentEndpoint } from '../ipc/runtime-environment-endpoint-failover'
import { REMOTE_RUNTIME_CONNECT_FAILURE_PHRASE } from '../../shared/remote-runtime-connect-bound'

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([]),
  listWorktreesStrict: vi.fn().mockResolvedValue([])
}))

describe('pairing offer alternate endpoints (host)', () => {
  const servers: OrcaRuntimeRpcServer[] = []

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.stop()))
  })

  async function startServer(): Promise<OrcaRuntimeRpcServer> {
    const server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      userDataPath: mkdtempSync(join(tmpdir(), 'orca-pairing-alternates-')),
      enableWebSocket: true,
      wsPort: 0
    })
    servers.push(server)
    await server.start()
    return server
  }

  it('publishes distinct alternates after the unchanged primary endpoint', async () => {
    const server = await startServer()
    const offer = server.createPairingOffer({
      address: 'orca.example.com',
      scope: 'runtime',
      alternateEndpoints: ['ws://100.64.1.2:6768', 'ws://100.64.1.2:6768']
    })
    if (!offer.available) {
      throw new Error(offer.reason)
    }
    const decoded = parsePairingCode(offer.pairingUrl)

    expect(decoded?.endpoint).toBe(offer.endpoint)
    expect(decoded?.alternateEndpoints).toEqual(['ws://100.64.1.2:6768'])
  })

  it('omits the key entirely when there is nothing else to offer', async () => {
    const server = await startServer()
    const offer = server.createPairingOffer({
      address: 'orca.example.com',
      scope: 'runtime',
      alternateEndpoints: []
    })
    if (!offer.available) {
      throw new Error(offer.reason)
    }

    expect(parsePairingCode(offer.pairingUrl)).not.toHaveProperty('alternateEndpoints')
  })
})

describe('failOverRuntimeEnvironmentEndpoint', () => {
  it('only reacts to a connect that went unanswered', () => {
    const missingStore = join(tmpdir(), 'orca-failover-missing-store')

    expect(
      failOverRuntimeEnvironmentEndpoint(missingStore, 'env', 'ws://a', 'terminal_not_writable')
    ).toBe(false)
    // An unreadable store or unknown environment is swallowed, never masking the caller's error.
    expect(
      failOverRuntimeEnvironmentEndpoint(
        missingStore,
        'env',
        'ws://a',
        `${REMOTE_RUNTIME_CONNECT_FAILURE_PHRASE}.`
      )
    ).toBe(false)
  })
})
