import { describe, expect, it } from 'vitest'
import {
  listPairingDialEndpoints,
  nextEndpointAfterUnreachable,
  PairingEndpointRotation,
  readPairingAlternateEndpoints
} from './pairing-endpoint-failover'
import { PAIRING_ALTERNATE_ENDPOINTS_MAX } from './mobile-pairing-protocol-limits'

describe('pairing endpoint failover', () => {
  it('drops malformed and excess alternates instead of refusing the offer', () => {
    const many = Array.from({ length: 12 }, (_, index) => `ws://10.0.0.${index}:6768`)
    expect(readPairingAlternateEndpoints(['ws://a:1', 7, '', null, 'ws://b:2'])).toEqual([
      'ws://a:1',
      'ws://b:2'
    ])
    expect(readPairingAlternateEndpoints(many)).toHaveLength(PAIRING_ALTERNATE_ENDPOINTS_MAX)
    expect(readPairingAlternateEndpoints('ws://a:1')).toEqual([])
    expect(readPairingAlternateEndpoints(undefined)).toEqual([])
  })

  it('lists the primary first and de-duplicates alternates', () => {
    expect(
      listPairingDialEndpoints({
        endpoint: 'ws://a:1',
        alternateEndpoints: ['ws://b:2', 'ws://a:1', 'ws://b:2']
      })
    ).toEqual(['ws://a:1', 'ws://b:2'])
    expect(listPairingDialEndpoints({ endpoint: 'ws://a:1' })).toEqual(['ws://a:1'])
  })

  it('moves preference only after the preferred endpoint went unanswered', () => {
    const entries = [
      { id: 'p', endpoint: 'ws://a:1' },
      { id: 'q', endpoint: 'ws://b:2' }
    ]
    expect(nextEndpointAfterUnreachable(entries, 'p', 'ws://a:1')?.id).toBe('q')
    expect(nextEndpointAfterUnreachable(entries, 'q', 'ws://b:2')?.id).toBe('p')
    // A stale failure against a no-longer-preferred endpoint must not skip a candidate.
    expect(nextEndpointAfterUnreachable(entries, 'q', 'ws://a:1')).toBeNull()
    expect(nextEndpointAfterUnreachable(entries.slice(0, 1), 'p', 'ws://a:1')).toBeNull()
  })

  it('rotates on unanswered connects and pins the endpoint that answered', () => {
    const rotation = new PairingEndpointRotation(['ws://a:1', 'ws://b:2', 'ws://c:3'])
    expect(rotation.current()).toBe('ws://a:1')
    expect(rotation.noteConnectFailure('ws://b:2')).toBe(false)
    expect(rotation.noteConnectFailure('ws://a:1')).toBe(true)
    expect(rotation.current()).toBe('ws://b:2')
    rotation.noteConnected('ws://c:3')
    expect(rotation.current()).toBe('ws://c:3')
    expect(rotation.alternatesAfter('ws://c:3')).toEqual(['ws://a:1', 'ws://b:2'])
  })

  it('never rotates a single-endpoint pairing', () => {
    const rotation = new PairingEndpointRotation(['ws://a:1'])
    expect(rotation.noteConnectFailure('ws://a:1')).toBe(false)
    expect(rotation.current()).toBe('ws://a:1')
  })
})
