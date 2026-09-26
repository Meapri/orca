import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { encodePairingOffer, parsePairingCode, type PairingOffer } from './pairing'
import {
  addEnvironmentFromPairingCode,
  preferNextEnvironmentEndpointAfterUnreachable,
  resolveEnvironment
} from './runtime-environment-store'
import { createEnvironmentFromPairingOffer, getPreferredPairingOffer } from './runtime-environments'

const BASE_OFFER: PairingOffer = {
  v: 2,
  endpoint: 'ws://orca.example.com:6768',
  deviceToken: 'device-token',
  publicKeyB64: Buffer.alloc(32, 7).toString('base64'),
  scope: 'runtime'
}
const OFFER_WITH_ALTERNATES: PairingOffer = {
  ...BASE_OFFER,
  alternateEndpoints: ['ws://100.101.102.103:6768', 'ws://192.168.1.20:6768']
}

// The decoder an older build ships: the same object schema without the new key (zod strips it).
const PRE_ALTERNATES_DECODER = z.object({
  v: z.literal(2),
  endpoint: z.string().min(1),
  deviceToken: z.string().min(1),
  publicKeyB64: z.string().min(1),
  scope: z.enum(['mobile', 'runtime']).optional()
})

function decodeCode(url: string): unknown {
  const code = new URL(url).searchParams.get('code') ?? ''
  return JSON.parse(Buffer.from(code, 'base64url').toString('utf8'))
}

describe('pairing offer alternate endpoints across versions', () => {
  it('old client against new host: the primary endpoint is untouched and alternates vanish', () => {
    const decoded = PRE_ALTERNATES_DECODER.parse(
      decodeCode(encodePairingOffer(OFFER_WITH_ALTERNATES))
    )

    expect(decoded).toEqual(BASE_OFFER)
  })

  it('new client against old host: an offer without the field pairs one endpoint as before', () => {
    const environment = createEnvironmentFromPairingOffer({
      id: 'env-1',
      name: 'vps',
      now: 1,
      offer: parsePairingCode(encodePairingOffer(BASE_OFFER))!
    })

    expect(environment.endpoints.map((entry) => entry.endpoint)).toEqual([BASE_OFFER.endpoint])
    expect(getPreferredPairingOffer(environment).endpoint).toBe(BASE_OFFER.endpoint)
  })

  it('new client against new host: stores every endpoint with the same credential', () => {
    const environment = createEnvironmentFromPairingOffer({
      id: 'env-1',
      name: 'vps',
      now: 1,
      offer: parsePairingCode(encodePairingOffer(OFFER_WITH_ALTERNATES))!
    })

    expect(environment.endpoints.map((entry) => entry.endpoint)).toEqual([
      'ws://orca.example.com:6768',
      'ws://100.101.102.103:6768',
      'ws://192.168.1.20:6768'
    ])
    expect(new Set(environment.endpoints.map((entry) => entry.deviceToken))).toEqual(
      new Set(['device-token'])
    )
    expect(getPreferredPairingOffer(environment).endpoint).toBe('ws://orca.example.com:6768')
  })
})

describe('preferNextEnvironmentEndpointAfterUnreachable', () => {
  function pairedStore(offer: PairingOffer): { userDataPath: string; id: string } {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-endpoint-failover-'))
    const environment = addEnvironmentFromPairingCode(userDataPath, {
      name: 'vps',
      pairingCode: encodePairingOffer(offer)
    })
    return { userDataPath, id: environment.id }
  }

  it('tries each endpoint in order and wraps around, keeping the pairing revision', () => {
    const { userDataPath, id } = pairedStore(OFFER_WITH_ALTERNATES)
    const revision = resolveEnvironment(userDataPath, id).pairingRevision
    const preferred = (): string =>
      getPreferredPairingOffer(resolveEnvironment(userDataPath, id)).endpoint

    expect(preferNextEnvironmentEndpointAfterUnreachable(userDataPath, id, preferred())).toBe(true)
    expect(preferred()).toBe('ws://100.101.102.103:6768')
    expect(preferNextEnvironmentEndpointAfterUnreachable(userDataPath, id, preferred())).toBe(true)
    expect(preferred()).toBe('ws://192.168.1.20:6768')
    expect(preferNextEnvironmentEndpointAfterUnreachable(userDataPath, id, preferred())).toBe(true)
    expect(preferred()).toBe('ws://orca.example.com:6768')
    expect(resolveEnvironment(userDataPath, id).pairingRevision).toBe(revision)
  })

  it('ignores a stale failure from an endpoint that is no longer preferred', () => {
    const { userDataPath, id } = pairedStore(OFFER_WITH_ALTERNATES)

    expect(
      preferNextEnvironmentEndpointAfterUnreachable(userDataPath, id, 'ws://192.168.1.20:6768')
    ).toBe(false)
    expect(getPreferredPairingOffer(resolveEnvironment(userDataPath, id)).endpoint).toBe(
      'ws://orca.example.com:6768'
    )
  })

  it('never moves a single-endpoint pairing', () => {
    const { userDataPath, id } = pairedStore(BASE_OFFER)

    expect(
      preferNextEnvironmentEndpointAfterUnreachable(userDataPath, id, BASE_OFFER.endpoint)
    ).toBe(false)
  })
})
