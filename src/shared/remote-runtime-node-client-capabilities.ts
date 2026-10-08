import type { RuntimeCapability } from './protocol-version'
import { remoteRuntimeClientCapabilities } from './remote-runtime-client-capabilities'
import { E2EE_TEXT_DEFLATE_CAPABILITY } from './e2ee-text-compression'

// Why separate from the shared list: mobile reuses that list but cannot inflate frames, while
// every Node transport that calls this decodes text through decryptE2EEText.
export function nodeRemoteRuntimeClientCapabilities(
  additionalCapabilities: readonly RuntimeCapability[] = []
): RuntimeCapability[] {
  return remoteRuntimeClientCapabilities([E2EE_TEXT_DEFLATE_CAPABILITY, ...additionalCapabilities])
}
