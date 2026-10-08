import {
  listPairingDialEndpoints,
  PairingEndpointRotation
} from '../../../src/shared/pairing-endpoint-failover'
import type { HostProfile, PairingOffer } from './types'

/** Stores the offer's other addresses as alternates, preferring whichever answered during pairing. */
export function withPairedEndpoints(
  host: HostProfile,
  offer: PairingOffer,
  answeredEndpoint: string | null
): HostProfile {
  const endpoints = listPairingDialEndpoints(offer)
  if (endpoints.length < 2) {
    return host
  }
  const preferred =
    answeredEndpoint && endpoints.includes(answeredEndpoint) ? answeredEndpoint : offer.endpoint
  return {
    ...host,
    endpoint: preferred,
    alternateEndpoints: new PairingEndpointRotation(endpoints).alternatesAfter(preferred)
  }
}
