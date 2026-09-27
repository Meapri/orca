/**
 * orcad's startup pairing: where the listener is reachable, and the runtime and mobile offers
 * the readiness block prints and `orca serve pairing [--mobile]` reprints.
 */
import type { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import type { ServeReadiness } from '../server/serve-readiness'
import { collectPairingEndpointCandidates } from '../runtime/pairing-endpoint-candidates'
import { getPairingNetworkInterfaces } from '../runtime/pairing-network-interfaces'
import { DEFAULT_PAIRING_OFFER_LIFETIME_MS } from '../../shared/pairing-offer-lifetime'
import { createOrcadPairingOffer } from './orcad-pairing-offer'
import type { OrcadPairingOfferRequest } from './orcad-server-admin-methods'

export type OrcadPairingStartupOptions = {
  noPairing?: boolean
  pairingAddress?: string
  pairingAddresses?: string[]
  pairingExpiresInMs?: number
  mobilePairing?: boolean
}

export async function startOrcadPairing(
  rpc: OrcaRuntimeRpcServer,
  bindHost: string,
  options: OrcadPairingStartupOptions
) {
  const boundEndpoint = rpc.getWebSocketEndpoint()
  const endpointCandidates = boundEndpoint
    ? collectPairingEndpointCandidates({
        boundEndpoint,
        bindHost,
        configuredAddresses:
          options.pairingAddresses ?? (options.pairingAddress ? [options.pairingAddress] : []),
        interfaces: await getPairingNetworkInterfaces()
      })
    : null
  const advertised = endpointCandidates?.primary ?? null
  const shared = {
    noPairing: options.noPairing === true,
    pairingAddress: options.pairingAddress,
    // Why: `orca serve pairing new` mints a fresh offer on demand, so a short window costs nothing.
    offerLifetimeMs: options.pairingExpiresInMs ?? DEFAULT_PAIRING_OFFER_LIFETIME_MS
  }
  const runtimeOffer = createOrcadPairingOffer({
    ...shared,
    scope: 'runtime',
    alternateEndpoints: endpointCandidates?.alternates
  })
  // Why always constructed: `pairing show --mobile` works without the startup flag, which only
  // decides whether the readiness block carries a phone offer too.
  const mobileOffer = createOrcadPairingOffer({
    ...shared,
    scope: 'mobile',
    alternateEndpoints: undefined
  })

  return {
    advertisedEndpoint: advertised?.ok ? advertised.endpoint : null,
    offer: (request: OrcadPairingOfferRequest) =>
      (request.scope === 'mobile' ? mobileOffer : runtimeOffer).current(rpc, request),
    async readinessPairing(): Promise<Pick<ServeReadiness, 'pairing' | 'mobilePairing'>> {
      const pairing = await runtimeOffer.current(rpc)
      return options.mobilePairing
        ? { pairing, mobilePairing: await mobileOffer.current(rpc) }
        : { pairing }
    }
  }
}
