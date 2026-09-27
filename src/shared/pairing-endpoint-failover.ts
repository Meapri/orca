import {
  PAIRING_ALTERNATE_ENDPOINTS_MAX,
  PAIRING_ENDPOINT_MAX_CHARACTERS
} from './mobile-pairing-protocol-limits'

/**
 * Client-side endpoint failover for one pairing that is reachable more than one way (tailnet,
 * LAN, a configured address). Shared by the desktop store, the web client and the mobile app so
 * all three answer "which address do I dial next" the same way: after an unanswered connect the
 * next endpoint is preferred, and whichever endpoint connects stays preferred (the last good one).
 * No DOM or Node imports: `src/shared` ships to the web and mobile bundles.
 */

/**
 * Reads an offer's optional `alternateEndpoints`. Degrading by design: a malformed or excess
 * entry is dropped rather than refusing the offer, so a newer host can never break pairing.
 */
export function readPairingAlternateEndpoints(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value
    .filter(
      (entry): entry is string =>
        typeof entry === 'string' &&
        entry.length > 0 &&
        entry.length <= PAIRING_ENDPOINT_MAX_CHARACTERS
    )
    .slice(0, PAIRING_ALTERNATE_ENDPOINTS_MAX)
}

/** The offer's primary endpoint followed by its alternates, de-duplicated, in dial order. */
export function listPairingDialEndpoints(offer: {
  endpoint: string
  alternateEndpoints?: readonly string[]
}): string[] {
  return dedupeEndpoints([offer.endpoint, ...(offer.alternateEndpoints ?? [])])
}

function dedupeEndpoints(endpoints: readonly string[]): string[] {
  return endpoints.filter((endpoint, index, all) => all.indexOf(endpoint) === index)
}

/**
 * The entry to prefer after `failedEndpoint` went unanswered, or null when failover does not
 * apply: a single-endpoint pairing, or a failure against an endpoint that is no longer preferred
 * (a concurrent attempt already moved on, so rotating again would skip a candidate).
 */
export function nextEndpointAfterUnreachable<TEntry extends { id: string; endpoint: string }>(
  entries: readonly TEntry[],
  preferredEntryId: string,
  failedEndpoint: string
): TEntry | null {
  const index = entries.findIndex((entry) => entry.id === preferredEntryId)
  if (entries.length < 2 || entries[index]?.endpoint !== failedEndpoint) {
    return null
  }
  return entries[(index + 1) % entries.length] ?? null
}

/**
 * In-memory rotation for a client that redials on its own (web and mobile transports). The first
 * endpoint is the preferred one; a connect-phase failure advances to the next for the following
 * attempt, and a completed handshake pins the endpoint that answered.
 */
export class PairingEndpointRotation {
  private readonly endpoints: string[]
  private index = 0

  constructor(endpoints: readonly string[]) {
    const unique = dedupeEndpoints(endpoints.filter((endpoint) => endpoint.length > 0))
    if (unique.length === 0) {
      throw new Error('PairingEndpointRotation needs at least one endpoint')
    }
    this.endpoints = unique
  }

  current(): string {
    return this.endpoints[this.index]!
  }

  get size(): number {
    return this.endpoints.length
  }

  /** Advances when `endpoint` is the one being dialed; true when a different endpoint is next. */
  noteConnectFailure(endpoint: string): boolean {
    if (this.endpoints.length < 2 || this.current() !== endpoint) {
      return false
    }
    this.index = (this.index + 1) % this.endpoints.length
    return true
  }

  noteConnected(endpoint: string): void {
    const index = this.endpoints.indexOf(endpoint)
    if (index !== -1) {
      this.index = index
    }
  }

  /** The endpoints other than `preferred`, in the order they are tried after it. */
  alternatesAfter(preferred: string): string[] {
    const start = this.endpoints.indexOf(preferred)
    if (start === -1) {
      return this.endpoints.slice()
    }
    return [...this.endpoints.slice(start + 1), ...this.endpoints.slice(0, start)]
  }
}
