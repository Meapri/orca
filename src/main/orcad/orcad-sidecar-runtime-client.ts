import type { RuntimeMetadata } from '../../shared/runtime-bootstrap'
import { BROWSER_UNAVAILABLE_ERROR_CODE } from '../../shared/runtime-types'
import { BrowserError } from '../browser/browser-error'
import { sendLocalRuntimeRpcRequest, type LocalRuntimeRpcFailure } from './orcad-local-rpc-request'

const SIDECAR_MAX_RESPONSE_BYTES = 64 * 1024 * 1024

function toSidecarBrowserError(failure: LocalRuntimeRpcFailure): BrowserError {
  switch (failure.kind) {
    case 'rpc_error':
      return new BrowserError(failure.code, failure.message)
    case 'no_transport':
      return new BrowserError(
        BROWSER_UNAVAILABLE_ERROR_CODE,
        'Electron browser sidecar has no local RPC transport.'
      )
    case 'connect_failed':
      return new BrowserError(
        BROWSER_UNAVAILABLE_ERROR_CODE,
        'Could not connect to Electron browser sidecar.'
      )
    case 'closed':
      return new BrowserError(
        BROWSER_UNAVAILABLE_ERROR_CODE,
        'Electron browser sidecar closed before responding.'
      )
    case 'timeout':
      return new BrowserError('browser_timeout', 'Electron browser sidecar request timed out.')
    case 'too_large':
      return new BrowserError('browser_error', 'Electron browser sidecar response is too large.')
    case 'invalid_json':
      return new BrowserError('browser_error', 'Electron browser sidecar returned invalid JSON.')
    case 'invalid_response':
      return new BrowserError(
        'browser_error',
        'Electron browser sidecar returned an invalid response.'
      )
  }
}

export async function sendOrcadSidecarRequest(
  metadata: RuntimeMetadata,
  method: string,
  params: unknown,
  timeoutMs = 90_000
): Promise<unknown> {
  return await sendLocalRuntimeRpcRequest({
    metadata,
    method,
    params,
    timeoutMs,
    maxResponseBytes: SIDECAR_MAX_RESPONSE_BYTES,
    toError: toSidecarBrowserError
  })
}
