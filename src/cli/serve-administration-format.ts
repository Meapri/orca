import type {
  AdministeredDevice,
  AdministeredPairingOffer,
  DevicesListResult,
  DevicesRevokeResult
} from '../shared/runtime-device-administration'

function isoOrDash(value: number | null): string {
  return value === null ? '-' : new Date(value).toISOString()
}

function formatDeviceRow(device: AdministeredDevice): string {
  const lifecycle =
    device.state === 'pending'
      ? `pending, expires ${device.offerExpiresAt === null ? 'never' : isoOrDash(device.offerExpiresAt)}`
      : `paired, last seen ${isoOrDash(device.lastSeenAt)}`
  return `${device.deviceId}  ${device.scope.padEnd(7)}  ${lifecycle}  connections ${device.connections}  "${device.name}"`
}

export function formatDevicesList(result: DevicesListResult): string {
  const lines = [`Server key: ${result.serverKeyFingerprint ?? 'unavailable'}`]
  if (result.devices.length === 0) {
    lines.push('No paired devices or pending pairing offers.')
    return lines.join('\n')
  }
  lines.push(...result.devices.map(formatDeviceRow))
  return lines.join('\n')
}

export function formatDevicesRevoke(result: DevicesRevokeResult): string {
  return result.revoked
    ? `Revoked ${result.deviceId}; closed ${result.closedConnections} live connection(s).`
    : `No device ${result.deviceId} to revoke.`
}

export function formatPairingOffer(offer: AdministeredPairingOffer, qr: string | null): string {
  const lines: string[] = []
  if (qr) {
    lines.push(`Mobile pairing QR:\n${qr}`)
  }
  lines.push(`Pairing URL: ${offer.pairingUrl}`)
  if (offer.webClientUrl) {
    lines.push(`Web client URL: ${offer.webClientUrl}`)
  }
  lines.push(`Scope: ${offer.scope}`)
  lines.push(`Endpoint: ${offer.endpoint}`)
  if (offer.viaRelay) {
    lines.push(
      'Reach: Orca Relay — the phone falls back to the relay when it cannot dial the endpoint.'
    )
  }
  lines.push(`Device ID: ${offer.deviceId}`)
  if (offer.offerExpiresAt !== null) {
    lines.push(
      `Expires: ${isoOrDash(offer.offerExpiresAt)} unless a client connects with it first; the first client to connect becomes this device.`
    )
  }
  lines.push(`Server key: ${offer.serverKeyFingerprint ?? 'unavailable'}`)
  lines.push('Treat the pairing URL as a password: anyone holding it can connect as this device.')
  return lines.join('\n')
}
