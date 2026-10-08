import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../../shared/electron-remote-runtime-client-capabilities'
import { nodeRemoteRuntimeClientCapabilities } from '../../../shared/remote-runtime-node-client-capabilities'
import { isWebClientLocation } from '@/lib/web-client-location'
import { WEB_RUNTIME_CLIENT_CAPABILITIES } from '@/web/web-runtime-client-capabilities'

/** What this client tells a paired host it can do, exactly as its handshake sends it: the desktop's
 *  Node transports add the shared remote base and text deflate to the Electron list; the browser
 *  client sends its own. */
export function pairedHostClientCapabilities(): readonly string[] {
  return isWebClientLocation()
    ? WEB_RUNTIME_CLIENT_CAPABILITIES
    : nodeRemoteRuntimeClientCapabilities(ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES)
}
