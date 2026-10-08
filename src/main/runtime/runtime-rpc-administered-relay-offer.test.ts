import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { parsePairingCode } from '../../shared/pairing'

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([]),
  listWorktreesStrict: vi.fn().mockResolvedValue([])
}))

const relay = {
  v: 1 as const,
  directorUrl: 'https://relay.example.com',
  cellUrl: 'https://cell.example.com',
  assignmentEpoch: 7,
  relayHostId: 'AbCdEf0123_-xyZ9',
  inviteToken: 'A'.repeat(43),
  inviteExpiresAt: Date.now() + 60_000,
  e2eeFraming: 2 as const
}

// `orca serve pairing new --mobile --relay` on a loopback-pinned orcad: the relay is the reach.
describe('administered relay pairing offers', () => {
  const cleanups: (() => Promise<void>)[] = []

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) {
      await cleanup()
    }
  })

  async function startPinnedServer(): Promise<OrcaRuntimeRpcServer> {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-relay-offer-'))
    const server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      userDataPath,
      enableWebSocket: true,
      wsPort: 0,
      pinnedBindHost: '127.0.0.1'
    })
    await server.start()
    cleanups.push(async () => {
      await server.stop()
      rmSync(userDataPath, { recursive: true, force: true })
    })
    return server
  }

  it('refuses a relay offer on a host that did not enable the relay', async () => {
    const server = await startPinnedServer()
    expect(
      await server.createAdministeredPairingOffer({ scope: 'mobile', relay: true })
    ).toMatchObject({ available: false, reason: 'relay_unavailable' })
    expect(
      await server.createAdministeredPairingOffer({ scope: 'runtime', relay: true })
    ).toMatchObject({ available: false, reason: 'relay_scope_unsupported' })
  })

  it('mints an expiring phone offer carrying the relay invite without widening the bind', async () => {
    const server = await startPinnedServer()
    server.setMobileRelayPairingProvider({
      createPairingRelay: async (relayDeviceId) => ({
        relay,
        binding: { relayHostId: relay.relayHostId, relayDeviceId, ownerIdentityKey: 'u\0p\0' }
      }),
      onDeviceRevokeQueued: vi.fn(),
      getEndpoints: vi.fn(),
      provisionRelay: vi.fn()
    })

    const offer = await server.createAdministeredPairingOffer({
      scope: 'mobile',
      relay: true,
      expiresInMs: 600_000
    })
    if (!offer.available) {
      throw new Error(`relay offer unavailable: ${offer.guidance}`)
    }
    expect(offer).toMatchObject({ scope: 'mobile', viaRelay: true })
    expect(offer.offerExpiresAt).toBeGreaterThan(Date.now())
    expect(parsePairingCode(offer.pairingUrl)).toMatchObject({ scope: 'mobile', relay })
    expect(server.getWebSocketEndpoint()).toMatch(/^ws:\/\/127\.0\.0\.1:/)
    expect(server.getDeviceRegistry()?.getMobilePairingConnectionMode(offer.deviceId)).toBe(
      'automatic'
    )
  })

  it('keeps the direct-only mobile offer unchanged when --relay is not asked for', async () => {
    const server = await startPinnedServer()
    expect(await server.createAdministeredPairingOffer({ scope: 'mobile' })).toMatchObject({
      available: false,
      reason: 'invalid_advertised_endpoint'
    })
  })
})
