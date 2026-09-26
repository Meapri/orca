import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { readRuntimeMetadata } from './runtime-metadata'
import { parsePairingCode } from '../../shared/pairing'
import { deriveSharedKey, encrypt, generateKeyPair } from './rpc/e2ee-crypto'
import { sendRequest, waitFor } from './runtime-rpc-test-harness'
import {
  authenticateMobileWsSession,
  connectWs,
  createEncryptedWsResponseReader,
  nextWsMessage,
  sendEncryptedWsRequest,
  waitForWsClose
} from './runtime-rpc-mobile-ws-test-harness'
import { HOST_ONLY_DEVICE_ADMINISTRATION_MESSAGE } from './rpc/methods/device-administration'

const MintedOffer = z.object({
  result: z.object({ pairingUrl: z.string(), deviceId: z.string() }).passthrough()
})
const ListedDevices = z.object({ result: z.object({ devices: z.array(z.unknown()) }) })

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([]),
  listWorktreesStrict: vi.fn().mockResolvedValue([])
}))

type Harness = {
  server: OrcaRuntimeRpcServer
  securityLogPath: string
  host: (method: string, params?: unknown) => Promise<Record<string, unknown>>
}

async function startHarness(options: { pinnedBindHost?: string } = {}): Promise<Harness> {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-device-admin-'))
  const securityLogPath = join(userDataPath, 'logs', 'security.log')
  const server = new OrcaRuntimeRpcServer({
    runtime: new OrcaRuntimeService(),
    userDataPath,
    enableWebSocket: true,
    wsPort: 0,
    securityLogPath,
    ...(options.pinnedBindHost ? { pinnedBindHost: options.pinnedBindHost } : {})
  })
  await server.start()
  const metadata = readRuntimeMetadata(userDataPath)!
  let sequence = 0
  const host = async (method: string, params?: unknown) =>
    await sendRequest(metadata.transports[0]!.endpoint, {
      id: `admin-${++sequence}`,
      authToken: metadata.authToken,
      method,
      ...(params === undefined ? {} : { params })
    })
  return { server, securityLogPath, host }
}

async function mintRuntimeOffer(harness: Harness): Promise<{ url: string; deviceId: string }> {
  const response = await harness.host('pairing.create', { scope: 'runtime', address: '127.0.0.1' })
  expect(response).toMatchObject({ ok: true, result: { available: true, scope: 'runtime' } })
  const { result } = MintedOffer.parse(response)
  return { url: result.pairingUrl, deviceId: result.deviceId }
}

// Why: a revoked or expired credential is refused inside E2EE auth, which closes 4001.
async function expectAuthRejected(pairingUrl: string): Promise<void> {
  const parsed = parsePairingCode(pairingUrl)!
  const ws = await connectWs(parsed.endpoint)
  const keys = generateKeyPair()
  const sharedKey = deriveSharedKey(
    keys.secretKey,
    Uint8Array.from(Buffer.from(parsed.publicKeyB64, 'base64'))
  )
  const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)))
  ws.send(
    JSON.stringify({
      type: 'e2ee_hello',
      publicKeyB64: Buffer.from(keys.publicKey).toString('base64')
    })
  )
  expect(JSON.parse(await nextWsMessage(ws))).toEqual({ type: 'e2ee_ready' })
  ws.send(
    encrypt(JSON.stringify({ type: 'e2ee_auth', deviceToken: parsed.deviceToken }), sharedKey)
  )
  expect(await closed).toBe(4001)
}

