import type { DeviceEntry } from './device-registry'
import type { RelayDeviceBinding } from './relay/relay-revoke-outbox'
import { parseMobilePushRegistration } from '../../shared/mobile-push-contract'

function validRelayBinding(value: unknown, deviceId: string): RelayDeviceBinding | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const binding = value as Partial<RelayDeviceBinding>
  return binding.relayDeviceId === deviceId &&
    typeof binding.relayHostId === 'string' &&
    typeof binding.ownerIdentityKey === 'string'
    ? {
        relayHostId: binding.relayHostId,
        relayDeviceId: binding.relayDeviceId,
        ownerIdentityKey: binding.ownerIdentityKey,
        ...(typeof binding.inviteExpiresAt === 'number' && Number.isFinite(binding.inviteExpiresAt)
          ? { inviteExpiresAt: binding.inviteExpiresAt }
          : {})
      }
    : undefined
}

// Why: an expiry only binds a never-used offer; once a device has authenticated it is a paired grant.
function validOfferExpiry(device: DeviceEntry): number | undefined {
  return device.lastSeenAt === 0 &&
    typeof device.offerExpiresAt === 'number' &&
    Number.isFinite(device.offerExpiresAt)
    ? device.offerExpiresAt
    : undefined
}

export function normalizeLoadedDeviceEntry(device: DeviceEntry): DeviceEntry {
  const { offerExpiresAt: _raw, ...rest } = device
  const offerExpiresAt = validOfferExpiry(device)
  return {
    ...rest,
    // Why: older registries only existed for phone pairing. Treat missing
    // scope as mobile so legacy device tokens do not gain new CLI powers.
    scope: device.scope === 'runtime' ? 'runtime' : 'mobile',
    relayBinding: validRelayBinding(device.relayBinding, device.deviceId),
    mobilePairingConnectionMode:
      device.mobilePairingConnectionMode === 'local-only' ? 'local-only' : 'automatic',
    // Why: registries written before this field existed only ever held network-reach grants (phones and
    // LAN links), so a missing value must keep binding every interface on reconnect.
    pairingReach: device.pairingReach === 'this-computer' ? 'this-computer' : 'network',
    // Why: a malformed row must degrade to "no background push", never fail the load
    // and strand every paired device.
    pushRegistration: parseMobilePushRegistration(device.pushRegistration),
    ...(offerExpiresAt !== undefined ? { offerExpiresAt } : {})
  }
}

export function isExpiredOffer(device: DeviceEntry, now: number): boolean {
  return (
    device.lastSeenAt === 0 && device.offerExpiresAt !== undefined && device.offerExpiresAt <= now
  )
}

/** A pending entry the coalescing "current QR / access link" flows own; minted offers are separate. */
export function isOpenEndedPendingDevice(device: DeviceEntry): boolean {
  return device.lastSeenAt === 0 && device.offerExpiresAt === undefined
}
