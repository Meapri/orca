import type { ConnectOptions } from './rpc-client'
import type { ConnectionLogSink, HostProfile } from './types'
import { preferConnectedHostEndpoint } from './host-endpoint-preference'

/** Direct-dial options for a paired host: its alternates rotate in, and the one that answers stays preferred. */
export function directConnectOptions(host: HostProfile, onLog: ConnectionLogSink): ConnectOptions {
  if (!host.alternateEndpoints?.length) {
    return { onLog }
  }
  return {
    onLog,
    alternateEndpoints: host.alternateEndpoints,
    onEndpointConnected: (endpoint) => {
      if (endpoint !== host.endpoint) {
        void preferConnectedHostEndpoint(host.id, endpoint)
      }
    }
  }
}
