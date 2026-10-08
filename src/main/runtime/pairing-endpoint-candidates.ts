import { PAIRING_ALTERNATE_ENDPOINTS_MAX } from '../../shared/mobile-pairing-protocol-limits'
import { isPairingWildcardHostname } from '../../shared/network/pairing-url'
import { isVirtualBridgeInterface } from '../../shared/pairing-address-auto-selection'
import { isTailnetIPv4Address } from '../../shared/tailnet-address'
import type { NetworkInterface } from './pairing-network-interfaces'
import {
  resolveAdvertisedPairingEndpoint,
  type PairingEndpointResolution
} from './pairing-endpoint'

const TAILNET_IPV6_PREFIX = 'fd7a:115c:a1e0:'

function isTailnetAddress(address: string): boolean {
  return isTailnetIPv4Address(address) || address.toLowerCase().startsWith(TAILNET_IPV6_PREFIX)
}

function isLoopbackBind(bindHost: string): boolean {
  return bindHost === '::1' || bindHost.startsWith('127.')
}

// Why: tailnet first, since it keeps working when the client leaves the LAN; then IPv4 before
// IPv6; virtual bridges (Docker, WSL, Hyper-V) last, since a remote client can rarely reach them.
function interfaceRank(entry: NetworkInterface): number {
  if (isTailnetAddress(entry.address)) {
    return 0
  }
  const bridgePenalty = isVirtualBridgeInterface(entry.name, entry.hasDefaultRoute) ? 2 : 0
  return (entry.address.includes(':') ? 2 : 1) + bridgePenalty
}

/**
 * The primary endpoint is exactly what a single-endpoint offer advertised before, so older clients
 * see no change. Alternates are every other place the same listener is reachable: further
 * configured addresses, then interface addresses when the listener is bound to all interfaces.
 */
export function collectPairingEndpointCandidates(args: {
  boundEndpoint: string
  bindHost: string
  configuredAddresses: readonly string[]
  interfaces: readonly NetworkInterface[]
}): { primary: PairingEndpointResolution; alternates: string[] } {
  const primary = resolveAdvertisedPairingEndpoint(args.boundEndpoint, args.configuredAddresses[0])
  const seen = new Set<string>(primary.ok ? [primary.endpoint] : [])
  const alternates: string[] = []
  const add = (address: string): void => {
    const resolved = resolveAdvertisedPairingEndpoint(args.boundEndpoint, address)
    if (!resolved.ok || seen.has(resolved.endpoint)) {
      return
    }
    seen.add(resolved.endpoint)
    alternates.push(resolved.endpoint)
  }
  for (const address of args.configuredAddresses.slice(1)) {
    add(address)
  }
  if (isPairingWildcardHostname(args.bindHost)) {
    const ranked = [...args.interfaces].sort((a, b) => interfaceRank(a) - interfaceRank(b))
    for (const entry of ranked) {
      add(entry.address)
    }
  } else if (!isLoopbackBind(args.bindHost)) {
    add(args.bindHost)
  }
  return { primary, alternates: alternates.slice(0, PAIRING_ALTERNATE_ENDPOINTS_MAX) }
}
