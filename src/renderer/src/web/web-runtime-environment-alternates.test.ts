import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createStoredWebRuntimeEnvironment,
  getPreferredWebPairingOffer,
  preferConnectedWebEndpoint,
  readStoredWebRuntimeEnvironment
} from './web-runtime-environment'

const offer = {
  v: 2 as const,
  endpoint: 'ws://203.0.113.10:6768',
  deviceToken: 'token',
  publicKeyB64: Buffer.alloc(32).toString('base64'),
  alternateEndpoints: ['ws://100.64.0.5:6768', 'ws://10.0.0.5:6768']
}

describe('web runtime environment alternates', () => {
  beforeEach(() => {
    const storage = new Map<string, string>()
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key)
      }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('stores one endpoint entry per paired address with the primary preferred', () => {
    const environment = createStoredWebRuntimeEnvironment({ name: 'VPS', offer })
    expect(environment.endpoints.map((entry) => entry.endpoint)).toEqual([
      offer.endpoint,
      ...offer.alternateEndpoints
    ])
    expect(getPreferredWebPairingOffer(environment)).toMatchObject({
      endpoint: offer.endpoint,
      alternateEndpoints: offer.alternateEndpoints
    })
  })

  it('keeps the address that answered preferred across page loads', () => {
    const environment = createStoredWebRuntimeEnvironment({ name: 'VPS', offer })
    const updated = preferConnectedWebEndpoint(environment, 'ws://100.64.0.5:6768')
    expect(readStoredWebRuntimeEnvironment()?.preferredEndpointId).toBe(updated.preferredEndpointId)
    expect(getPreferredWebPairingOffer(updated)).toMatchObject({
      endpoint: 'ws://100.64.0.5:6768',
      alternateEndpoints: ['ws://10.0.0.5:6768', offer.endpoint]
    })
    expect(preferConnectedWebEndpoint(updated, 'ws://100.64.0.5:6768')).toBe(updated)
  })

  it('stores a single entry for an offer from an older host', () => {
    const { alternateEndpoints: _omitted, ...legacy } = offer
    const environment = createStoredWebRuntimeEnvironment({ name: 'VPS', offer: legacy })
    expect(environment.endpoints).toHaveLength(1)
    expect(getPreferredWebPairingOffer(environment)).not.toHaveProperty('alternateEndpoints')
  })
})
