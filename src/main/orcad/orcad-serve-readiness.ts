import type { ServeReadiness } from '../server/serve-readiness'
import type { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import type { OrcadHealth } from './orcad-health'

/** The readiness payload orcad publishes once its RPC transport is listening. */
export async function buildOrcadServeReadiness(input: {
  runtimeId: string
  rpc: Pick<OrcaRuntimeRpcServer, 'getWebSocketEndpoint'>
  /** From `startOrcadPairing`: advertised endpoint and the offer the readiness line carries. */
  pairing: {
    advertisedEndpoint: string | null
    readinessPairing(): Promise<ServeReadiness['pairing']>
  }
  collectHealth: () => Promise<OrcadHealth>
}): Promise<ServeReadiness> {
  return {
    runtimeId: input.runtimeId,
    boundEndpoint: input.rpc.getWebSocketEndpoint(),
    advertisedEndpoint: input.pairing.advertisedEndpoint,
    // Why 'settled': the WSL CLI reconciliation barrier is a desktop-launch concern.
    // orcad never runs it, so there is no pending repair a client could race.
    managedWslCliReconciliation: 'settled',
    pairing: await input.pairing.readinessPairing(),
    // Why in the readiness payload: this is the one message a supervisor and a deploy
    // transaction both read, and a green orcad with a dead daemon is exactly the
    // looks-healthy-but-useless state they must not activate.
    health: await input.collectHealth()
  }
}
