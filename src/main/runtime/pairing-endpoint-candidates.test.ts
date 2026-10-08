import { describe, expect, it } from 'vitest'
import { collectPairingEndpointCandidates } from './pairing-endpoint-candidates'
import { parseArgs } from '../orcad/orcad-command-arguments'

const INTERFACES = [
  { name: 'docker0', address: '172.17.0.1' },
  { name: 'eth0', address: '203.0.113.7' },
  { name: 'tailscale0', address: '100.101.102.103' },
  { name: 'tailscale0', address: 'fd7a:115c:a1e0::1' },
  { name: 'eth0', address: '2001:db8::7' }
]

describe('collectPairingEndpointCandidates', () => {
  it('keeps the primary unchanged and offers tailnet, then public/LAN, then bridges', () => {
    const { primary, alternates } = collectPairingEndpointCandidates({
      boundEndpoint: 'ws://0.0.0.0:6768',
      bindHost: '0.0.0.0',
      configuredAddresses: ['orca.example.com', 'wss://relay.example.com/orca'],
      interfaces: INTERFACES
    })

    expect(primary).toEqual({ ok: true, endpoint: 'ws://orca.example.com:6768' })
    expect(alternates).toEqual([
      'wss://relay.example.com/orca',
      'ws://100.101.102.103:6768',
      'ws://[fd7a:115c:a1e0::1]:6768',
      'ws://203.0.113.7:6768',
      'ws://[2001:db8::7]:6768',
      'ws://172.17.0.1:6768'
    ])
  })

  it('offers nothing extra for a loopback bind, which only an SSH forward can reach', () => {
    const { primary, alternates } = collectPairingEndpointCandidates({
      boundEndpoint: 'ws://127.0.0.1:6768',
      bindHost: '127.0.0.1',
      configuredAddresses: [],
      interfaces: INTERFACES
    })

    expect(primary).toEqual({ ok: true, endpoint: 'ws://127.0.0.1:6768' })
    expect(alternates).toEqual([])
  })

  it('offers the bound address itself for a specific-interface bind and dedupes it', () => {
    const { alternates } = collectPairingEndpointCandidates({
      boundEndpoint: 'ws://100.101.102.103:6768',
      bindHost: '100.101.102.103',
      configuredAddresses: ['orca.tail1234.ts.net', '100.101.102.103', 'not a host!'],
      interfaces: INTERFACES
    })

    expect(alternates).toEqual(['ws://100.101.102.103:6768'])
  })

  it('caps alternates so the pairing code stays small', () => {
    const { alternates } = collectPairingEndpointCandidates({
      boundEndpoint: 'ws://0.0.0.0:6768',
      bindHost: '0.0.0.0',
      configuredAddresses: [],
      interfaces: Array.from({ length: 20 }, (_, index) => ({
        name: `eth${index}`,
        address: `10.0.0.${index + 1}`
      }))
    })

    expect(alternates).toHaveLength(8)
  })
})

describe('orcad --pairing-address', () => {
  it('accepts repeats, keeping the first as the advertised address', () => {
    const options = parseArgs(['--pairing-address', 'a.example', '--pairing-address', 'b.example'])

    expect(options.pairingAddress).toBe('a.example')
    expect(options.pairingAddresses).toEqual(['a.example', 'b.example'])
  })

  it('keeps the single-address form unchanged', () => {
    const options = parseArgs(['--pairing-address', 'a.example'])

    expect(options.pairingAddress).toBe('a.example')
    expect(options.pairingAddresses).toEqual(['a.example'])
  })
})
