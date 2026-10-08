/**
 * `/healthz` (liveness) and `/readyz` (readiness) on orcad's existing listener.
 *
 * Unauthenticated by design — a supervisor probe holds no pairing credential — so the bodies
 * carry verdict words and degradation codes only: no pids, paths, versions or messages. The
 * listener stays loopback-bound unless the operator widened `--bind`.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebSocketProbeRequestHandler } from '../runtime/rpc/ws-transport-http-server'
import type { OrcadDegradation } from './orcad-degradations'
import type { OrcadReadinessState } from './orcad-health-monitor'

export const ORCAD_LIVENESS_PATH = '/healthz'
export const ORCAD_READINESS_PATH = '/readyz'

export type OrcadHealthProbeSource = {
  liveness(): { live: boolean }
  readiness(): { state: OrcadReadinessState; degradations: OrcadDegradation[] }
}

function requestPath(request: IncomingMessage): string | null {
  try {
    return new URL(request.url ?? '/', 'http://probe.invalid').pathname
  } catch {
    return null
  }
}

function writeJson(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  body: unknown
): void {
  const payload = JSON.stringify(body)
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('Content-Length', Buffer.byteLength(payload))
  response.end(request.method === 'HEAD' ? undefined : payload)
}

export function createOrcadHealthProbeHandler(
  source: OrcadHealthProbeSource
): WebSocketProbeRequestHandler {
  return (request, response) => {
    const path = requestPath(request)
    if (path !== ORCAD_LIVENESS_PATH && path !== ORCAD_READINESS_PATH) {
      return false
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('Allow', 'GET, HEAD')
      writeJson(request, response, 405, { status: 'method_not_allowed' })
      return true
    }
    if (path === ORCAD_LIVENESS_PATH) {
      const { live } = source.liveness()
      writeJson(request, response, live ? 200 : 503, { status: live ? 'ok' : 'wedged' })
      return true
    }
    const { state, degradations } = source.readiness()
    writeJson(request, response, state === 'ready' ? 200 : 503, {
      status: state,
      degradations: degradations.map(({ code, severity }) => ({ code, severity }))
    })
    return true
  }
}
