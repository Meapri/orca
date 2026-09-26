// Why: result contract of the host-only `devices.*` / `pairing.create` RPCs. Rows never carry a
// bearer token; the only credential that ever leaves the host is the pairing URL a mint returns.
import type { DeviceScope } from './runtime-types'

export type AdministeredDeviceState = 'pending' | 'paired'

export type AdministeredDevice = {
  deviceId: string
  name: string
  scope: DeviceScope
  state: AdministeredDeviceState
  pairedAt: number
  lastSeenAt: number | null
  /** Only pending offers minted with a lifetime carry one; null means the offer never expires. */
  offerExpiresAt: number | null
  /** Authenticated sockets open right now for this credential. */
  connections: number
}

export type DevicesListResult = {
  devices: AdministeredDevice[]
  /** sha256 of the host's E2EE public key, so an operator can compare it with a client's pin. */
  serverKeyFingerprint: string | null
}

export type DevicesRevokeResult = {
  revoked: boolean
  deviceId: string
  closedConnections: number
}

export type AdministeredPairingOffer = {
  deviceId: string
  scope: DeviceScope
  pairingUrl: string
  endpoint: string
  webClientUrl: string | null
  offerExpiresAt: number | null
  serverKeyFingerprint: string | null
}

export type AdministeredPairingOfferUnavailable = {
  available: false
  reason: string
  guidance: string
}

export type PairingCreateResult =
  | ({ available: true } & AdministeredPairingOffer)
  | AdministeredPairingOfferUnavailable

export type DevicesRotateResult =
  | ({ available: true; closedConnections: number } & AdministeredPairingOffer)
  | AdministeredPairingOfferUnavailable
