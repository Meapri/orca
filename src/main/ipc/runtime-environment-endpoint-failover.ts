import { REMOTE_RUNTIME_CONNECT_FAILURE_PHRASE } from '../../shared/remote-runtime-connect-bound'
import { preferNextEnvironmentEndpointAfterUnreachable } from '../../shared/runtime-environment-store'

/**
 * After a connect-phase failure, point the environment at its next paired endpoint (tailnet, LAN,
 * another configured address) so the next attempt dials it. Only an unanswered connect counts:
 * an RPC error from a host that did answer proves this endpoint works.
 */
export function failOverRuntimeEnvironmentEndpoint(
  userDataPath: string,
  environmentId: string,
  endpoint: string,
  errorMessage: string
): boolean {
  if (!errorMessage.includes(REMOTE_RUNTIME_CONNECT_FAILURE_PHRASE)) {
    return false
  }
  try {
    return preferNextEnvironmentEndpointAfterUnreachable(userDataPath, environmentId, endpoint)
  } catch {
    // Why: failover is an optimisation; an unreadable store must not mask the original error.
    return false
  }
}
