import { createHash } from 'node:crypto'
import type { z } from 'zod'
import type {
  DevicesRotateParams,
  PairingCreateParams
} from '../../../shared/rpc-contract/device-administration-params'
import type {
  AdministeredDevice,
  DevicesListResult,
  DevicesRevokeResult,
  DevicesRotateResult,
  PairingCreateResult
} from '../../../shared/runtime-device-administration'
import { DEFAULT_PAIRING_OFFER_LIFETIME_MS } from '../../../shared/pairing-offer-lifetime'
import { classifyRemotePairingHostname } from '../../../shared/remote-pairing-address'
import type { DeviceEntry } from '../device-registry'
import type { DeviceAdministrationRpcContext } from '../rpc/device-administration-context'
import {
  resolveAdvertisedPairingEndpoint,
  resolveAdvertisedPairingHostname
} from '../pairing-endpoint'
import { NETWORK_EXPOSURE_FAILED_GUIDANCE } from '../network-exposure-guidance'
import { RuntimeRpcMobilePairing } from './runtime-rpc-mobile-pairing'
import {
  DEVICE_REGISTRY_UNAVAILABLE_GUIDANCE,
  pairingUnavailable,
  WS_BIND_HOST_ALL_INTERFACES,
  type PairingOfferUnavailable
} from './runtime-rpc-pairing-types'

type PairingCreateRequest = z.infer<typeof PairingCreateParams>

const MOBILE_ADDRESS_REQUIRED_GUIDANCE =
  'A phone cannot dial this host by loopback. Pass --pairing-address with the LAN, Tailscale, or reverse-proxy address the phone reaches.'

export function fingerprintE2EEPublicKey(publicKeyB64: string | null): string | null {
  if (!publicKeyB64) {
    return null
  }
  const digest = createHash('sha256').update(Buffer.from(publicKeyB64, 'base64')).digest('hex')
  return `sha256:${digest.slice(0, 32)}`
}

export class RuntimeRpcDeviceAdministration extends RuntimeRpcMobilePairing {
  private readonly deviceAdministration: DeviceAdministrationRpcContext = {
    listDevices: () => this.listAdministeredDevices(),
    revokeDevice: (deviceId) => this.revokeAdministeredDevice(deviceId),
    rotateDevice: (params) => this.rotateAdministeredDevice(params),
    createPairingOffer: (params) => this.createAdministeredPairingOffer(params)
  }

  protected override getDeviceAdministrationContext(): DeviceAdministrationRpcContext {
    return this.deviceAdministration
  }

  listAdministeredDevices(): DevicesListResult {
    const registry = this.deviceRegistry
    if (!registry) {
      return { devices: [], serverKeyFingerprint: null }
    }
    try {
      registry.pruneExpiredOffers()
    } catch (error) {
      console.error('[runtime] Failed to prune expired pairing offers:', error)
    }
    return {
      devices: registry
        .listDevices()
        .toSorted((a, b) => a.pairedAt - b.pairedAt)
        .map((device) => this.toAdministeredDevice(device)),
      serverKeyFingerprint: fingerprintE2EEPublicKey(this.getE2EEPublicKey())
    }
  }

  async revokeAdministeredDevice(deviceId: string): Promise<DevicesRevokeResult> {
    const device = this.deviceRegistry?.getDevice(deviceId)
    if (!device) {
      return { revoked: false, deviceId, closedConnections: 0 }
    }
    const closedConnections = this.mobileSocketWiring?.countDeviceConnections(device.token) ?? 0
    const revoked =
      device.scope === 'mobile'
        ? await this.revokeMobileDevice(deviceId)
        : this.revokeRuntimeAccess(deviceId)
    return { revoked, deviceId, closedConnections: revoked ? closedConnections : 0 }
  }

  /** Runtime grants only: a phone's credential also keys its Relay and push identity. */
  rotateAdministeredDevice(params: z.infer<typeof DevicesRotateParams>): DevicesRotateResult {
    const device = this.deviceRegistry?.getDevice(params.deviceId)
    if (!device) {
      return pairingUnavailableResult('device_not_found', `No device with id ${params.deviceId}.`)
    }
    if (device.scope !== 'runtime') {
      return pairingUnavailableResult(
        'rotation_unsupported',
        'Mobile pairings cannot be rotated in place. Revoke the phone and pair it again with `orca serve pairing new --mobile`.'
      )
    }
    const target = this.resolveOfferTarget(params.address)
    if ('available' in target) {
      return target
    }
    let rotated: DeviceEntry | null
    try {
      rotated = this.deviceRegistry?.rotateDeviceToken(device.deviceId) ?? null
    } catch (error) {
      console.error('[runtime] Failed to persist a rotated device credential:', error)
      rotated = null
    }
    if (!rotated) {
      return pairingUnavailableResult(
        'device_registry_unavailable',
        DEVICE_REGISTRY_UNAVAILABLE_GUIDANCE
      )
    }
    const closedConnections = this.mobileSocketWiring?.terminateDeviceConnections(device.token) ?? 0
    this.securityEvents?.record({
      event: 'device.rotated',
      deviceId: device.deviceId,
      scope: device.scope,
      name: device.name,
      closedConnections
    })
    return {
      ...this.encodeDeviceOffer(rotated, target.endpoint, target.publicKeyB64),
      scope: rotated.scope,
      closedConnections,
      serverKeyFingerprint: fingerprintE2EEPublicKey(target.publicKeyB64)
    }
  }

