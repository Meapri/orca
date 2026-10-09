/** Pure per-device edits the registry persists; each returns the next list, or null when nothing applies. */
import type { DeviceEntry } from './device-registry'
import type { RelayDeviceBinding } from './relay/relay-revoke-outbox'
import type { MobilePushRegistration } from '../../shared/mobile-push-contract'
import type { MobilePairingConnectionMode } from '../../shared/mobile-pairing-connection-mode'

function updateDevice(
  devices: readonly DeviceEntry[],
  deviceId: string,
  applies: (device: DeviceEntry) => boolean,
  update: (device: DeviceEntry) => DeviceEntry
): DeviceEntry[] | null {
  const target = devices.find((device) => device.deviceId === deviceId)
  if (!target || !applies(target)) {
    return null
  }
  return devices.map((device) => (device === target ? update(device) : device))
}

export function withRelayBinding(
  devices: readonly DeviceEntry[],
  deviceId: string,
  binding: RelayDeviceBinding
): DeviceEntry[] | null {
  return updateDevice(
    devices,
    deviceId,
    () => binding.relayDeviceId === deviceId,
    (device) => ({ ...device, relayBinding: binding })
  )
}

export function withPushRegistration(
  devices: readonly DeviceEntry[],
  deviceId: string,
  registration: MobilePushRegistration | null
): DeviceEntry[] | null {
  return updateDevice(
    devices,
    deviceId,
    (device) => device.scope === 'mobile',
    (device) => {
      const { pushRegistration: _dropped, ...rest } = device
      return registration ? { ...rest, pushRegistration: registration } : rest
    }
  )
}

export function withMobilePairingConnectionMode(
  devices: readonly DeviceEntry[],
  deviceId: string,
  mode: MobilePairingConnectionMode
): DeviceEntry[] | null {
  return updateDevice(
    devices,
    deviceId,
    (device) => device.scope === 'mobile',
    (device) => ({ ...device, mobilePairingConnectionMode: mode })
  )
}

export function mobilePairingConnectionModeOf(
  device: DeviceEntry | null
): MobilePairingConnectionMode | null {
  if (!device || device.scope !== 'mobile') {
    return null
  }
  // Why: pairings created before this preference existed used automatic
  // direct-first Relay fallback, so missing state must preserve that behavior.
  return device.mobilePairingConnectionMode === 'local-only' ? 'local-only' : 'automatic'
}
