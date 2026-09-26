import { describe, expect, it } from 'vitest'
import { parsePairingOfferLifetime } from './pairing-offer-lifetime'

describe('parsePairingOfferLifetime', () => {
  it.each([
    ['90s', 90_000],
    ['15m', 900_000],
    ['15', 900_000],
    ['2h', 7_200_000],
    ['7d', 604_800_000],
    [' 1H ', 3_600_000]
  ])('parses %s', (input, ms) => {
    expect(parsePairingOfferLifetime(input)).toEqual({ ok: true, ms })
  })

  it.each(['', 'never', '-5m', '1.5h', '10ms', '59s', '8d', '15 m'])('rejects %s', (input) => {
    expect(parsePairingOfferLifetime(input).ok).toBe(false)
  })
})