  async createAdministeredPairingOffer(
    request: PairingCreateRequest
  ): Promise<PairingCreateResult> {
    const exposure = await this.prepareOfferExposure(request)
    if (exposure) {
      return exposure
    }
    const offer = this.createPairingOffer({
      address: request.address ?? null,
      name:
        request.name ??
        `${request.scope === 'mobile' ? 'Mobile' : 'CLI'} ${new Date().toLocaleDateString()}`,
      scope: request.scope,
      reach: this.advertisesLoopbackOnly(request.address) ? 'this-computer' : 'network',
      offerLifetimeMs: request.expiresInMs ?? DEFAULT_PAIRING_OFFER_LIFETIME_MS
    })
    if (!offer.available) {
      return offer
    }
    // Why: headless hosts have no Relay provider, so a phone must be told to stay on the direct path.
    if (request.scope === 'mobile' && !this.storeLocalOnlyConnectionMode(offer.deviceId)) {
      return pairingUnavailable('device_registry_unavailable', DEVICE_REGISTRY_UNAVAILABLE_GUIDANCE)
    }
    return {
      available: true,
      deviceId: offer.deviceId,
      scope: request.scope,
      pairingUrl: offer.pairingUrl,
      endpoint: offer.endpoint,
      webClientUrl: offer.webClientUrl,
      offerExpiresAt: offer.offerExpiresAt,
      serverKeyFingerprint: fingerprintE2EEPublicKey(this.getE2EEPublicKey())
    }
  }

  private toAdministeredDevice(device: DeviceEntry): AdministeredDevice {
    return {
      deviceId: device.deviceId,
      name: device.name,
      scope: device.scope,
      state: device.lastSeenAt > 0 ? 'paired' : 'pending',
      pairedAt: device.pairedAt,
      lastSeenAt: device.lastSeenAt > 0 ? device.lastSeenAt : null,
      offerExpiresAt: device.offerExpiresAt ?? null,
      connections: this.mobileSocketWiring?.countDeviceConnections(device.token) ?? 0
    }
  }

  private resolveOfferTarget(
    address: string | undefined
  ): { endpoint: string; publicKeyB64: string } | PairingOfferUnavailable {
    const rawEndpoint = this.getWebSocketEndpoint()
    const publicKeyB64 = this.getE2EEPublicKey()
    if (!rawEndpoint || !publicKeyB64) {
      return pairingUnavailable(
        'websocket_unavailable',
        'WebSocket pairing is unavailable. Inspect preceding runtime errors.'
      )
    }
    const advertised = resolveAdvertisedPairingEndpoint(rawEndpoint, address)
    return advertised.ok
      ? { endpoint: advertised.endpoint, publicKeyB64 }
      : pairingUnavailable(advertised.reason, advertised.guidance)
  }

  private advertisesLoopbackOnly(address: string | undefined): boolean {
    const hostname = resolveAdvertisedPairingHostname(address)
    return hostname === null || classifyRemotePairingHostname(hostname) === 'loopback'
  }

  // Why: mirrors the desktop QR/link flows — an off-host offer widens a loopback listener first, unless the
  // operator pinned the bind, in which case an explicit address vouches for a proxy or tunnel instead.
  private async prepareOfferExposure(
    request: PairingCreateRequest
  ): Promise<PairingOfferUnavailable | null> {
    if (request.scope === 'mobile' && this.advertisesLoopbackOnly(request.address)) {
      return pairingUnavailable('invalid_advertised_endpoint', MOBILE_ADDRESS_REQUIRED_GUIDANCE)
    }
    const pinnedNarrow =
      this.pinnedBindHost !== null && this.pinnedBindHost !== WS_BIND_HOST_ALL_INTERFACES
    if (pinnedNarrow || this.advertisesLoopbackOnly(request.address)) {
      return null
    }
    try {
      await this.ensureNetworkExposure()
      return null
    } catch (error) {
      console.error('[runtime] Network exposure failed while minting a pairing offer:', error)
      return pairingUnavailable('network_exposure_failed', NETWORK_EXPOSURE_FAILED_GUIDANCE)
    }
  }

  private storeLocalOnlyConnectionMode(deviceId: string): boolean {
    try {
      if (this.deviceRegistry?.setMobilePairingConnectionMode(deviceId, 'local-only')) {
        return true
      }
    } catch (error) {
      console.error('[runtime] Failed to persist the pairing connection mode:', error)
    }
    // Why: an offer whose policy never reached disk must not pair under the default one.
    this.discardPendingMobilePairingDevice(deviceId)
    return false
  }
}

function pairingUnavailableResult(reason: string, guidance: string): DevicesRotateResult {
  return { available: false, reason, guidance }
}