describe('host-only device administration', () => {
  it('revokes a paired runtime grant, closes its live sockets, and refuses its reconnect', async () => {
    const harness = await startHarness()
    try {
      const offer = await mintRuntimeOffer(harness)
      const session = await authenticateMobileWsSession(offer.url)

      const listed = await harness.host('devices.list')
      expect(listed).toMatchObject({
        ok: true,
        result: {
          serverKeyFingerprint: expect.stringMatching(/^sha256:[0-9a-f]{32}$/),
          devices: [
            expect.objectContaining({
              deviceId: offer.deviceId,
              scope: 'runtime',
              state: 'paired',
              offerExpiresAt: null,
              connections: 1
            })
          ]
        }
      })
      const token = parsePairingCode(offer.url)!.deviceToken
      expect(JSON.stringify(listed)).not.toContain(token)

      const revoked = await harness.host('devices.revoke', { deviceId: offer.deviceId })
      expect(revoked).toMatchObject({
        ok: true,
        result: { revoked: true, deviceId: offer.deviceId, closedConnections: 1 }
      })
      await waitForWsClose(session.ws)
      await expectAuthRejected(offer.url)
      expect(harness.server.getDeviceRegistry()?.getDevice(offer.deviceId)).toBeNull()

      const again = await harness.host('devices.revoke', { deviceId: offer.deviceId })
      expect(again).toMatchObject({ ok: true, result: { revoked: false } })

      const log = readFileSync(harness.securityLogPath, 'utf8')
      const events = log
        .trim()
        .split('\n')
        .map((line): { event: string } => JSON.parse(line))
        .map((entry) => entry.event)
      expect(events).toEqual(
        expect.arrayContaining([
          'pairing.offered',
          'pairing.consumed',
          'device.revoked',
          'auth.failed'
        ])
      )
      expect(log).not.toContain(token)
      expect(log).not.toContain('orca://pair')
    } finally {
      await harness.server.stop()
    }
  }, 15_000)

  it('refuses administration from a paired runtime client over WebSocket', async () => {
    const harness = await startHarness()
    try {
      const offer = await mintRuntimeOffer(harness)
      const session = await authenticateMobileWsSession(offer.url)
      const reader = createEncryptedWsResponseReader(session)
      try {
        for (const method of ['devices.list', 'pairing.create']) {
          sendEncryptedWsRequest(session, {
            id: method,
            method,
            deviceToken: parsePairingCode(offer.url)!.deviceToken,
            ...(method === 'pairing.create' ? { params: { scope: 'runtime' } } : {})
          })
          const response = await reader.next(method)
          expect(response).toMatchObject({
            ok: false,
            error: expect.objectContaining({ message: HOST_ONLY_DEVICE_ADMINISTRATION_MESSAGE })
          })
        }
        expect(harness.server.getDeviceRegistry()?.listDevices()).toHaveLength(1)
      } finally {
        reader.dispose()
        session.ws.close()
      }
    } finally {
      await harness.server.stop()
    }
  }, 15_000)

  it('rotates a runtime grant: the old credential stops working and the new one pairs', async () => {
    const harness = await startHarness()
    try {
      const offer = await mintRuntimeOffer(harness)
      const session = await authenticateMobileWsSession(offer.url)

      const rotated = await harness.host('devices.rotate', {
        deviceId: offer.deviceId,
        address: '127.0.0.1'
      })
      expect(rotated).toMatchObject({
        ok: true,
        result: { available: true, deviceId: offer.deviceId, closedConnections: 1 }
      })
      const rotatedUrl = MintedOffer.parse(rotated).result.pairingUrl
      expect(parsePairingCode(rotatedUrl)!.deviceToken).not.toBe(
        parsePairingCode(offer.url)!.deviceToken
      )
      await waitForWsClose(session.ws)
      await expectAuthRejected(offer.url)
      const fresh = await authenticateMobileWsSession(rotatedUrl)
      fresh.ws.close()
    } finally {
      await harness.server.stop()
    }
  }, 15_000)

  it('refuses to rotate a mobile pairing in place', async () => {
    const harness = await startHarness()
    try {
      const minted = await harness.host('pairing.create', {
        scope: 'mobile',
        address: '192.0.2.10'
      })
      const deviceId = MintedOffer.parse(minted).result.deviceId
      const rotated = await harness.host('devices.rotate', { deviceId })
      expect(rotated).toMatchObject({
        ok: true,
        result: { available: false, reason: 'rotation_unsupported' }
      })
    } finally {
      await harness.server.stop()
    }
  })

  it('stops admitting an offer once its window closes unclaimed', async () => {
    const harness = await startHarness()
    try {
      const offer = harness.server.createPairingOffer({
        address: '127.0.0.1',
        scope: 'runtime',
        offerLifetimeMs: 1
      })
      if (!offer.available) {
        throw new Error('pairing unavailable')
      }
      await new Promise((resolve) => setTimeout(resolve, 5))
      await expectAuthRejected(offer.pairingUrl)

      const listed = await harness.host('devices.list')
      expect(ListedDevices.parse(listed).result.devices).toEqual([])
      await waitFor(() => readFileSync(harness.securityLogPath, 'utf8').includes('pairing.expired'))
    } finally {
      await harness.server.stop()
    }
  }, 15_000)

  it('keeps a claimed offer valid after its original window', async () => {
    const harness = await startHarness()
    try {
      const offer = harness.server.createPairingOffer({
        address: '127.0.0.1',
        scope: 'runtime',
        offerLifetimeMs: 300
      })
      if (!offer.available) {
        throw new Error('pairing unavailable')
      }
      const first = await authenticateMobileWsSession(offer.pairingUrl)
      first.ws.close()
      await new Promise((resolve) => setTimeout(resolve, 400))
      const second = await authenticateMobileWsSession(offer.pairingUrl)
      second.ws.close()
      expect(
        harness.server.getDeviceRegistry()?.getDevice(offer.deviceId)?.offerExpiresAt
      ).toBeUndefined()
    } finally {
      await harness.server.stop()
    }
  }, 15_000)

  it('lets runtime and mobile offers coexist on one server', async () => {
    const harness = await startHarness()
    try {
      const runtimeOffer = await mintRuntimeOffer(harness)
      const mobile = await harness.host('pairing.create', {
        scope: 'mobile',
        address: '192.0.2.10',
        expiresInMs: 60 * 60 * 1000
      })
      expect(mobile).toMatchObject({ ok: true, result: { available: true, scope: 'mobile' } })
      const mobileId = MintedOffer.parse(mobile).result.deviceId
      const registry = harness.server.getDeviceRegistry()!
      expect(registry.getMobilePairingConnectionMode(mobileId)).toBe('local-only')
      expect(registry.getDevice(runtimeOffer.deviceId)?.scope).toBe('runtime')
      // Why: the desktop's coalescing QR flow must not adopt, rotate away, or extend a minted offer.
      expect(registry.getPendingDevice('mobile')).toBeNull()
    } finally {
      await harness.server.stop()
    }
  })

  it('requires an explicit address for mobile offers and honours a loopback pin', async () => {
    const harness = await startHarness({ pinnedBindHost: '127.0.0.1' })
    try {
      const withoutAddress = await harness.host('pairing.create', { scope: 'mobile' })
      expect(withoutAddress).toMatchObject({
        ok: true,
        result: { available: false, reason: 'invalid_advertised_endpoint' }
      })
      // Why: behind a reverse proxy the pinned loopback listener is reachable; the address vouches for it.
      const proxied = await harness.host('pairing.create', {
        scope: 'mobile',
        address: 'wss://orca.example.com'
      })
      expect(proxied).toMatchObject({
        ok: true,
        result: { available: true, endpoint: 'wss://orca.example.com' }
      })
      expect(harness.server.getWebSocketEndpoint()).toMatch(/^ws:\/\/127\.0\.0\.1:/)
    } finally {
      await harness.server.stop()
    }
  })

  it('keeps pairing offers and E2EE auth on the same key the listener uses', async () => {
    const harness = await startHarness()
    try {
      const offer = await mintRuntimeOffer(harness)
      const parsed = parsePairingCode(offer.url)!
      expect(parsed.publicKeyB64).toBe(harness.server.getE2EEKeypair()?.publicKeyB64)
      const session = await authenticateMobileWsSession(offer.url)
      const reader = createEncryptedWsResponseReader(session)
      sendEncryptedWsRequest(session, {
        id: 's',
        method: 'status.get',
        deviceToken: parsed.deviceToken
      })
      await expect(reader.next('s')).resolves.toMatchObject({ ok: true })
      reader.dispose()
      session.ws.close()
    } finally {
      await harness.server.stop()
    }
  }, 15_000)
})
