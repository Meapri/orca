import type { MobileRelayPairingProvider } from '../runtime-rpc/runtime-rpc-pairing-types'
import type { DesktopRelayService } from './desktop-relay-service'

/** The runtime's hook into the relay service; the desktop app and orcad install the same one. */
export function relayPairingProvider(service: DesktopRelayService): MobileRelayPairingProvider {
  return {
    createPairingRelay: (relayDeviceId) => service.createPairingRelay(relayDeviceId),
    onDeviceRevokeQueued: (item) => service.onDeviceRevokeQueued(item),
    onDemandStateChanged: () => service.demandStateChanged(),
    getEndpoints: (context, params) => service.getEndpoints(context, params),
    provisionRelay: (context, params) => service.provisionRelay(context, params)
  }
}
