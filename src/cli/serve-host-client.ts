// The one local client every `orca serve status | doctor | pairing | devices | relay` command dials.
import { RuntimeClient, RuntimeClientError, type RuntimeRpcSuccess } from './runtime-client'
import { resolveServeDataRoot } from './serve-data-root'

export const SERVE_HOST_TIMEOUT_MS = 15_000

// Why explicit-null selectors: an ambient ORCA_PAIRING_CODE / ORCA_ENVIRONMENT must never
// redirect a host-only read or a credential mutation to some other paired server.
export function createServeHostClient(dataRoot: string, timeoutMs = SERVE_HOST_TIMEOUT_MS) {
  return new RuntimeClient(dataRoot, timeoutMs, null, null)
}

/**
 * Why named errors: a runtime that predates a method answers method_not_found, which is not
 * "down", and a missing server is not fixed by `orca open` (the generic runtime_unavailable hint).
 */
export function explainServeHostFailure(dataRoot: string | null, unsupported: RuntimeClientError) {
  return (error: unknown): never => {
    if (error instanceof RuntimeClientError && error.code === 'method_not_found') {
      throw unsupported
    }
    if (dataRoot && error instanceof RuntimeClientError && error.code === 'runtime_unavailable') {
      throw new RuntimeClientError(
        'server_not_running',
        `No Orca runtime answered on data root ${dataRoot}. Start orcad (or check \`orca serve doctor\`), or pass --data-root.`
      )
    }
    throw error
  }
}

export async function callServeHost<TResult>(
  flags: ReadonlyMap<string, string | boolean>,
  method: string,
  params: unknown,
  unsupported: RuntimeClientError
): Promise<RuntimeRpcSuccess<TResult>> {
  const dataRoot = resolveServeDataRoot(flags)
  return await createServeHostClient(dataRoot)
    .call<TResult>(method, params)
    .catch(explainServeHostFailure(dataRoot, unsupported))
}
