/**
 * The startup pairing offer orcad prints in its readiness line, and the one `orca serve pairing`
 * reprints. It is a standalone expiring offer (see DEFAULT_PAIRING_OFFER_LIFETIME_MS), so a
 * reprint re-serves that same credential until a client claims it or it expires, then mints the
 * next one with the same lifetime. `orca serve pairing new` mints extra offers and never touches it.
 */
import type { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import type { ServePairingReadiness } from '../server/serve-readiness'
import { DEVICE_REGISTRY_UNAVAILABLE_GUIDANCE } from '../runtime/runtime-rpc/runtime-rpc-pairing-types'

export type OrcadPairingOptions = {
  noPairing: boolean
  pairingAddress: string | undefined
  offerLifetimeMs: number
}

export type OrcadPairingRpc = Pick<
  OrcaRuntimeRpcServer,
  'createPairingOffer' | 'reissueUnclaimedPairingOffer' | 'supersedeUnclaimedPairingOffer'
>

type EncodedOffer = {
  available: true
  pairingUrl: string
  endpoint: string
  deviceId: string
  webClientUrl: string | null
  offerExpiresAt: number | null
}

function toReadiness(offer: EncodedOffer): ServePairingReadiness {
  return {
    available: true,
    url: offer.pairingUrl,
    endpoint: offer.endpoint,
    deviceId: offer.deviceId,
    webClientUrl: offer.webClientUrl,
    scope: 'runtime',
    qr: null,
    expiresAt: offer.offerExpiresAt
  }
}

export function createOrcadPairingOffer(options: OrcadPairingOptions) {
  let currentDeviceId: string | null = null

  const mint = (rpc: OrcadPairingRpc): ServePairingReadiness => {
    const offer = rpc.createPairingOffer({
      address: options.pairingAddress,
      name: `CLI ${new Date().toLocaleDateString()}`,
      scope: 'runtime',
      // Why: this URL lands in a supervisor journal; an unclaimed one must not stay a live credential.
      offerLifetimeMs: options.offerLifetimeMs
    })
    if (!offer.available) {
      return offer
    }
    currentDeviceId = offer.deviceId
    return toReadiness(offer)
  }

  return {
    /** `rotate` invalidates the unclaimed offer first (for example, one that leaked). */
    current(rpc: OrcadPairingRpc, request: { rotate?: boolean } = {}): ServePairingReadiness {
      if (options.noPairing) {
        return {
          available: false,
          reason: 'disabled_by_operator',
          guidance: 'Restart without --no-pairing to create a client pairing offer.'
        }
      }
      if (currentDeviceId && request.rotate) {
        const reissued = rpc.reissueUnclaimedPairingOffer(currentDeviceId, options.pairingAddress)
        // Why refuse: minting a replacement while the leaked one still authenticates is not a rotation.
        if (reissued && !rpc.supersedeUnclaimedPairingOffer(currentDeviceId)) {
          return {
            available: false,
            reason: 'device_registry_unavailable',
            guidance: DEVICE_REGISTRY_UNAVAILABLE_GUIDANCE
          }
        }
        currentDeviceId = null
      } else if (currentDeviceId) {
        const reissued = rpc.reissueUnclaimedPairingOffer(currentDeviceId, options.pairingAddress)
        if (reissued) {
          return reissued.available ? toReadiness(reissued) : reissued
        }
      }
      return mint(rpc)
    }
  }
}

export type OrcadPairingOffer = ReturnType<typeof createOrcadPairingOffer>
