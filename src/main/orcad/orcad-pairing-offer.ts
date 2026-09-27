/**
 * The startup pairing offers orcad prints in its readiness line, and the ones `orca serve pairing`
 * reprints: always a runtime offer, plus a mobile one with `--mobile-pairing`. Each is a standalone
 * expiring offer (see DEFAULT_PAIRING_OFFER_LIFETIME_MS), so a reprint re-serves that same
 * credential until a client claims it or it expires, then mints the next one with the same
 * lifetime. `orca serve pairing new` mints extra offers and never touches these.
 */
import type { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import type { ServePairingReadiness } from '../server/serve-readiness'
import { DEVICE_REGISTRY_UNAVAILABLE_GUIDANCE } from '../runtime/runtime-rpc/runtime-rpc-pairing-types'
import { createAlternateWebClientUrls } from '../runtime/runtime-rpc/web-client-alternate-urls'
import { renderTerminalPairingQr } from '../../shared/terminal-pairing-qr'

export type OrcadPairingScope = 'runtime' | 'mobile'

export type OrcadPairingOptions = {
  scope: OrcadPairingScope
  noPairing: boolean
  pairingAddress: string | undefined
  /** The listener's other reachable endpoints (repeated --pairing-address, interfaces). */
  alternateEndpoints: readonly string[] | undefined
  offerLifetimeMs: number
}

export type OrcadPairingRpc = Pick<
  OrcaRuntimeRpcServer,
  | 'createPairingOffer'
  | 'createAdministeredPairingOffer'
  | 'reissueUnclaimedPairingOffer'
  | 'supersedeUnclaimedPairingOffer'
>

type EncodedOffer = {
  available: true
  pairingUrl: string
  endpoint: string
  deviceId: string
  webClientUrl: string | null
  offerExpiresAt: number | null
}

type Unavailable = Extract<ServePairingReadiness, { available: false }>

export function createOrcadPairingOffer(options: OrcadPairingOptions) {
  let currentDeviceId: string | null = null

  const toReadiness = async (offer: EncodedOffer): Promise<ServePairingReadiness> => {
    // Why per endpoint: the browser client dials only the offer's primary endpoint.
    const webClientAlternateUrls =
      offer.webClientUrl && options.alternateEndpoints?.length
        ? createAlternateWebClientUrls(offer.pairingUrl, options.alternateEndpoints)
        : []
    return {
      available: true,
      url: offer.pairingUrl,
      endpoint: offer.endpoint,
      deviceId: offer.deviceId,
      webClientUrl: offer.webClientUrl,
      ...(webClientAlternateUrls.length > 0 ? { webClientAlternateUrls } : {}),
      scope: options.scope,
      // Why mobile only: a phone scans it; runtime offers are pasted into a desktop or browser.
      qr: options.scope === 'mobile' ? await renderTerminalPairingQr(offer.pairingUrl) : null,
      expiresAt: offer.offerExpiresAt
    }
  }

  const mint = async (rpc: OrcadPairingRpc): Promise<EncodedOffer | Unavailable> => {
    if (options.scope === 'mobile') {
      // Why the administered path: it refuses a loopback address and pins the phone to the
      // direct path, since a headless host has no Relay provider.
      return rpc.createAdministeredPairingOffer({
        scope: 'mobile',
        address: options.pairingAddress,
        name: `Mobile ${new Date().toLocaleDateString()}`,
        expiresInMs: options.offerLifetimeMs
      })
    }
    return rpc.createPairingOffer({
      address: options.pairingAddress,
      name: `CLI ${new Date().toLocaleDateString()}`,
      scope: 'runtime',
      alternateEndpoints: options.alternateEndpoints,
      // Why: this URL lands in a supervisor journal; an unclaimed one must not stay a live credential.
      offerLifetimeMs: options.offerLifetimeMs
    })
  }

  return {
    /** `rotate` invalidates the unclaimed offer first (for example, one that leaked). */
    async current(
      rpc: OrcadPairingRpc,
      request: { rotate?: boolean } = {}
    ): Promise<ServePairingReadiness> {
      if (options.noPairing) {
        return {
          available: false,
          reason: 'disabled_by_operator',
          guidance: 'Restart without --no-pairing to create a client pairing offer.'
        }
      }
      if (currentDeviceId) {
        const reissued = rpc.reissueUnclaimedPairingOffer(
          currentDeviceId,
          options.pairingAddress,
          options.alternateEndpoints
        )
        if (request.rotate) {
          // Why refuse: minting a replacement while the leaked one still authenticates is not a rotation.
          if (reissued && !rpc.supersedeUnclaimedPairingOffer(currentDeviceId)) {
            return {
              available: false,
              reason: 'device_registry_unavailable',
              guidance: DEVICE_REGISTRY_UNAVAILABLE_GUIDANCE
            }
          }
          currentDeviceId = null
        } else if (reissued) {
          return reissued.available ? toReadiness(reissued) : reissued
        }
      }
      const offer = await mint(rpc)
      if (!offer.available) {
        return offer
      }
      currentDeviceId = offer.deviceId
      return toReadiness(offer)
    }
  }
}

export type OrcadPairingOffer = ReturnType<typeof createOrcadPairingOffer>
