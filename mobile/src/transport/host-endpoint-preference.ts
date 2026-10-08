import { mutateStoredHosts } from './host-list-mutation-queue'
import { PairingEndpointRotation } from '../../../src/shared/pairing-endpoint-failover'

/**
 * Makes the address that just authenticated the host's preferred `endpoint`, keeping the others
 * as alternates in dial order, so the next open dials the last good address first (the same
 * last-good rule the desktop store applies). A no-op write when it already was preferred.
 */
export async function preferConnectedHostEndpoint(
  hostId: string,
  connectedEndpoint: string
): Promise<void> {
  try {
    await mutateStoredHosts((hosts) => {
      const index = hosts.findIndex((host) => host.id === hostId)
      const host = hosts[index]
      if (!host || host.endpoint === connectedEndpoint) {
        return hosts
      }
      if (!host.alternateEndpoints?.includes(connectedEndpoint)) {
        return hosts
      }
      const rotation = new PairingEndpointRotation([host.endpoint, ...host.alternateEndpoints])
      const next = hosts.slice()
      next[index] = {
        ...host,
        endpoint: connectedEndpoint,
        alternateEndpoints: rotation.alternatesAfter(connectedEndpoint)
      }
      return next
    })
  } catch {
    // Why: preference is an optimisation; unreadable storage must not disturb a live connection.
  }
}
