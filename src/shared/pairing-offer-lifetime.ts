// Why: a pending pairing offer is a bearer credential that has not reached its device yet; a short
// default window bounds how long a URL left in a journal, clipboard or screen-share stays usable.
export const DEFAULT_PAIRING_OFFER_LIFETIME_MS = 15 * 60 * 1000
export const MIN_PAIRING_OFFER_LIFETIME_MS = 60 * 1000
export const MAX_PAIRING_OFFER_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000

const UNIT_MS: ReadonlyMap<string, number> = new Map([
  ['s', 1000],
  ['m', 60 * 1000],
  ['h', 60 * 60 * 1000],
  ['d', 24 * 60 * 60 * 1000]
])

export type PairingOfferLifetimeParse = { ok: true; ms: number } | { ok: false; message: string }

/** Parses `90s`, `15m`, `2h`, `1d` (a bare number is minutes) within the supported window. */
export function parsePairingOfferLifetime(input: string): PairingOfferLifetimeParse {
  const match = /^(\d+)([smhd]?)$/.exec(input.trim().toLowerCase())
  if (!match) {
    return {
      ok: false,
      message: `Invalid pairing lifetime "${input}". Use a duration such as 90s, 15m, 2h or 1d.`
    }
  }
  const ms = Number(match[1]) * (UNIT_MS.get(match[2] || 'm') ?? 0)
  if (!Number.isSafeInteger(ms) || ms < MIN_PAIRING_OFFER_LIFETIME_MS) {
    return { ok: false, message: 'A pairing offer must stay valid for at least 1 minute.' }
  }
  if (ms > MAX_PAIRING_OFFER_LIFETIME_MS) {
    return { ok: false, message: 'A pairing offer cannot stay valid for more than 7 days.' }
  }
  return { ok: true, ms }
}
