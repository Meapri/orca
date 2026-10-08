/**
 * orcad's startup pairing: where the listener is reachable, and the runtime and mobile offers
 * the readiness block prints and `orca serve pairing [--mobile]` reprints. `--mobile-pairing`
 * keeps `orca serve`'s meaning: the readiness offer itself is the phone offer.
 */
import type { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import type { ServeReadiness } from '../server/serve-readiness'
import { collectPairingEndpointCandidates } from '../runtime/pairing-endpoint-candidates'
import { getPairingNetworkInterfaces } from '../runtime/pairing-network-interfaces'
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
    // Why opt-in: managed SSH hosts and `--recipe-json` re-read the readiness offer later, so an
    // unclaimed one must stay valid unless the operator asked for `--pairing-expires`.
    offerLifetimeMs: options.pairingExpiresInMs
  }
  const runtimeOffer = createOrcadPairingOffer({
    ...shared,
    scope: 'runtime',
    alternateEndpoints: endpointCandidates?.alternates
  })
  // Why always constructed: `orca serve pairing --mobile` works without the startup flag. With it,
  // the phone offer is minted the way `orca serve --mobile-pairing` mints it; without it, through
  // the administered path, which refuses loopback and pins the phone to the direct path.
  const mobileOffer = createOrcadPairingOffer({
    ...shared,
    scope: 'mobile',
    mobileMint: options.mobilePairing ? 'direct' : 'administered',
    alternateEndpoints: undefined
  })

  return {
    advertisedEndpoint: advertised?.ok ? advertised.endpoint : null,
    offer: (request: OrcadPairingOfferRequest) =>
      (request.scope === 'mobile' ? mobileOffer : runtimeOffer).current(rpc, request),
    readinessPairing(): Promise<ServeReadiness['pairing']> {
      return (options.mobilePairing ? mobileOffer : runtimeOffer).current(rpc)
    }
  }
}
