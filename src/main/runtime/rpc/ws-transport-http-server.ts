// The plain-HTTP half of the WebSocket listener: static web client and supervisor probe paths.
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type RequestListener,
  type Server as HttpServer,
  type ServerResponse
} from 'node:http'
import { createStaticWebClientHandler } from './static-web-client-handler'

/** Answers plain HTTP probe paths on the listener; returns false to pass the request on. */
export type WebSocketProbeRequestHandler = (
  request: IncomingMessage,
  response: ServerResponse
) => boolean

export function createWebSocketHttpServer(options: {
  tlsCert: string | undefined
  tlsKey: string | undefined
  staticRoot: string | undefined
  probeRequestHandler: WebSocketProbeRequestHandler | undefined
}): HttpServer | HttpsServer {
  const requestListener = composeRequestListener(
    options.probeRequestHandler,
    options.staticRoot ? createStaticWebClientHandler(options.staticRoot) : undefined
  )
  return options.tlsCert && options.tlsKey
    ? createHttpsServer({ cert: options.tlsCert, key: options.tlsKey }, requestListener)
    : createHttpServer(requestListener)
}

// Why: with a probe handler installed, unmatched non-upgrade requests get a 404 instead of hanging open.
export function composeRequestListener(
  probe: WebSocketProbeRequestHandler | undefined,
  staticHandler: RequestListener | undefined
): RequestListener | undefined {
  if (!probe) {
    return staticHandler
  }
  return (request, response) => {
    if (probe(request, response)) {
      return
    }
    if (staticHandler) {
      staticHandler(request, response)
      return
    }
    response.statusCode = 404
    response.end()
  }
}
