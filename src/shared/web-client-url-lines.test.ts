import { describe, expect, it } from 'vitest'
import { formatWebClientUrlLines } from './web-client-url-lines'

describe('formatWebClientUrlLines', () => {
  it('prints nothing when the host serves no browser client', () => {
    expect(formatWebClientUrlLines({ webClientUrl: null })).toEqual([])
  })

  it('names the SSH forward a loopback link needs', () => {
    expect(
      formatWebClientUrlLines({ webClientUrl: 'http://127.0.0.1:6768/web-index.html#pairing=x' })
    ).toEqual([
      'Web client URL: http://127.0.0.1:6768/web-index.html#pairing=x',
      '  Loopback only: open it on this host, or forward the port first (ssh -L 6768:127.0.0.1:6768 <server>).'
    ])
  })

  it('lists alternates and adds no loopback note for a reachable address', () => {
    expect(
      formatWebClientUrlLines({
        webClientUrl: 'https://orca.example.com/orca/web-index.html#pairing=x',
        webClientAlternateUrls: ['http://100.64.0.5:6768/web-index.html#pairing=y']
      })
    ).toEqual([
      'Web client URL: https://orca.example.com/orca/web-index.html#pairing=x',
      'Web client URL (alternate): http://100.64.0.5:6768/web-index.html#pairing=y'
    ])
  })
})
