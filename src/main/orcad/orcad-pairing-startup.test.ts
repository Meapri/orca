import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodePairingOffer } from '../../shared/pairing'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import type { ServePairingReadiness } from '../server/serve-readiness'
import { startOrcadPairing, type OrcadPairingStartupOptions } from './orcad-pairing-startup'

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([]),
  listWorktreesStrict: vi.fn().mockResolvedValue([])
}))
vi.mock('../runtime/pairing-network-interfaces', () => ({
  getPairingNetworkInterfaces: vi.fn(async () => [])
}))

const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup()
  }
})

async function startServer(options: OrcadPairingStartupOptions) {
  const root = mkdtempSync(join(tmpdir(), 'orcad-pairing-startup-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const webClientRoot = join(root, 'web')
  mkdirSync(webClientRoot)
  writeFileSync(join(webClientRoot, 'web-index.html'), '<!doctype html><title>Orca</title>')
  const rpc = new OrcaRuntimeRpcServer({
    runtime: new OrcaRuntimeService(),
    userDataPath: root,
    enableWebSocket: true,
    wsPort: 0,
    pinnedBindHost: '127.0.0.1',
    webClientRoot
  })
  await rpc.start()
  cleanups.push(() => rpc.stop())
  return { rpc, pairing: await startOrcadPairing(rpc, '127.0.0.1', options) }
}

function available(offer: ServePairingReadiness | undefined) {
  if (!offer?.available) {
    throw new Error(`expected an available offer, got ${JSON.stringify(offer)}`)
  }
  return offer
}

describe('orcad startup pairing', () => {
  it('serves the browser client and links it once per reachable endpoint', async () => {
    const { rpc, pairing } = await startServer({
      pairingAddress: '127.0.0.1',
      pairingAddresses: ['127.0.0.1', '100.64.0.5']
    })
    const port = new URL(rpc.getWebSocketEndpoint() ?? '').port
    const { pairing: offer, mobilePairing } = await pairing.readinessPairing()
    const runtime = available(offer)

    expect(mobilePairing).toBeUndefined()
    expect(runtime.webClientUrl).toMatch(
      new RegExp(`^http://127\\.0\\.0\\.1:${port}/web-index\\.html#pairing=`)
    )
    expect(runtime.webClientAlternateUrls).toHaveLength(1)
    const alternate = new URL(runtime.webClientAlternateUrls?.[0] ?? '')
    expect(alternate.host).toBe(`100.64.0.5:${port}`)
    const alternateOffer = decodePairingOffer(
      decodeURIComponent(alternate.hash.slice('#pairing='.length))
    )
    // Why: the browser dials only `endpoint`, so the link from a tailnet page must dial the tailnet.
    expect(alternateOffer.endpoint).toBe(`ws://100.64.0.5:${port}`)
    expect(alternateOffer.alternateEndpoints).toEqual([`ws://127.0.0.1:${port}`])
    expect(alternateOffer.pairedDeviceId).toBe(runtime.deviceId)

    const page = await fetch(`http://127.0.0.1:${port}/web-index.html`)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('<title>Orca</title>')
  })

  it('prints a phone offer beside the runtime one and reprints the same credential', async () => {
    const { pairing } = await startServer({
      pairingAddress: '100.64.0.5',
      pairingAddresses: ['100.64.0.5'],
      mobilePairing: true
    })
    const { pairing: offer, mobilePairing } = await pairing.readinessPairing()
    const runtime = available(offer)
    const mobile = available(mobilePairing)

    expect(runtime.scope).toBe('runtime')
    expect(mobile.scope).toBe('mobile')
    expect(mobile.deviceId).not.toBe(runtime.deviceId)
    expect(mobile.webClientUrl).toBeNull()
    expect(mobile.qr).toEqual(expect.any(String))
    expect(decodePairingOffer(mobile.url).scope).toBe('mobile')

    const reprint = available(await pairing.offer({ rotate: false, scope: 'mobile' }))
    expect(reprint.deviceId).toBe(mobile.deviceId)
    const rotated = available(await pairing.offer({ rotate: true, scope: 'mobile' }))
    expect(rotated.deviceId).not.toBe(mobile.deviceId)
    const runtimeReprint = available(await pairing.offer({ rotate: false, scope: 'runtime' }))
    expect(runtimeReprint.deviceId).toBe(runtime.deviceId)
  })

  it('reports a phone offer unavailable when only loopback is advertised', async () => {
    const { pairing } = await startServer({ mobilePairing: true })
    const { pairing: offer, mobilePairing } = await pairing.readinessPairing()

    expect(offer.available).toBe(true)
    expect(mobilePairing).toMatchObject({
      available: false,
      reason: 'invalid_advertised_endpoint',
      guidance: expect.stringContaining('--pairing-address')
    })
  })
})
