import { decodePairingOffer, encodePairingOffer } from '../../../shared/pairing'
import { PAIRING_ALTERNATE_ENDPOINTS_MAX } from '../../../shared/mobile-pairing-protocol-limits'
import { createWebClientUrl } from './runtime-rpc-pairing-types'

/**
 * One web client URL per alternate endpoint of a runtime offer.
 *
 * Why re-encode the offer: the browser client dials the offer's `endpoint` and ignores
 * `alternateEndpoints`, so a page loaded from a tailnet address must carry an offer whose primary
 * endpoint is that same address. Same device credential, so every link is the same pairing.
 */
export function createAlternateWebClientUrls(
  pairingUrl: string,
  alternateEndpoints: readonly string[]
): string[] {
  const offer = decodePairingOffer(pairingUrl)
  const everyEndpoint = [offer.endpoint, ...alternateEndpoints]
  return [...new Set(alternateEndpoints)]
    .filter((endpoint) => endpoint !== offer.endpoint)
    .map((endpoint) => {
      const others = [...new Set(everyEndpoint)]
        .filter((candidate) => candidate !== endpoint)
        .slice(0, PAIRING_ALTERNATE_ENDPOINTS_MAX)
      const reencoded = encodePairingOffer({
        ...offer,
        endpoint,
        alternateEndpoints: others.length > 0 ? others : undefined
      })
      return createWebClientUrl(endpoint, reencoded)
    })
}
